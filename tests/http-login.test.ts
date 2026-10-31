import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { httpLoginCookies, parseLoginForm } from '../src/modules/blackboard/http-login.js';
import { LoginError, type CapturedSession } from '../src/modules/blackboard/session-login.js';
import { loginModeFromEnv, loginStored, type LoginDeps } from '../src/modules/blackboard/stored-login.js';

const LOGIN_PAGE = (extra = '') => `<html><body>
<form method="POST" action="/webapps/portal/execute/changeLocale"><input type="hidden" name="locale" value="es_ES"></form>
<form method="POST" action="/webapps/login/">
  <input type="hidden" name="target" value="">
  <input type="text" name="user_id" value="">
  <input type="password" name="password">
  <input type="submit" name="login" value="Iniciar sesión">
  <input type="text" name="secondaryAuthToken" value="">
  <input type="hidden" name="showMFAVerification" value="${extra === 'mfa' ? 'true' : 'false'}">
  <input type="hidden" name="action" value="login">
  <input type="hidden" name="new_loc" value="">
  <input type="hidden" name="blackboard.platform.security.NonceUtil.nonce.ajax" value="nonce-&amp;-secreto">
</form></body></html>`;

describe('login a Blackboard por HTTP, sin navegador (servidor falso)', () => {
  let server: Server; let base = '';
  let mode: 'ok' | 'wrong' | 'mfa' | 'nologin' | 'offsite' = 'ok';
  const seen: { posted?: URLSearchParams; cookieOnPost?: string } = {};

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', base);
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('set-cookie', ['JSESSIONID=abc123; Path=/; HttpOnly', 'BbRouter=router1; Path=/', 'AWSALB=lb1; Path=/']);
      return res.writeHead(200, { 'content-type': 'text/html' }).end(mode === 'nologin' ? '<html>mantenimiento</html>' : LOGIN_PAGE());
    }
    if (req.method === 'POST' && url.pathname === '/webapps/login/') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.posted = new URLSearchParams(body); seen.cookieOnPost = req.headers.cookie;
        if (mode === 'offsite') return res.writeHead(302, { location: 'https://otro-dominio.example/robar' }).end();
        if (mode === 'wrong') return res.writeHead(200, { 'content-type': 'text/html' }).end(LOGIN_PAGE());
        if (mode === 'mfa') return res.writeHead(200, { 'content-type': 'text/html' }).end(LOGIN_PAGE('mfa'));
        res.setHeader('set-cookie', ['BbRouter=router2; Path=/']);
        res.writeHead(302, { location: '/ultra' }).end();
      });
      return undefined;
    }
    if (url.pathname === '/ultra') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>ultra</html>');
    return res.writeHead(404).end();
  };

  before(async () => {
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const login = (password = 'clave-secreta') => httpLoginCookies(base, { username: '2944812025', password });
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: LoginError) => error instanceof LoginError && error.code === code);

  test('el formulario se lee con sus campos ocultos y la contraseña va solo en el envío', async () => {
    const fields = parseLoginForm(LOGIN_PAGE())!;
    assert.deepEqual([...fields.keys()], ['target', 'user_id', 'password', 'login', 'secondaryAuthToken', 'showMFAVerification', 'action', 'new_loc', 'blackboard.platform.security.NonceUtil.nonce.ajax']);
    assert.equal(fields.get('blackboard.platform.security.NonceUtil.nonce.ajax'), 'nonce-&-secreto', 'las entidades HTML se decodifican');
    assert.equal(parseLoginForm('<html>sin formulario</html>'), null);
  });

  test('con las credenciales correctas devuelve las cookies de sesión, con el nonce y las cookies previas en el envío', async () => {
    mode = 'ok';
    const cookies = await login();
    assert.equal(seen.posted!.get('user_id'), '2944812025'); assert.equal(seen.posted!.get('password'), 'clave-secreta');
    assert.equal(seen.posted!.get('blackboard.platform.security.NonceUtil.nonce.ajax'), 'nonce-&-secreto');
    assert.match(seen.cookieOnPost ?? '', /JSESSIONID=abc123/);
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    assert.equal(byName.BbRouter, 'router2', 'queda la cookie más reciente');
    assert.ok(cookies.every((c) => c.host === '127.0.0.1' && c.path === '/'));
  });

  test('contraseña incorrecta: invalid_credentials, sin reintentos', async () => {
    mode = 'wrong';
    await rejects(login('mala'), 'invalid_credentials');
  });

  test('si UTEC pide el segundo factor: mfa_required', async () => {
    mode = 'mfa';
    await rejects(login(), 'mfa_required');
  });

  test('si la página de login cambió o no hay formulario: login_unexpected (para que el respaldo con navegador lo intente)', async () => {
    mode = 'nologin';
    await rejects(login(), 'login_unexpected');
  });

  test('nunca sigue una redirección a otro dominio', async () => {
    mode = 'offsite';
    await rejects(login(), 'login_unexpected');
  });

  test('si Blackboard no responde: login_unexpected', async () => {
    await rejects(httpLoginCookies('http://127.0.0.1:1', { username: 'x', password: 'y' }), 'login_unexpected');
  });
});

describe('modo de inicio de sesión desatendido (BLACKBOARD_LOGIN_MODE)', () => {
  const fakeSession = { tag: 'sesion' } as unknown as CapturedSession;
  const creds = { username: 'u', password: 'p' };
  const make = (http: 'ok' | LoginError, browser: 'ok' | Error = 'ok') => {
    const calls: string[] = [];
    const deps: LoginDeps = {
      async http() { calls.push('http'); if (http !== 'ok') throw http; return fakeSession; },
      async browser() { calls.push('browser'); if (browser !== 'ok') throw browser; return fakeSession; },
    };
    return { calls, deps };
  };

  test('por defecto es el navegador, como siempre', () => {
    assert.equal(loginModeFromEnv(undefined), 'browser');
    assert.equal(loginModeFromEnv('cualquier-cosa'), 'browser');
    assert.equal(loginModeFromEnv('auto'), 'auto'); assert.equal(loginModeFromEnv('http'), 'http');
  });

  test('browser: solo Chromium, nunca HTTP', async () => {
    const { calls, deps } = make('ok');
    await loginStored('https://x', creds, {}, 'browser', deps);
    assert.deepEqual(calls, ['browser']);
  });

  test('http: solo HTTP, sin respaldo con navegador aunque falle', async () => {
    const { calls, deps } = make(new LoginError('login_unexpected', 'cambió'));
    await assert.rejects(() => loginStored('https://x', creds, {}, 'http', deps), (e: LoginError) => e.code === 'login_unexpected');
    assert.deepEqual(calls, ['http']);
  });

  test('auto: HTTP primero; si la página cambió, Chromium; con contraseña mala o MFA NO se reintenta con el navegador', async () => {
    const ok = make('ok'); await loginStored('https://x', creds, {}, 'auto', ok.deps); assert.deepEqual(ok.calls, ['http']);
    const changed = make(new LoginError('login_unexpected', 'cambió')); await loginStored('https://x', creds, {}, 'auto', changed.deps); assert.deepEqual(changed.calls, ['http', 'browser']);
    for (const code of ['invalid_credentials', 'mfa_required'] as const) {
      const bad = make(new LoginError(code, 'no')); await assert.rejects(() => loginStored('https://x', creds, {}, 'auto', bad.deps), (e: LoginError) => e.code === code);
      assert.deepEqual(bad.calls, ['http'], 'sin segundo intento');
    }
  });
});
