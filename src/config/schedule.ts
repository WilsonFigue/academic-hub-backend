// Horarios de las rutinas automáticas (hora de El Salvador). Se leen de variables de entorno con un formato simple.
//   SCHEDULE_REFRESH_TIMES=06:00,13:00,20:00   horas del día (actualizar desde Blackboard, guías, tareas, avisos)
//   SCHEDULE_WEEKLY_EMAIL=dom@20:00            día de la semana @ hora (dom, lun, mar, mie, jue, vie, sab)
//   SCHEDULE_MONTHLY_EMAIL=1@08:00             día del mes @ hora
//   SCHEDULE_DAILY_EMAIL=off                   «off» o una hora (07:00)
// «off» desactiva la rutina. Un valor mal escrito es un error de configuración.

export interface Slot { hour: number; minute: number; weekday?: number; dayOfMonth?: number }

const WEEKDAYS: Record<string, number> = { dom: 0, lun: 1, mar: 2, mie: 3, mié: 3, jue: 4, vie: 5, sab: 6, sáb: 6 };
const OFF = new Set(['', 'off', 'no', 'false', 'apagado']);

function time(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

const list = (raw: string): string[] => raw.split(',').map((part) => part.trim()).filter(Boolean);

/** «06:00,13:00,20:00» → un horario por cada hora, todos los días. [] si está apagado; null si es inválido. */
export function parseTimes(raw: string): Slot[] | null {
  const text = raw.trim().toLowerCase();
  if (OFF.has(text)) return [];
  const slots: Slot[] = [];
  for (const part of list(text)) { const t = time(part); if (!t) return null; slots.push(t); }
  return slots;
}

/** «dom@20:00» (o varios separados por coma) → horarios semanales. */
export function parseWeekly(raw: string): Slot[] | null {
  const text = raw.trim().toLowerCase();
  if (OFF.has(text)) return [];
  const slots: Slot[] = [];
  for (const part of list(text)) {
    const [day, at] = part.split('@');
    const weekday = day === undefined ? undefined : WEEKDAYS[day.trim()];
    const t = at === undefined ? null : time(at);
    if (weekday === undefined || !t) return null;
    slots.push({ ...t, weekday });
  }
  return slots;
}

/** «1@08:00» → el día 1 de cada mes a las 8:00 (días 1 a 28, para que todos los meses lo tengan). */
export function parseMonthly(raw: string): Slot[] | null {
  const text = raw.trim().toLowerCase();
  if (OFF.has(text)) return [];
  const slots: Slot[] = [];
  for (const part of list(text)) {
    const [day, at] = part.split('@');
    const dayOfMonth = Number(day);
    const t = at === undefined ? null : time(at);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28 || !t) return null;
    slots.push({ ...t, dayOfMonth });
  }
  return slots;
}
