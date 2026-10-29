// Bóveda de credenciales de Blackboard: cifrado en reposo (AES-256-GCM) con la clave del entorno.
// Reglas: la clave nunca se guarda en la base; el texto plano solo existe en memoria durante el inicio de sesión;
// nada de esto se registra en logs ni se devuelve por la API. El AAD ata cada secreto a su cuenta (no se puede mover a otra fila).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Queryable } from '../../database/connection.js';

const NONCE = 12;
const TAG = 16;

export interface StoredCredentials { username: string; password: string }

export function encryptSecret(key: Buffer, aad: string, plain: string): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]);
}

export function decryptSecret(key: Buffer, aad: string, blob: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, NONCE));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(blob.subarray(NONCE, NONCE + TAG));
  return Buffer.concat([decipher.update(blob.subarray(NONCE + TAG)), decipher.final()]).toString('utf8');
}

export async function saveCredentials(db: Queryable, key: Buffer, accountId: string, credentials: StoredCredentials): Promise<void> {
  const blob = encryptSecret(key, accountId, JSON.stringify({ u: credentials.username, p: credentials.password }));
  await db.query(
    `INSERT INTO account_credentials (external_account_id, ciphertext, consented_at, last_error_code, last_error_at)
     VALUES ($1, $2, now(), NULL, NULL)
     ON CONFLICT (external_account_id) DO UPDATE SET ciphertext = excluded.ciphertext, consented_at = now(), key_version = 1, last_error_code = NULL, last_error_at = NULL`,
    [accountId, blob],
  );
}

/** Descifra las credenciales de una cuenta; null si no hay o si no se pueden descifrar (clave distinta o dato alterado). */
export async function loadCredentials(db: Queryable, key: Buffer, accountId: string): Promise<StoredCredentials | null> {
  const { rows } = await db.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM account_credentials WHERE external_account_id = $1', [accountId]);
  if (!rows[0]) return null;
  try {
    const data = JSON.parse(decryptSecret(key, accountId, rows[0].ciphertext)) as { u?: string; p?: string };
    return data.u && data.p ? { username: data.u, password: data.p } : null;
  } catch {
    return null;
  }
}

export async function deleteCredentials(db: Queryable, accountId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM account_credentials WHERE external_account_id = $1', [accountId]);
  return (result.rowCount ?? 0) > 0;
}

export async function markCredentialUse(db: Queryable, accountId: string, errorCode: string | null): Promise<void> {
  await db.query(
    `UPDATE account_credentials SET last_used_at = now(), last_ok_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_ok_at END,
            last_error_code = $2, last_error_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
      WHERE external_account_id = $1`,
    [accountId, errorCode],
  );
}
