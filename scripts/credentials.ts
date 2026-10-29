// Administra las credenciales recordadas (cifradas). Nunca muestra ni descifra contraseñas.
//   npm run credentials -- status            quién tiene credenciales recordadas y cómo le fue a la última actualización con ellas
//   npm run credentials -- forget <usuario>  borra las credenciales recordadas de ese usuario de Academic Hub
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { deleteCredentials } from '../src/modules/credentials/vault.js';

const [command, username] = process.argv.slice(2);
const config = readConfig();
const db = createDatabase(config, requireDatabaseUrl(config, 'DATABASE_URL'), { max: 1 });
try {
  if (command === 'status') {
    const { rows } = await db.query(
      `SELECT u.username AS usuario, ac.consented_at::timestamp(0) AS recordada_desde, ac.last_ok_at::timestamp(0) AS ultima_ok, ac.last_error_code AS ultimo_error
         FROM account_credentials ac JOIN external_accounts ea ON ea.id = ac.external_account_id JOIN users u ON u.id = ea.user_id ORDER BY u.created_at`);
    if (rows.length === 0) console.log('Ningún usuario tiene credenciales recordadas.');
    else console.table(rows);
    console.log(`Clave de cifrado configurada: ${config.credentialsKey ? 'sí' : 'NO'}`);
  } else if (command === 'forget' && username) {
    const account = await db.query<{ id: string }>(`SELECT ea.id FROM external_accounts ea JOIN users u ON u.id = ea.user_id WHERE u.username = $1`, [username]);
    if (!account.rows[0]) { console.error(`No existe el usuario "${username}".`); process.exitCode = 1; }
    else console.log((await deleteCredentials(db, account.rows[0].id)) ? `Credenciales de ${username} borradas.` : `${username} no tenía credenciales recordadas.`);
  } else {
    console.error('Uso: npm run credentials -- status | forget <usuario>');
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
