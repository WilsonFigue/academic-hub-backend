import { ConfigError, readConfig } from './config/env.js';
import { createDatabase } from './database/connection.js';
import { buildApp } from './app.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

async function main(): Promise<void> {
  const config = readConfig();
  const db = config.databaseUrl ? createDatabase(config, config.databaseUrl) : null;

  // Las rutas internas de importación solo existen en desarrollo, con token de operador y escuchando en loopback.
  const internalEnabled = config.nodeEnv === 'development' && Boolean(config.devOperatorToken) && Boolean(db) && LOOPBACK_HOSTS.has(config.host);
  const sessions = internalEnabled && config.credentialsKey
    ? new (await import('./modules/files/sessions.js')).BlackboardSessions({ db: db!, key: config.credentialsKey, baseUrl: 'https://utecvirtual.blackboard.com', visible: config.scheduledLoginVisible })
    : null;
  // Guías de estudio: con la clave de OpenAI se generan de verdad; sin ella las solicitudes quedan en cola.
  const { createFileStore } = await import('./modules/files/store.js');
  const { createOpenAIGenerator } = await import('./modules/guides/openai.js');
  const { DEFAULT_POLICY } = await import('./modules/guides/guides.js');
  const guidePolicy = { ...DEFAULT_POLICY, monthlyCapUsd: config.studyGuideMonthlyCapUsd, maxPerRun: config.studyGuideMaxPerRun };
  const guideGenerator = config.openaiApiKey && db
    ? createOpenAIGenerator({ apiKey: config.openaiApiKey, model: config.openaiModel, priceInPerM: config.openaiPriceInPerM, priceOutPerM: config.openaiPriceOutPerM,
        maxInputChars: config.studyGuideMaxInputChars, db, store: createFileStore(sessions) })
    : undefined;
  const app = await buildApp({
    config,
    db,
    blackboardSessions: sessions,
    guideGenerator,
    guidePolicy,
    registerInternal: internalEnabled
      ? async (instance) => {
          const { devImportRoutes } = await import('./modules/import/dev-import.routes.js');
          await instance.register(devImportRoutes, { db: db!, operatorToken: config.devOperatorToken!, passingGradePct: config.passingGradePct,
            credentialsKey: config.credentialsKey, scheduledLoginVisible: config.scheduledLoginVisible, guideGenerator, guidePolicy });
        }
      : undefined,
  });
  if (!db) app.log.warn('Sin base de datos configurada: /api/v1 responderá 503.');
  if (internalEnabled) app.log.warn('Rutas /internal/dev habilitadas (solo loopback, requieren DEV_OPERATOR_TOKEN).');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Cerrando servidor');
    await app.close();
    await db?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : 'No fue posible iniciar el servidor.');
  process.exit(1);
});
