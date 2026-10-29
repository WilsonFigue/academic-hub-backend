// Cliente local de las actualizaciones de datos (completa y diaria). Pide las credenciales UTEC por teclado (contraseña oculta),
// las envía solo a la API en loopback y nunca las escribe en disco, argumentos ni historial. El MFA se completa a mano en Chromium.
//
//   npm run refresh:full    actualización completa: materias, contenido, historial (cerradas, calificación general) y todo lo diario
//   npm run refresh:daily   actualización ligera: actividades, notas, calendario, anuncios y pendientes de las materias en curso
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { readConfig } from '../src/config/env.js';

const mode = process.argv[2];
if (mode !== 'full' && mode !== 'daily') {
  console.error('Uso: tsx scripts/refresh.ts <full|daily>');
  process.exit(1);
}
const config = readConfig();
if (!config.devOperatorToken) {
  console.error('DEV_OPERATOR_TOKEN no está configurado en .env.');
  process.exit(1);
}
const base = `http://127.0.0.1:${config.port}`;

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    if (hidden) {
      const write = (rl as unknown as { _writeToOutput: (s: string) => void });
      write._writeToOutput = (chunk: string) => { if (chunk.includes(question)) stdout.write(question); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) stdout.write('\n'); resolve(answer); });
  });
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-dev-operator-token': config.devOperatorToken! },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
}

const LABELS: Record<string, string> = {
  starting: 'Iniciando…', authenticating: 'Iniciando sesión en Blackboard (ventana de Chromium)…',
  awaiting_mfa: 'Completa el MFA en la ventana de Chromium…', extracting: 'Leyendo datos académicos…', persisting: 'Guardando en PostgreSQL…',
};

/** Una actualización de un usuario; devuelve true si terminó bien. */
async function refreshOne(): Promise<boolean> {
  const username = (await ask('Usuario de Blackboard UTEC: ')).trim();
  if (!username) return false;
  let password: string | null = await ask('Contraseña de Blackboard UTEC: ', true);
  const rememberAnswer = (await ask('¿Recordar estas credenciales (cifradas) para poder actualizar con ellas? (s/n): ')).trim().toLowerCase();
  const remember = rememberAnswer === 's' || rememberAnswer === 'si' || rememberAnswer === 'sí';
  const start = await call('POST', `/internal/dev/utec/refresh/${mode}`, { username, password, remember });
  password = null;
  if (start.status !== 202) {
    console.error(`No se pudo iniciar (HTTP ${start.status}):`, (start.json.error as { message?: string })?.message ?? start.json);
    return false;
  }
  const operationId = String(start.json.operationId);
  let last = '';
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const { json } = await call('GET', `/internal/dev/utec/imports/${operationId}`);
    const status = String(json.status);
    if (status !== last && LABELS[status]) { console.log(LABELS[status]); last = status; }
    if (status === 'completed' || status === 'failed') {
      if (status === 'failed') {
        console.error('Falló:', JSON.stringify(json.error));
        return false;
      }
      const user = json.user as { username?: string } | undefined;
      const sync = json.sync as { status?: string; baseline?: boolean; changesRecorded?: number; incompleteSteps?: unknown[] } | undefined;
      console.log(`\nListo · ${user?.username ?? 'usuario'} · ${mode === 'full' ? 'actualización completa' : 'actualización diaria'}`);
      console.log('Sincronización:', sync?.status, `· novedades registradas: ${sync?.changesRecorded ?? 0}`, sync?.incompleteSteps?.length ? `· pasos incompletos: ${sync.incompleteSteps.length}` : '');
      console.log('Datos:', JSON.stringify(json.academicData));
      console.log(json.credentialsRemembered ? 'Credenciales recordadas (cifradas): se pueden usar con POST /internal/dev/utec/refresh/stored.' : 'Credenciales NO recordadas.');
      if (json.history) console.log('Historial de materias:', JSON.stringify(json.history));
      if (json.skippedClosed) console.log(`Materias cerradas omitidas (se actualizan en la completa): ${json.skippedClosed}`);
      return true;
    }
  }
}

console.log(mode === 'full'
  ? 'Actualización COMPLETA (materias, contenido, historial y datos diarios). Se repite para cada usuario.\n'
  : 'Actualización DIARIA (actividades, notas, calendario, anuncios y pendientes). Se repite para cada usuario.\n');
let done = 0;
for (;;) {
  if (await refreshOne()) done += 1;
  const again = (await ask('\n¿Actualizar otro usuario? (s/n): ')).trim().toLowerCase();
  if (again !== 's' && again !== 'si' && again !== 'sí') break;
  console.log('');
}
console.log(`\nUsuarios actualizados: ${done}`);
process.exit(0);
