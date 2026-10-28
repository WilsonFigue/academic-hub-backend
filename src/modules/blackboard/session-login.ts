// Inicio de sesión interactivo en Blackboard UTEC (solo desarrollo local).
// Playwright → cookies del host UTEC → Session.fromBrowserCookies (blackboard-mcp) → sesión solo en memoria.
// Playwright y blackboard-mcp se cargan dinámicamente: la API pública nunca depende de ellos.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BlackboardTransport } from './gateway.js';

export type LoginPhase = 'authenticating' | 'awaiting_mfa';

export class LoginError extends Error {
  constructor(readonly code: 'login_timeout' | 'login_not_ultra' | 'browser_failed', message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;

function resolveChromiumExecutable(chromium: { executablePath(): string }): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  const root = localAppData ? join(localAppData, 'ms-playwright') : '';
  if (!root || !existsSync(root)) return undefined;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .map((entry) => ({ version: Number(entry.name.slice(9)), path: join(root, entry.name, 'chrome-win64', 'chrome.exe') }))
    .filter((entry) => existsSync(entry.path))
    .sort((left, right) => right.version - left.version)[0]?.path;
}

/** Hosts donde se pueden rellenar credenciales: Blackboard UTEC o dominios institucionales. */
function credentialHostAllowed(hostname: string, baseHost: string): boolean {
  return hostname === baseHost || hostname === 'utec.edu.sv' || hostname.endsWith('.utec.edu.sv');
}

export interface CapturedSession {
  transport: BlackboardTransport;
  /** Descarta cookies y referencias; debe llamarse al terminar. */
  dispose(): void;
}

/**
 * Abre Chromium visible, rellena las credenciales en el host permitido y espera a que el titular
 * complete el MFA si aparece. Las credenciales no se guardan ni se registran.
 */
export async function loginInteractively(
  baseUrl: string,
  credentials: { username: string; password: string },
  onPhase: (phase: LoginPhase) => void,
): Promise<CapturedSession> {
  const { chromium } = await import('playwright');
  const sdk = await import('blackboard-mcp');
  delete process.env.BLACKBOARD_MCP_ALLOW_WRITES;
  delete process.env.BLACKBOARD_COOKIE;
  sdk.setLogLevel('error');

  const baseHost = new URL(baseUrl).hostname;
  const executablePath = resolveChromiumExecutable(chromium);
  const browser = await chromium.launch({ headless: false, ...(executablePath ? { executablePath } : {}) })
    .catch(() => { throw new LoginError('browser_failed', 'No fue posible iniciar Chromium.'); });
  try {
    const context = await browser.newContext({ userAgent: sdk.DEFAULT_USER_AGENT });
    const page = await context.newPage();
    onPhase('authenticating');
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_000);

    if (credentialHostAllowed(new URL(page.url()).hostname, baseHost)) {
      const first = async (selectors: string[]) => {
        for (const selector of selectors) {
          const locator = page.locator(selector).first();
          if (await locator.isVisible().catch(() => false)) return locator;
        }
        return null;
      };
      const user = await first(['input[name="user_id"]', '#user_id', 'input[name="username"]', 'input[autocomplete="username"]']);
      const pass = await first(['input[name="password"]', '#password', 'input[type="password"]']);
      if (user && pass) {
        await user.fill(credentials.username);
        await pass.fill(credentials.password);
        const submit = await first(['button[type="submit"]', 'input[type="submit"]', '#entry-login']);
        if (submit) await submit.click();
        else await pass.press('Enter');
      }
    }

    // Espera a Ultra; mientras tanto, si se ve un formulario de código, el titular debe completar el MFA.
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let reachedUltra = false;
    while (Date.now() < deadline) {
      const current = new URL(page.url());
      if (current.hostname === baseHost && current.pathname.startsWith('/ultra')) { reachedUltra = true; break; }
      const mfa = await page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="otp" i]').first().isVisible().catch(() => false);
      onPhase(mfa ? 'awaiting_mfa' : 'authenticating');
      await page.waitForTimeout(1_500);
    }
    if (!reachedUltra) throw new LoginError('login_timeout', 'No se completó el inicio de sesión en Blackboard a tiempo.');
    await page.waitForTimeout(3_000);

    // Solo cookies del host Blackboard UTEC (nunca de otros dominios).
    const cookies = (await context.cookies(baseUrl)).map((cookie) => ({
      host: cookie.domain, name: cookie.name, value: cookie.value, path: cookie.path,
      secure: cookie.secure, httpOnly: cookie.httpOnly, expires: cookie.expires > 0 ? cookie.expires * 1_000 : 0,
    }));
    const imported = await sdk.Session.fromBrowserCookies(baseUrl, cookies, { userAgent: sdk.DEFAULT_USER_AGENT });

    class MemoryOnlySession extends sdk.Session {
      override async persist(): Promise<void> {
        // Nunca persistir la sesión de Blackboard.
      }
    }
    const session = new MemoryOnlySession(imported.baseUrl, imported.jar, imported.xsrfToken, imported.userAgent, imported.capturedAt, imported.user, []);
    const config = sdk.ConfigSchema.parse({
      baseUrl, label: 'Academic Hub dev import', pageSize: 100, maxDownloadBytes: 1_024, // mínimo aceptado por el SDK; no se descargan archivos
      downloadDir: join(process.cwd(), '.state', 'downloads-disabled'), allowWrites: false, extraHosts: [],
    });
    const http: InstanceType<typeof sdk.HttpClient> | null = new sdk.HttpClient(session, config);
    let disposed = false;

    const transport: BlackboardTransport = {
      async get(path, query) {
        if (disposed || !http) throw new Error('Sesión descartada.');
        try {
          // Solo GET; sin renovación SSO (UTEC usa login nativo + MFA, no hay IdP).
          const response = await http.request({ path, query, retries: 1, allowRefresh: false, allowNotFound: true });
          if (response.status === 404 || response.status === 204) return { status: response.status, body: null };
          const text = await response.body.text();
          return { status: response.status, body: text ? JSON.parse(text) : null };
        } catch (error) {
          if (error instanceof sdk.BlackboardError) {
            if (error.code === 'SESSION_EXPIRED' || error.code === 'NOT_AUTHENTICATED') return { status: 401, body: null };
            return { status: error.status ?? 0, body: null };
          }
          return { status: 0, body: null };
        }
      },
    };
    return {
      transport,
      dispose() {
        disposed = true;
        void session.jar.removeAllCookies().catch(() => {});
      },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
