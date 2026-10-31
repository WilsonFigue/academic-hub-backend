// Inicio de sesión desatendido con las credenciales recordadas. Modo según BLACKBOARD_LOGIN_MODE:
//   browser (por defecto) → Chromium sin ventana, como siempre.
//   auto                  → primero por HTTP (sin navegador, más rápido) y, si la página de login cambió o no hubo red, Chromium.
//   http                  → solo por HTTP (sin navegador; útil donde no hay Chromium).
import { httpLoginCookies } from './http-login.js';
import { LoginError, buildCapturedSession, loadSdk, loginInteractively, type CapturedSession, type LoginOptions } from './session-login.js';

export type LoginMode = 'browser' | 'auto' | 'http';
export const loginModeFromEnv = (value: string | undefined = process.env.BLACKBOARD_LOGIN_MODE): LoginMode => (value === 'auto' || value === 'http' ? value : 'browser');

type Credentials = { username: string; password: string };
export interface LoginDeps {
  http(baseUrl: string, credentials: Credentials): Promise<CapturedSession>;
  browser(baseUrl: string, credentials: Credentials, options: LoginOptions): Promise<CapturedSession>;
}
const defaultDeps: LoginDeps = {
  http: async (baseUrl, credentials) => buildCapturedSession(await loadSdk(), baseUrl, await httpLoginCookies(baseUrl, credentials)),
  browser: (baseUrl, credentials, options) => loginInteractively(baseUrl, credentials, () => {}, options),
};

export async function loginStored(baseUrl: string, credentials: Credentials, options: LoginOptions = {}, mode: LoginMode = loginModeFromEnv(), deps: LoginDeps = defaultDeps): Promise<CapturedSession> {
  if (mode === 'browser') return deps.browser(baseUrl, credentials, options);
  if (mode === 'http') return deps.http(baseUrl, credentials);
  try {
    return await deps.http(baseUrl, credentials);
  } catch (error) {
    // Contraseña rechazada o segundo factor: NO se reintenta con el navegador (dos intentos fallidos seguidos pueden bloquear la cuenta).
    if (error instanceof LoginError && (error.code === 'invalid_credentials' || error.code === 'mfa_required')) throw error;
    return deps.browser(baseUrl, credentials, options);
  }
}
