// Programador de rutinas dentro del servidor (sin dependencias): cada rutina tiene horarios (hora de El Salvador) y se ejecuta sola.
// - Cada horario ("slot") corre UNA sola vez: la llave (rutina, horario) de scheduled_job_runs lo garantiza, también tras reiniciar el servidor.
// - Si la computadora estuvo apagada a la hora de una rutina, se ejecuta al volver (solo el horario más reciente dentro de su ventana de recuperación).
// - Las rutinas corren de una en una, para no cruzar actualizaciones con envíos de correo.
import type { Database } from '../../database/connection.js';
import type { Slot } from '../../config/schedule.js';

const DAY_MS = 86_400_000;
const SV_OFFSET = '-06:00';        // El Salvador no usa horario de verano
const TIME_ZONE = 'America/El_Salvador';
const pad = (n: number) => String(n).padStart(2, '0');

export interface Job {
  name: string;
  slots: Slot[];
  /** Hasta cuánto después de su hora todavía se ejecuta si el servidor estaba apagado. */
  catchupMs: number;
  /** Devuelve datos para el historial; si lanza un error, el horario queda como fallido. */
  run(): Promise<Record<string, unknown> | void>;
}

export const localDateKey = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });

/** El horario más reciente de la rutina que ya pasó y sigue dentro de su ventana de recuperación. */
export function dueSlot(slots: Slot[], nowMs: number, windowMs: number): { key: string; at: number } | null {
  let best: { key: string; at: number } | null = null;
  for (let back = 0; back <= Math.ceil(windowMs / DAY_MS) + 1; back += 1) {
    const dateKey = localDateKey(nowMs - back * DAY_MS);
    const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    for (const slot of slots) {
      if (slot.weekday !== undefined && slot.weekday !== weekday) continue;
      if (slot.dayOfMonth !== undefined && slot.dayOfMonth !== day) continue;
      const at = Date.parse(`${dateKey}T${pad(slot.hour)}:${pad(slot.minute)}:00${SV_OFFSET}`);
      if (at <= nowMs && nowMs - at <= windowMs && (!best || at > best.at)) best = { at, key: `${dateKey}@${pad(slot.hour)}:${pad(slot.minute)}` };
    }
  }
  return best;
}

export interface TickResult { job: string; slot: string; status: 'ok' | 'failed' | 'skipped' }

export function createScheduler(options: { db: Database; jobs: Job[]; now?: () => number; log?: (message: string, data?: Record<string, unknown>) => void }) {
  const { db, jobs, now = Date.now, log = () => {} } = options;
  let busy = false;

  /** Revisa todas las rutinas y ejecuta las que toquen. */
  async function tick(): Promise<TickResult[]> {
    if (busy) return [];
    busy = true;
    const results: TickResult[] = [];
    try {
      for (const job of jobs) {
        const slot = dueSlot(job.slots, now(), job.catchupMs);
        if (!slot) continue;
        const claimed = await db.query<{ id: string }>(
          `INSERT INTO scheduled_job_runs (job_name, slot_key) VALUES ($1, $2) ON CONFLICT (job_name, slot_key) DO NOTHING RETURNING id`, [job.name, slot.key]);
        const id = claimed.rows[0]?.id;
        if (!id) continue;                                   // ese horario ya corrió (o está corriendo)
        log('rutina: empieza', { job: job.name, slot: slot.key });
        let status: 'ok' | 'failed' | 'skipped' = 'ok'; let detail: Record<string, unknown> | void = undefined; let errorCode: string | null = null;
        try {
          detail = await job.run();
          if (detail && (detail as { skipped?: unknown }).skipped) status = 'skipped';
        } catch (error) {
          status = 'failed';
          errorCode = ((error as { code?: unknown }).code as string | undefined)?.toString().slice(0, 60) ?? 'job_failed';
          detail = { message: (error as Error)?.message?.slice(0, 300) };
        }
        await db.query(`UPDATE scheduled_job_runs SET status = $2, finished_at = now(), detail = $3::jsonb, error_code = $4 WHERE id = $1`,
          [id, status, detail ? JSON.stringify(detail) : null, errorCode]);
        log(`rutina: ${status}`, { job: job.name, slot: slot.key, ...(errorCode ? { errorCode } : {}) });
        results.push({ job: job.name, slot: slot.key, status });
      }
    } finally { busy = false; }
    return results;
  }

  /** Arranca el programador (revisa cada 30 s). Marca como interrumpidas las rutinas que quedaron «corriendo» por un cierre del servidor. */
  function start(): () => void {
    void db.query(`UPDATE scheduled_job_runs SET status = 'failed', error_code = 'interrupted', finished_at = now() WHERE status = 'running'`).catch(() => {});
    const timer = setInterval(() => { void tick().catch((error) => log('rutina: error del programador', { name: (error as Error)?.name })); }, 30_000);
    const first = setTimeout(() => { void tick().catch(() => {}); }, 10_000);
    timer.unref(); first.unref();
    return () => { clearInterval(timer); clearTimeout(first); };
  }

  return { tick, start };
}
