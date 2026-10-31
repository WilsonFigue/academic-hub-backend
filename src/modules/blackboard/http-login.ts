// Inicio de sesión en Blackboard UTEC SIN navegador: reproduce con peticiones HTTP lo que hace el formulario de login.
//   1. GET /                  → página con el formulario (cookies de balanceo y sesión, y un código anti-falsificación oculto)
//   2. POST /webapps/login/   → user_id, password y los campos ocultos del formulario; responde 302 a /ultra
//   3. GET /ultra             → ya hay sesión
// Solo habla con el host de Blackboard (nunca sigue una redirección a otro dominio) y las cookies solo viven en memoria.
// Si aparece el segundo factor o la contraseña es incorrecta, falla sin reintentar (varios intentos fallidos pueden bloquear la cuenta).
import { LoginError } from './session-login.js';

export interface HttpLoginCookie { host: string; name: string; value: string; path: string; secure: boolean; httpOnly: boolean; expires: number }

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_HOPS = 6;
const TIMEOUT_MS = 30_000;

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2).find((value) => value !== undefined);
const decode = (value: string) => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Campos del formulario de login (ocultos incluidos). null si la página no trae el formulario esperado. */
export function parseLoginForm(html: string): URLSearchParams | null {
  const form = /<form\b[^>]*\baction\s*=\s*["']\/webapps\/login\/["'][\s\S]*?<\/form>/i.exec(html)?.[0];
  if (!form) return null;
  const fields = new URLSearchParams();
  for (const tag of form.match(/<input\b[^>]*>/gi) ?? []) {
    const name = attr(tag, 'name');
    if (!name) continue;
    const type = (attr(tag, 'type') ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio' || type === 'file') continue;
    fields.set(name, decode(attr(tag, 'value') ?? ''));
  }
  return fields.has('user_id') && fields.has('password') ? fields : null;
}

/**
 * Inicia sesión y devuelve las cookies del host de Blackboard. Errores:
 *  - invalid_credentials: Blackboard devolvió otra vez el formulario sin pedir segundo factor.
 *  - mfa_required: Blackboard pidió un código de verificación.
 *  - login_unexpected: la página no es la esperada (cambió el login, red caída, redirección a otro dominio).
 */
export async function httpLoginCookies(baseUrl: string, credentials: { username: string; password: string }, fetchFn: typeof fetch = fetch): Promise<HttpLoginCookie[]> {
  const base = new URL(baseUrl);
  const jar = new Map<string, string>();
  const store = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const at = pair.indexOf('=');
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1));
    }
  };
  const request = async (method: 'GET' | 'POST', target: string, body?: URLSearchParams): Promise<Response> => {
    const url = new URL(target, base);
    if (url.hostname !== base.hostname) throw new LoginError('login_unexpected', 'Blackboard redirigió a otro dominio; se detuvo el inicio de sesión.');
    let response: Response;
    try {
      response = await fetchFn(url, {
        method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'es-SV,es;q=0.9',
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded', origin: base.origin, referer: `${base.origin}/` } : {}),
        },
        ...(body ? { body: body.toString() } : {}),
      });
    } catch {
      throw new LoginError('login_unexpected', 'No fue posible comunicarse con Blackboard.');
    }
    store(response);
    return response;
  };

  const home = await request('GET', '/');
  const fields = parseLoginForm(await home.text());
  if (!fields) throw new LoginError('login_unexpected', 'No encontré el formulario de inicio de sesión de Blackboard.');
  fields.set('user_id', credentials.username);
  fields.set('password', credentials.password);

  let response = await request('POST', '/webapps/login/', fields);
  let hops = 0;
  let landed = '';
  while (response.status >= 300 && response.status < 400 && hops < MAX_HOPS) {
    landed = new URL(response.headers.get('location') ?? '/', base).pathname;
    response = await request('GET', response.headers.get('location') ?? '/');
    hops += 1;
  }

  if (!landed.startsWith('/ultra')) {
    // Seguimos en una página de login: segundo factor o contraseña incorrecta.
    const page = await response.text().catch(() => '');
    const again = parseLoginForm(page);
    if (!again && !/login/i.test(landed)) throw new LoginError('login_unexpected', 'Blackboard respondió algo inesperado al iniciar sesión.');
    const mfa = /name\s*=\s*["']showMFAVerification["'][^>]*value\s*=\s*["']true["']/i.test(page) || /value\s*=\s*["']true["'][^>]*name\s*=\s*["']showMFAVerification["']/i.test(page);
    if (mfa) throw new LoginError('mfa_required', 'UTEC pidió un código de verificación; la actualización automática no lo esquiva.');
    throw new LoginError('invalid_credentials', 'UTEC rechazó el usuario o la contraseña guardados.');
  }
  if (!jar.has('BbRouter') && !jar.has('JSESSIONID')) throw new LoginError('login_unexpected', 'Blackboard no entregó una sesión.');

  return [...jar].map(([name, value]) => ({ host: base.hostname, name, value, path: '/', secure: base.protocol === 'https:', httpOnly: true, expires: 0 }));
}
