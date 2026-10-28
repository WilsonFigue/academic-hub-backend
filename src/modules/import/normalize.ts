import { createHash } from 'node:crypto';
import { isObject, str, type Json } from '../blackboard/gateway.js';

/** Fecha ISO o epoch ms → Date; cualquier otra cosa → null. */
export function toDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Texto de un campo Blackboard que puede ser string u objeto {rawText, displayText}. */
export function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isObject(value)) return str(value.rawText) ?? str(value.displayText) ?? null;
  return null;
}

const ALLOWED_TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'code', 'pre', 'span', 'div', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th']);

/**
 * Sanitizado por lista blanca: conserva solo etiquetas seguras sin atributos (salvo href https en <a>).
 * Elimina scripts, estilos, iframes, manejadores de eventos y URLs javascript:.
 */
export function sanitizeHtml(html: string | null): string | null {
  if (!html) return null;
  const cleaned = html
    .replace(/<(script|style|iframe|object|embed|noscript)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (tag, name: string, attributes: string) => {
      const lower = name.toLowerCase();
      if (!ALLOWED_TAGS.has(lower)) return '';
      if (tag.startsWith('</')) return `</${lower}>`;
      if (lower === 'a') {
        const href = /href\s*=\s*"(https:\/\/[^"]*)"/i.exec(attributes)?.[1];
        return href ? `<a href="${href.replace(/"/g, '&quot;')}" rel="noopener noreferrer" target="_blank">` : '<a>';
      }
      return `<${lower}>`;
    });
  return cleaned.trim() || null;
}

export function htmlToText(html: string | null): string | null {
  if (!html) return null;
  const value = html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return value || null;
}

/** Hash de los campos de negocio normalizados (no del JSON crudo, para ignorar campos volátiles). */
export function businessHash(fields: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(fields)).digest();
}

export function attemptIds(grade: Json): string[] {
  return [...new Set([grade.lastAttemptId, grade.firstAttemptId, grade.highestAttemptId].map(str).filter((id): id is string => Boolean(id)))];
}
