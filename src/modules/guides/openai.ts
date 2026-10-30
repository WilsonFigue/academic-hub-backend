// Generador de guías de estudio con la API de OpenAI (Chat Completions con salida estructurada).
// - Solo se envía el texto armado en material.ts (instrucciones de la actividad y archivos de la materia). Nunca notas, datos personales ni credenciales.
// - Una sola llamada por guía y sin reintentos automáticos: un fallo no se cobra dos veces.
// - El costo real sale de los tokens que reporta la API y de los precios configurados.
import type { Queryable } from '../../database/connection.js';
import { GuideError, type GuideContent, type GuideGenerator, type GuideRequest, type GuideResult } from './guides.js';
import { logAiUsage } from '../logs/logs.js';
import { gatherMaterial, type FileStore, type Material } from './material.js';

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  priceInPerM: number;
  priceOutPerM: number;
  maxInputChars: number;
  db: Queryable;
  store: FileStore;
  /** none | low | medium | high. Sin valor, el del modelo. */
  reasoningEffort?: string;
  timeoutMs?: number;
  /** Para pruebas: reemplaza fetch. */
  fetchImpl?: typeof fetch;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'sections', 'sources'],
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['heading', 'body', 'bullets'],
        properties: { heading: { type: 'string' }, body: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } },
      },
    },
    sources: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['file', 'note'], properties: { file: { type: 'string' }, note: { type: 'string' } } },
    },
  },
} as const;

export const SYSTEM_PROMPT = `Eres un tutor universitario que prepara una GUÍA DE ESTUDIO para que un estudiante ENTIENDA una actividad de su materia.
Reglas:
- Usa SOLO el material que se te entrega (instrucciones de la actividad y archivos de la materia). No inventes datos, fórmulas, fechas ni citas. Si algo importante no está en el material, dilo en una sección "Lo que el material no cubre".
- Ayuda a entender, no a resolver: explica qué piden, los conceptos necesarios y cómo abordar el problema paso a paso, con ejemplos tomados del material. NO des la respuesta final de la actividad ni resuelvas lo que se va a calificar.
- Escribe en español claro, para un estudiante universitario, con tono cercano y directo. Frases cortas.
- Cita siempre de qué archivo sale cada idea (por ejemplo: "según «3. LA CIRCUNFERENCIA.pdf»").
- Estructura sugerida: "Qué te piden", "Conceptos que necesitas" (con viñetas), "Cómo abordarla paso a paso", "Ejemplo del material", "Antes de entregar" (lista de verificación) y, si aplica, "Lo que el material no cubre".
- Extensión total aproximada: entre 600 y 1000 palabras. Si la actividad es un examen o evaluación, enfócate en qué repasar y no en resolver nada.
- En "sources" lista solo los archivos que realmente usaste, con el nombre exacto con que se te entregaron y una nota breve de para qué sirvieron.`;

export function buildUserPrompt(material: Material): string {
  const due = material.activity.dueAt ? new Date(material.activity.dueAt).toLocaleDateString('es-SV', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/El_Salvador' }) : 'sin fecha';
  const head = [
    `Materia: ${material.course}`,
    `Actividad: ${material.activity.name}`,
    material.activity.category ? `Tipo: ${material.activity.category}` : null,
    material.activity.points !== null ? `Puntaje máximo: ${material.activity.points}` : null,
    `Fecha de entrega: ${due}`,
  ].filter(Boolean).join('\n');
  const docs = material.docs.map((doc, index) =>
    `=== MATERIAL ${index + 1}: «${doc.title}» (${doc.role === 'guia' ? 'archivo de la misma carpeta que la actividad' : doc.role === 'instrucciones' ? 'instrucciones' : 'clase o documento relacionado'})${doc.truncated ? ' [recortado]' : ''} ===\n${doc.text}`).join('\n\n');
  return `${head}\n\nMaterial disponible:\n\n${docs || '(no hay material de la materia relacionado con esta actividad)'}\n\nPrepara la guía de estudio de esta actividad.`;
}

const asString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Valida la salida del modelo y descarta lo que no cumpla la forma esperada. */
export function parseGuide(raw: string, material: Material): GuideContent {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new GuideError('bad_output'); }
  if (typeof data !== 'object' || data === null) throw new GuideError('bad_output');
  const record = data as Record<string, unknown>;
  const sections = (Array.isArray(record.sections) ? record.sections : []).flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const section = value as Record<string, unknown>;
    const heading = asString(section.heading);
    const body = asString(section.body);
    const bullets = (Array.isArray(section.bullets) ? section.bullets : []).map(asString).filter(Boolean);
    return heading && (body || bullets.length > 0) ? [{ heading, body, ...(bullets.length > 0 ? { bullets } : {}) }] : [];
  });
  const summary = asString(record.summary);
  if (!summary || sections.length === 0) throw new GuideError('bad_output');
  // Las fuentes solo pueden ser archivos que de verdad se enviaron.
  const known = new Map(material.docs.map((doc) => [doc.title.toLowerCase(), doc.title]));
  const sources = (Array.isArray(record.sources) ? record.sources : []).flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const source = value as Record<string, unknown>;
    const title = known.get(asString(source.file).toLowerCase());
    return title ? [{ file: title, ...(asString(source.note) ? { note: asString(source.note) } : {}) }] : [];
  });
  return { summary, sections, sources };
}

