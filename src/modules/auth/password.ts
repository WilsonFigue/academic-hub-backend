import { Algorithm, hash, verify } from '@node-rs/argon2';

// Parámetros OWASP para Argon2id: m = 19 MiB, t = 2, p = 1.
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Hash fijo para igualar el tiempo de respuesta cuando el usuario no existe.
let dummyHash: Promise<string> | null = null;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string | null, password: string): Promise<boolean> {
  if (!passwordHash) {
    dummyHash ??= hash('academic-hub-timing-equalizer', OPTIONS);
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(passwordHash, password).catch(() => false);
}

/** Devuelve un mensaje de error o null si la contraseña es aceptable. */
export function passwordProblem(password: string, context: { email?: string; username?: string | null } = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres.`;
  const lower = password.toLowerCase();
  const local = context.email?.split('@')[0]?.toLowerCase();
  if ((local && local.length >= 4 && lower.includes(local)) || (context.username && lower.includes(context.username.toLowerCase()))) {
    return 'La contraseña no debe contener tu correo ni tu usuario.';
  }
  if (new Set(password).size < 5) return 'La contraseña es demasiado repetitiva.';
  return null;
}
