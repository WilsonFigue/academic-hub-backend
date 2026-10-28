// Cliente local del onboarding de desarrollo. Pide las credenciales UTEC por teclado (contraseña oculta),
// las envía solo a la API en loopback y nunca las escribe en disco, argumentos ni historial.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { readConfig } from '../src/config/env.js';

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

const username = (await ask('Usuario de Blackboard UTEC: ')).trim();
let password: string | null = await ask('Contraseña de Blackboard UTEC: ', true);
const start = await call('POST', '/internal/dev/utec/create-user', { username, password });
password = null;
if (start.status !== 202) {
  console.error(`No se pudo iniciar (HTTP ${start.status}):`, (start.json.error as { message?: string })?.message ?? start.json);
  process.exit(1);
}
const operationId = String(start.json.operationId);
let last = '';
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const { json } = await call('GET', `/internal/dev/utec/imports/${operationId}`);
  const status = String(json.status);
  if (status !== last && LABELS[status]) { console.log(LABELS[status]); last = status; }
  if (status === 'completed' || status === 'failed') {
    console.log(JSON.stringify(json, null, 2));
    if (json.initialAccess && (json.initialAccess as { temporaryPassword?: string }).temporaryPassword) {
      console.log('\nGuarda la contraseña temporal ahora: no se volverá a mostrar. Se pedirá cambiarla al iniciar sesión.');
    }
    process.exit(status === 'completed' ? 0 : 1);
  }
}
