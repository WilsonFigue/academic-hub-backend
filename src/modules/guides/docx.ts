// Guía de estudio en Word: mismo contenido que el PDF, con el estilo sobrio de los documentos de las tareas.
import { buildDocx, type Block, type DocumentSpec } from '../homework/document.js';
import type { GuidePdfSource } from './guides.js';

const stepNumber = /^\s*\d+[.)]\s*/;

export async function guideDocx(source: GuidePdfSource): Promise<Buffer> {
  const blocks: Block[] = [{ tipo: 'parrafo', texto: `**${source.content.summary}**` }];
  for (const section of source.content.sections) {
    blocks.push({ tipo: 'seccion', titulo: section.heading });
    for (const line of section.body.split(/\n+/).map((l) => l.trim()).filter(Boolean)) blocks.push({ tipo: 'parrafo', texto: line });
    const bullets = section.bullets ?? [];
    if (bullets.length > 0) {
      const numbered = bullets.every((b) => stepNumber.test(b));
      blocks.push({ tipo: 'lista', items: numbered ? bullets.map((b) => b.replace(stepNumber, '')) : bullets, numerada: numbered });
    }
  }
  if (source.content.sources.length > 0) {
    blocks.push({ tipo: 'seccion', titulo: 'Fuentes' }, { tipo: 'lista', items: source.content.sources.map((s) => (s.note ? `${s.file}: ${s.note}` : s.file)) });
  }
  const spec: DocumentSpec = { nombre_archivo: 'guia', titulo: `Guía de estudio · ${source.title}`, bloques: blocks };
  return buildDocx(spec, new Map(), null);
}