export interface OpenAIGenerator extends GuideGenerator {
  /** Arma el material y calcula el tamaño sin llamar a OpenAI (prueba en seco). */
  describe(request: GuideRequest): Promise<{ material: Material; prompt: string; estimatedInputTokens: number; estimatedCostUsd: number }>;
}

export function createOpenAIGenerator(options: OpenAIOptions): OpenAIGenerator {
  const doFetch = options.fetchImpl ?? fetch;
  const estimate = (chars: number) => Math.ceil(chars / 3.2);   // ~3.2 caracteres por token en español: estimación conservadora

  async function describe(request: GuideRequest) {
    const material = await gatherMaterial(options.db, options.store, request, options.maxInputChars);
    const prompt = buildUserPrompt(material);
    const estimatedInputTokens = estimate(SYSTEM_PROMPT.length + prompt.length);
    // Salida estimada: ~1500 tokens de guía (los modelos de razonamiento pueden gastar más).
    return { material, prompt, estimatedInputTokens, estimatedCostUsd: (estimatedInputTokens * options.priceInPerM + 1500 * options.priceOutPerM) / 1_000_000 };
  }

  return {
    configured: true,
    describe,
    async generate(request: GuideRequest): Promise<GuideResult> {
      const { material, prompt } = await describe(request);
      if (material.docs.length === 0) throw new GuideError('no_material', 'No hay material de la materia relacionado con esta actividad.');
      let response: Response;
      const started = Date.now();
      const base = { event: 'call' as const, feature: 'study_guide' as const, runId: request.guideId, enrollmentId: request.enrollmentId, courseId: request.courseId, gradebookColumnId: request.gradebookColumnId, model: options.model, turn: 1 };
      try {
        response = await doFetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({
            model: options.model,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
            response_format: { type: 'json_schema', json_schema: { name: 'guia_de_estudio', strict: true, schema: SCHEMA } },
            max_completion_tokens: 16_000,
            ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
            user: `guide-${request.guideId}`,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
        });
      } catch (error) {
        const code = (error as Error)?.name === 'TimeoutError' ? 'openai_timeout' : 'openai_network';
        await logAiUsage(options.db, { ...base, durationMs: Date.now() - started, status: 'error', errorCode: code });
        throw new GuideError(code);
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
        const code = response.status === 401 ? 'openai_auth' : response.status === 429 ? (failure.error?.code === 'insufficient_quota' ? 'openai_no_credit' : 'openai_rate_limit') : response.status >= 500 ? 'openai_unavailable' : `openai_http_${response.status}`;
        await logAiUsage(options.db, { ...base, durationMs: Date.now() - started, status: 'error', errorCode: code, detail: { http: response.status, message: failure.error?.message?.slice(0, 300) } });
        throw new GuideError(code);
      }
      const body = await response.json() as {
        choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const message = body.choices?.[0]?.message;
      if (message?.refusal) throw new GuideError('ai_refused');
      const inputTokens = body.usage?.prompt_tokens ?? 0;
      const outputTokens = body.usage?.completion_tokens ?? 0;
      const costUsd = Math.round(((inputTokens * options.priceInPerM + outputTokens * options.priceOutPerM) / 1_000_000) * 100_000) / 100_000;
      // Los tokens ya se gastaron aunque la salida no sirva: se registra antes de validarla.
      await logAiUsage(options.db, { ...base, model: body.model ?? options.model, inputTokens, outputTokens, costUsd, durationMs: Date.now() - started, status: 'ok' });
      const content = parseGuide(message?.content ?? '', material);
      return { content, model: body.model ?? options.model, inputTokens, outputTokens, costUsd };
    },
  };
}
