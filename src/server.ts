import { ConfigError, readConfig } from './config/env.js';
import { createDatabase } from './database/connection.js';
import { buildApp } from './app.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

async function main(): Promise<void> {
  const config = readConfig();
  const db = config.databaseUrl ? createDatabase(config, config.databaseUrl) : null;

  // Las rutas internas de importación solo existen en desarrollo, con token de operador y escuchando en loopback.
  const internalEnabled = config.nodeEnv === 'development' && Boolean(config.devOperatorToken) && Boolean(db) && LOOPBACK_HOSTS.has(config.host);
  // Sesiones de Blackboard para abrir archivos y leer foros con las credenciales recordadas (cifradas con CREDENTIALS_KEY): sirven también en producción.
  const sessions = db && config.credentialsKey
    ? new (await import('./modules/files/sessions.js')).BlackboardSessions({ db: db!, key: config.credentialsKey, baseUrl: 'https://utecvirtual.blackboard.com', visible: config.scheduledLoginVisible })
    : null;
  // Guías de estudio: con la clave de OpenAI se generan de verdad; sin ella las solicitudes quedan en cola.
  const { createFileStore } = await import('./modules/files/store.js');
  const { createOpenAIGenerator } = await import('./modules/guides/openai.js');
  const { DEFAULT_POLICY } = await import('./modules/guides/guides.js');
  // Al terminar cada guía se arma su PDF y se guarda en la base de datos: la API lo sirve después sin Chromium.
  const { renderGuidePdf } = await import('./modules/guides/pdf.js');
  const guidePolicy = { ...DEFAULT_POLICY, monthlyCapUsd: config.studyGuideMonthlyCapUsd, maxPerRun: config.studyGuideMaxPerRun, webOrigin: config.frontendOrigin, renderPdf: renderGuidePdf };
  const guideGenerator = config.openaiApiKey && db
    ? createOpenAIGenerator({ apiKey: config.openaiApiKey, model: config.studyGuideModel, priceInPerM: config.studyGuidePriceInPerM, priceOutPerM: config.studyGuidePriceOutPerM, reasoningEffort: config.studyGuideReasoning || undefined,
        maxInputChars: config.studyGuideMaxInputChars, db, store: createFileStore(sessions) })
    : undefined;
  // Tareas con IA: la rutina corre solo cuando un programador externo llama al endpoint interno; sin clave de OpenAI quedan en cola.
  const { createHomeworkGenerator } = await import('./modules/homework/agent.js');
  const { DEFAULT_HOMEWORK_POLICY, HOMEWORK_DIR } = await import('./modules/homework/homework.js');
  const homeworkPolicy = { ...DEFAULT_HOMEWORK_POLICY, monthlyCapUsd: config.homeworkMonthlyCapUsd, maxPerRun: config.homeworkMaxPerRun, estimatedCostUsd: config.homeworkEstimatedCostUsd, maxPerTaskUsd: config.homeworkMaxPerTaskUsd };
  const homeworkGenerator = config.openaiApiKey && db
    ? createHomeworkGenerator({ apiKey: config.openaiApiKey, model: config.homeworkModel, priceInPerM: config.homeworkPriceInPerM, priceOutPerM: config.homeworkPriceOutPerM,
        maxInputChars: config.studyGuideMaxInputChars, maxPerTaskUsd: config.homeworkMaxPerTaskUsd, maxTurns: config.homeworkMaxTurns, reasoningEffort: config.homeworkReasoning, db, store: createFileStore(sessions), outDir: HOMEWORK_DIR })
    : undefined;
  const { createForumSuggester } = await import('./modules/forums/suggest.js');
  const forumSuggester = config.openaiApiKey && db
    ? createForumSuggester({ apiKey: config.openaiApiKey, model: config.homeworkModel, priceInPerM: config.homeworkPriceInPerM, priceOutPerM: config.homeworkPriceOutPerM, reasoningEffort: 'low', db })
    : undefined;
  // Correo de resumen (Mailchimp): sin llave no se envía nada.
  const { createMailchimpMailer, notConfiguredMailer } = await import('./modules/notifications/mailer.js');
  const mailer = config.mailchimpApiKey ? createMailchimpMailer({ apiKey: config.mailchimpApiKey, listId: config.mailchimpListId, fromName: config.mailFromName }) : notConfiguredMailer;
  // Avisos por Telegram: sin token no se conecta ni se manda nada. El enlace «Abrir en Academic Hub» solo sirve si la web no es localhost.
  const { createTelegramClient, notConfiguredTelegram } = await import('./modules/notifications/telegram.js');
  const telegram = config.telegramBotToken ? createTelegramClient({ token: config.telegramBotToken }) : notConfiguredTelegram;
  const webUrl = ['localhost', '127.0.0.1', '::1'].includes(new URL(config.frontendOrigin).hostname) ? null : config.frontendOrigin;
  const app = await buildApp({
    config,
    db,
    telegram,
    mailer,
    cronSecret: config.cronSecret,
    webUrl,
    blackboardSessions: sessions,
    guideGenerator,
    guidePolicy,
    forumSuggester,
    forumCapUsd: config.homeworkMonthlyCapUsd,
    registerInternal: internalEnabled || (config.cronSecret && db)
      ? async (instance) => {
          const { devImportRoutes } = await import('./modules/import/dev-import.routes.js');
          const shared = { db: db!, passingGradePct: config.passingGradePct, credentialsKey: config.credentialsKey, scheduledLoginVisible: config.scheduledLoginVisible, guideGenerator, guidePolicy, homeworkGenerator, homeworkPolicy };
          if (internalEnabled) {
            await instance.register(devImportRoutes, { ...shared, operatorToken: config.devOperatorToken! });
            const { emailRoutes } = await import('./modules/notifications/email.routes.js');
            await instance.register(emailRoutes, { db: db!, operatorToken: config.devOperatorToken!, mailer, capUsd: config.homeworkMonthlyCapUsd, telegram, webUrl });
          }
          // Producción (y desarrollo si hay CRON_SECRET): rutinas por endpoint con clave, sin las que reciben contraseñas.
          if (config.cronSecret && db) await instance.register(devImportRoutes, { ...shared, mode: 'jobs', cronSecret: config.cronSecret });
        }
      : undefined,
  });
  if (!db) app.log.warn('Sin base de datos configurada: /api/v1 responderá 503.');
  if (internalEnabled) app.log.warn('Rutas /internal/dev habilitadas (solo loopback, requieren DEV_OPERATOR_TOKEN).');
  if (config.cronSecret && db) app.log.info('Rutinas /jobs habilitadas (requieren CRON_SECRET).');

  let stopTelegram: (() => void) | null = null;
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Cerrando servidor');
    stopTelegram?.();
    await app.close();
    await db?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  if (db && telegram.configured && config.backgroundJobs) {
    const { startTelegramLoops } = await import('./modules/notifications/telegram-service.js');
    stopTelegram = startTelegramLoops(db, telegram, { webUrl, onError: (error: unknown) => app.log.warn({ err: { name: (error as Error)?.name, code: (error as { code?: string })?.code } }, 'telegram loop') });
    app.log.info('Avisos por Telegram activos (el servidor atiende al bot y recalcula los recordatorios solo).');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : 'No fue posible iniciar el servidor.');
  process.exit(1);
});
