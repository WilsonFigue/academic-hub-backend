// Qué actividades puede atender el agente de tareas. Regla dura: nunca exámenes ni evaluaciones en línea.
// La guía de ejercicios o el repaso para un examen SÍ es una actividad. Ver docs/HOMEWORK_AGENT_RULES.md (R2).

const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Palabras que delatan una evaluación. */
const EXAM_WORDS = /\b(examen|examenes|parcial|diferido|cuestionario|quiz|prueba|control de lectura|evaluacion en linea)\b/;
/** Palabras que delatan una actividad de entrega (aunque Blackboard la guarde como Test). */
const ACTIVITY_WORDS = /\b(entrega|entregar|tarea|guia|ejercicios|taller|proyecto|actividad|foro|laboratorio|informe|ensayo)\b/;
/** Categorías de Blackboard que son actividades por sí mismas. */
const ACTIVITY_CATEGORIES = /^(homework|assignment|discussion|journal|blog|wiki|lti|survey|portfolio)/i;
const TEST_CATEGORIES = /^(test|exam)/i;

export type ActivityKind = 'activity' | 'exam';

/** categoryTitle es el `category_title` de la columna del libro de calificaciones (p. ej. "Homework.name", "Test.name"). */
export function classifyActivity(categoryTitle: string | null, name: string): { kind: ActivityKind; reason: string } {
  const category = (categoryTitle ?? '').trim();
  const text = norm(name);
  if (ACTIVITY_CATEGORIES.test(category)) return { kind: 'activity', reason: `categoría ${category}` };
  if (TEST_CATEGORIES.test(category)) {
    // Un "Test" cuyo nombre habla de entrega o tarea y no de examen es una entrega (p. ej. "Entrega tercera actividad").
    if (ACTIVITY_WORDS.test(text) && !EXAM_WORDS.test(text)) return { kind: 'activity', reason: 'entrega guardada como Test' };
    return { kind: 'exam', reason: `categoría ${category}` };
  }
  // Categoría desconocida: decide el nombre; ante la duda real, se bloquea.
  if (EXAM_WORDS.test(text) && !ACTIVITY_WORDS.test(text)) return { kind: 'exam', reason: 'nombre de examen' };
  if (ACTIVITY_WORDS.test(text) && !EXAM_WORDS.test(text)) return { kind: 'activity', reason: 'nombre de actividad' };
  return { kind: 'exam', reason: 'sin categoría clara' };
}
