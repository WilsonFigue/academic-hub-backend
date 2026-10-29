// Contra la DEMO (5174): interruptores de guías de estudio (Perfil e Información) y el bloque de cada actividad.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';

const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
const config = readConfig();
if (!config.dbSchema.endsWith('_demo')) throw new Error('Usa DB_SCHEMA=academic_hub_demo');
const db = createDatabase(config, config.databaseUrl!, { max: 1 });
await db.query('DELETE FROM study_guides');
await db.query('DELETE FROM study_guide_settings');

const BASE = 'http://localhost:5174';
const root = join(process.env.LOCALAPPDATA!, 'ms-playwright');
const exe = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(root, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const problems: string[] = [];

for (const [label, width, height] of [['1440', 1440, 900], ['390', 390, 800]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');

  // Perfil: todas apagadas; se enciende una.
  await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
  const switches = page.getByRole('switch');
  await switches.first().waitFor({ timeout: 8000 });
  const total = await switches.count();
  for (let i = 0; i < total; i += 1) if ((await switches.nth(i).getAttribute('aria-checked')) !== 'false') problems.push(`${label}: una materia no arranca apagada`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, `${label}-profile-off.png`), fullPage: true });
  await switches.first().click();
  await page.waitForTimeout(700);
  if ((await switches.first().getAttribute('aria-checked')) !== 'true') problems.push(`${label}: el interruptor no se enciende`);
  await page.screenshot({ path: join(out, `${label}-profile-on.png`), fullPage: true });
  await switches.first().click(); await page.waitForTimeout(500);

  // Actividad: botón manual con la materia apagada → en cola → no se puede pedir otra.
  await page.goto(`${BASE}/courses`, { waitUntil: 'networkidle' });
  await page.locator('a[href^="/courses/"]', { hasText: /Bases/i }).first().click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /Examen corto de índices|Práctica SQL/ }).first().click();
  const generate = page.getByRole('button', { name: /Generar guía/ });
  await generate.waitFor({ timeout: 8000 }).catch(() => problems.push(`${label}: no aparece el botón Generar guía`));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, `${label}-activity-none.png`) });
  await generate.click();
  await page.getByText('Guía en cola').waitFor({ timeout: 8000 }).catch(() => problems.push(`${label}: no pasa a "Guía en cola"`));
  if (await page.getByRole('button', { name: /Generar guía/ }).count() > 0) problems.push(`${label}: tras pedirla sigue el botón (se podría duplicar)`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${label}-activity-queued.png`) });

  // Se simula una guía lista para ver el aspecto (solo en la demo).
  await db.query(`UPDATE study_guides SET status = 'ready', model = 'demo', finished_at = now(),
    content = $1::jsonb`, [JSON.stringify({ summary: 'Esta actividad evalúa si sabes cuándo un índice acelera una consulta y cuándo no.', sections: [
      { heading: 'Qué te piden', body: 'Analizar tres consultas y proponer el índice adecuado para cada una.' },
      { heading: 'Conceptos que necesitas', body: '', bullets: ['Índice B-tree y cuándo se usa', 'Selectividad de una columna', 'Plan de ejecución con EXPLAIN'] },
      { heading: 'Cómo abordarla', body: '1. Lee cada consulta.\n2. Identifica las columnas del WHERE.\n3. Revisa el plan antes y después.' }],
      sources: [{ file: 'CLASE 7 Índices.pdf' }, { file: 'Guía de laboratorio 4.docx' }] })]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Examen corto de índices|Práctica SQL/ }).first().click().catch(() => {});
  await page.getByRole('button', { name: /Ver guía/ }).click({ timeout: 8000 }).catch(() => problems.push(`${label}: no aparece "Ver guía"`));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, `${label}-activity-ready.png`) });
  await db.query('DELETE FROM study_guides');

  // Información: interruptor de la materia.
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Información/ }).click();
  await page.waitForTimeout(900);
  const courseSwitch = page.getByRole('switch');
  if ((await courseSwitch.count()) !== 1) problems.push(`${label}: falta el interruptor en Información`);
  await page.screenshot({ path: join(out, `${label}-info.png`), fullPage: true });
  const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
  if (over > 1) problems.push(`${label}: desborde horizontal de ${over}px`);
  await page.close();
}
await browser.close();
await db.query('DELETE FROM study_guides');
await db.query('DELETE FROM study_guide_settings');
await db.close?.();
console.log(problems.length ? problems.join('\n') : 'Guías: interruptores y bloque de actividad sin problemas.');
