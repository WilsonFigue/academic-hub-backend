// Arma el PDF de las guías listas que no lo tienen en la base de datos (guías anteriores a este cambio) o lo tienen viejo. Necesita Chromium. Seguro de repetir.
import { ConfigError, readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { backfillGuidePdfs } from '../src/modules/guides/guides.js';
import { closePdfBrowser, renderGuidePdf } from '../src/modules/guides/pdf.js';

async function main(): Promise<void> {
  const config = readConfig();
  const db = createDatabase(config, requireDatabaseUrl(config), { max: 2 });
  try {
    const result = await backfillGuidePdfs(db, config.frontendOrigin, renderGuidePdf);
    console.log(`PDF de guías armados y guardados en la base: ${result.made} · con error: ${result.failed}`);
  } finally {
    await closePdfBrowser();
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : 'No fue posible armar los PDF de las guías.');
  process.exitCode = 1;
});
