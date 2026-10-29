// Ver Word, PowerPoint y Excel "tal cual": se convierten a PDF con el Office instalado en este equipo (Windows) y el PDF se muestra con el
// visor del navegador. Todo local: ningún archivo sale a un servicio externo. Si Office no está disponible, la app usa su vista de texto.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type OfficeKind = 'word' | 'powerpoint' | 'excel';
export interface OfficeFormat { kind: OfficeKind; ext: 'docx' | 'doc' | 'pptx' | 'ppt' | 'xlsx' | 'xls'; legacy: boolean }

const MIME: Record<string, OfficeFormat> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'word', ext: 'docx', legacy: false },
  'application/msword': { kind: 'word', ext: 'doc', legacy: true },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'powerpoint', ext: 'pptx', legacy: false },
  'application/vnd.ms-powerpoint': { kind: 'powerpoint', ext: 'ppt', legacy: true },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'excel', ext: 'xlsx', legacy: false },
  'application/vnd.ms-excel': { kind: 'excel', ext: 'xls', legacy: true },
};
const BY_EXT: Record<string, OfficeFormat> = Object.fromEntries(Object.values(MIME).map((format) => [format.ext, format]));

/** Formato de Office de un archivo (por tipo o por extensión); null si no es de Office. Los formatos con macros (.docm, .xlsm…) no se convierten. */
export function officeFormat(mimeType: string, fileName: string): OfficeFormat | null {
  return MIME[mimeType] ?? BY_EXT[/\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? ''] ?? null;
}

const SCRIPT = join(process.cwd(), 'src', 'modules', 'files', 'office', 'convert.ps1');
const OFFICE_DIRS = ['C:\\Program Files\\Microsoft Office\\root\\Office16', 'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16', 'C:\\Program Files\\Microsoft Office\\Office16'];
const EXE: Record<OfficeKind, string> = { word: 'WINWORD.EXE', powerpoint: 'POWERPNT.EXE', excel: 'EXCEL.EXE' };

/** ¿Hay Office instalado para convertir este tipo de documento? (solo Windows con Office 2016 o posterior) */
export function officeAvailable(kind: OfficeKind): boolean {
  if (process.platform !== 'win32' || !existsSync(SCRIPT)) return false;
  return OFFICE_DIRS.some((dir) => existsSync(join(dir, EXE[kind])));
}

export type ConvertResult = 'ok' | 'unavailable' | 'shared_instance_legacy' | 'failed';

// Una conversión a la vez: Office no es reentrante y así no se amontonan procesos.
let chain: Promise<unknown> = Promise.resolve();
const TIMEOUT_MS = 180_000;

/** Convierte `input` (copia local sin extensión) a PDF en `output`. Se trabaja sobre una copia temporal; el original no se toca. */
export function convertToPdf(input: string, format: OfficeFormat, output: string): Promise<ConvertResult> {
  const job = chain.then(() => run(input, format, output), () => run(input, format, output));
  chain = job.catch(() => undefined);
  return job;
}

function run(input: string, format: OfficeFormat, output: string): Promise<ConvertResult> {
  if (!officeAvailable(format.kind)) return Promise.resolve('unavailable');
  const dir = join(tmpdir(), 'ah-render');
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const copy = join(dir, `${id}.${format.ext}`);
  const part = join(dir, `${id}.pdf`);
  copyFileSync(input, copy);
  return new Promise<ConvertResult>((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Kind', format.kind, '-In', copy, '-Out', part];
    if (format.legacy) args.push('-Legacy');
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const finish = (result: ConvertResult) => {
      clearTimeout(timer);
      rmSync(copy, { force: true });
      if (result === 'ok') {
        try { renameSync(part, output); } catch { rmSync(part, { force: true }); resolve('failed'); return; }
      } else rmSync(part, { force: true });
      resolve(result);
    };
    child.on('error', () => finish('failed'));
    child.on('close', (code) => {
      if (code === 0 && existsSync(part) && statSync(part).size > 0) finish('ok');
      else finish(/shared_instance_legacy/.test(stderr) ? 'shared_instance_legacy' : 'failed');
    });
  });
}
