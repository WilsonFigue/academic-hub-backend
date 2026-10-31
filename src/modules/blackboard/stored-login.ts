// Inicio de sesión desatendido con las credenciales recordadas: primero por HTTP (sin navegador, rápido y liviano) y,
// solo si la página de login cambió o no hubo red, con Chromium sin ventana como respaldo.
import { httpLoginCookies } from './http-login.js';
import { LoginError, buildCapturedSession, loadSdk, loginInteractively, type CapturedSession, type LoginOptions } from './session-login.js';

export async function loginStored(baseUrl: string, credentials: { username: string; password: string }, options: LoginOptions = {}): Promise<CapturedSession> {
  try {
    const sdk = await loadSdk();
    return await buildCapturedSession(sdk, baseUrl, await httpLoginCookies(baseUrl, credentials));
  } catch (error) {
    // Contraseña rechazada o segundo factor: NO se reintenta con el navegador (dos intentos fallidos seguidos pueden bloquear la cuenta).
    if (error instanceof LoginError && (error.code === 'invalid_credentials' || error.code === 'mfa_required')) throw error;
    return loginInteractively(baseUrl, credentials, () => {}, options);
  }
}
