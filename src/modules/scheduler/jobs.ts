// Las rutinas automáticas. Llaman a los mismos endpoints /jobs/* que se usarían desde fuera (con CRON_SECRET), pero dentro del servidor.
import type { Database } from '../../database/connection.js';
import { parseMonthly, parseTimes, parseWeekly } from '../../config/schedule.js';
import { ensureMonthlyReports } from '../logs/report.js';
import type { Job } from './scheduler.js';

export type JobCall = (method: 'GET' | 'POST', path: string) => Promise<{ status: number; json: Record<string, any> }>;

export interface JobsConfig { scheduleRefresh: string; scheduleWeeklyEmail: string; scheduleMonthlyEmail: string; scheduleDailyEmail: string; homeworkMonthlyCapUsd: number }

const HOUR = 3_600_000;
const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildJobs(options: { call: JobCall; db: Database; config: JobsConfig; sleep?: (ms: number) => Promise<void>; pollMs?: number; refreshTimeoutMs?: number }): Job[] {
  const { call, db, config, sleep = sleepFor, pollMs = 5000, refreshTimeoutMs = 15 * 60_000 } = options;

  /** Llama a un endpoint y falla si no responde bien. */
  const must = async (method: 'GET' | 'POST', path: string) => {
    const response = await call(method, path);
    if (response.status >= 400) throw Object.assign(new Error(`${path} → ${response.status} ${response.json?.error?.code ?? ''}`.trim()), { code: response.json?.error?.code ?? `http_${response.status}` });
    return response;
  };

  /** Actualiza desde Blackboard y espera a que termine. */
  async function refresh(): Promise<{ skipped?: true }> {
    const started = await call('POST', '/jobs/utec/refresh');
    if (started.status === 409) return { skipped: true };                  // ya hay una actualización en curso
    if (started.status !== 202) throw Object.assign(new Error(`refresh → ${started.status}`), { code: started.json?.error?.code ?? `http_${started.status}` });
    const id = String(started.json.operationId);
    for (let waited = 0; waited <= refreshTimeoutMs; waited += pollMs) {
      const status = (await must('GET', `/jobs/utec/imports/${id}`)).json;
      if (status.status === 'completed') {
        const failed = (status.stored ?? []).filter((account: { ok: boolean }) => !account.ok);
        if (failed.length > 0) throw Object.assign(new Error(`falló con: ${failed.map((a: { username: string; errorCode: string }) => `${a.username} (${a.errorCode})`).join(', ')}`), { code: failed[0].errorCode ?? 'refresh_failed' });
        return {};
      }
      if (status.status === 'failed') throw Object.assign(new Error(status.error?.message ?? 'la actualización falló'), { code: status.error?.code ?? 'refresh_failed' });
      await sleep(pollMs);
    }
    throw Object.assign(new Error('la actualización tardó demasiado'), { code: 'refresh_timeout' });
  }

  const jobs: Job[] = [];

  // Actualizar actividades y notas desde Blackboard → calendario → guías → tareas → avisos y Telegram.
  const refreshSlots = parseTimes(config.scheduleRefresh) ?? [];
  if (refreshSlots.length > 0) {
    jobs.push({
      name: 'actualizar', slots: refreshSlots, catchupMs: 3 * HOUR,
      async run() {
        const steps: Record<string, string> = {};
        let firstError: Error | null = null;
        const step = async (name: string, fn: () => Promise<unknown>) => {
          try { const out = await fn(); steps[name] = (out as { skipped?: boolean } | undefined)?.skipped ? 'omitido' : 'ok'; } catch (error) { steps[name] = `error: ${(error as Error).message}`.slice(0, 160); firstError ??= error as Error; }
        };
        await step('actualizar', refresh);
        await step('calendario', () => must('POST', '/jobs/utec/calendar'));
        await step('guias', () => must('POST', '/jobs/utec/study-guides'));
        await step('tareas', () => must('POST', '/jobs/utec/homework'));
        await step('avisos', () => must('POST', '/jobs/notifications'));
        if (firstError) throw Object.assign(new Error(JSON.stringify(steps)), { code: (firstError as { code?: string }).code ?? 'step_failed' });
        return { steps };
      },
    });
  }

  const emailJob = (name: string, slots: ReturnType<typeof parseTimes>, catchupMs: number, path: string, before?: () => Promise<unknown>) => {
    if (!slots || slots.length === 0) return;
    jobs.push({ name, slots, catchupMs, async run() { await before?.(); const { json } = await must('POST', path); return { results: json.results }; } });
  };
  emailJob('correo-diario', parseTimes(config.scheduleDailyEmail), 6 * HOUR, '/jobs/email-summary');
  emailJob('correo-semanal', parseWeekly(config.scheduleWeeklyEmail), 12 * HOUR, '/jobs/email-summary?kind=weekly');
  // Cierre mensual: primero se guarda el reporte definitivo del mes que terminó; el tope de gasto vuelve a empezar solo (se cuenta por mes).
  emailJob('correo-mensual', parseMonthly(config.scheduleMonthlyEmail), 5 * 24 * HOUR, '/jobs/email-summary?kind=monthly',
    () => ensureMonthlyReports(db, { capUsd: config.homeworkMonthlyCapUsd }));

  return jobs;
}
