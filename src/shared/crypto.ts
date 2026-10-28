import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Token opaco de 256 bits, apto para cookies y cabeceras. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Huella no reversible de la IP para auditoría (sin almacenar la IP). */
export function hashIp(ip: string | undefined): Buffer | null {
  return ip ? sha256(`ip:${ip}`) : null;
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#';

/** Contraseña temporal con CSPRNG (≈ 6 bits por carácter; 20 caracteres ≈ 119 bits). */
export function generateTemporaryPassword(length = 20): string {
  let out = '';
  for (let index = 0; index < length; index += 1) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}
