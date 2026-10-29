import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { decryptSecret, deleteCredentials, encryptSecret, loadCredentials, saveCredentials } from '../src/modules/credentials/vault.js';
import { setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

describe('bóveda de credenciales (cifrado)', () => {
  const key = randomBytes(32);

  test('cifra y descifra; el resultado no contiene el texto plano', () => {
    const blob = encryptSecret(key, 'cuenta-1', 'Contraseña-secreta-123');
    assert.ok(!blob.toString('utf8').includes('secreta'));
    assert.equal(decryptSecret(key, 'cuenta-1', blob), 'Contraseña-secreta-123');
  });

  test('cada cifrado usa un nonce distinto', () => {
    assert.notDeepEqual(encryptSecret(key, 'a', 'x'), encryptSecret(key, 'a', 'x'));
  });

  test('otra clave, otro AAD o un dato alterado no descifran', () => {
    const blob = encryptSecret(key, 'cuenta-1', 'dato');
    assert.throws(() => decryptSecret(randomBytes(32), 'cuenta-1', blob));
    assert.throws(() => decryptSecret(key, 'cuenta-2', blob));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    assert.throws(() => decryptSecret(key, 'cuenta-1', tampered));
  });
});

describe('credenciales recordadas (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  let accountId = '';
  const key = randomBytes(32);
  before(async () => {
    ctx = await setupTestContext();
    const inst = (await ctx.db.query(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Test', 'blackboard_learn_ultra', 'https://bb.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`)).rows[0]!.id;
    const user = (await ctx.db.query(`INSERT INTO users (email, username, password_hash) VALUES ('c@test.invalid', 'cuenta.prueba', 'x') RETURNING id`)).rows[0]!.id;
    accountId = (await ctx.db.query(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`, [user, inst])).rows[0]!.id;
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  test('se guardan cifradas, se leen y se borran', async () => {
    await saveCredentials(ctx.db, key, accountId, { username: '2944000000', password: 'Mi-clave-UTEC-9' });
    const raw = (await ctx.db.query<{ ciphertext: Buffer }>(`SELECT ciphertext FROM account_credentials`)).rows[0]!.ciphertext;
    assert.ok(!raw.toString('latin1').includes('Mi-clave-UTEC-9') && !raw.toString('latin1').includes('2944000000'));
    assert.deepEqual(await loadCredentials(ctx.db, key, accountId), { username: '2944000000', password: 'Mi-clave-UTEC-9' });
    assert.equal(await loadCredentials(ctx.db, randomBytes(32), accountId), null, 'con otra clave no se pueden leer');
    assert.equal(await deleteCredentials(ctx.db, accountId), true);
    assert.equal(await loadCredentials(ctx.db, key, accountId), null);
  });
});
