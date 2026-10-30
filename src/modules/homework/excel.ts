// Herramienta «excel»: arma un libro .xlsx con fórmulas reales. Cada fórmula se recalcula aquí con un motor independiente:
// así el archivo trae sus resultados guardados y el modelo recibe los valores para comprobar que coinciden con lo que esperaba.
import ExcelJS from 'exceljs';
import { HyperFormula } from 'hyperformula';

export interface CellSpec {
  ref: string;
  valor?: string | number | boolean;
  formula?: string;
  formato?: 'entero' | 'decimal' | 'porcentaje' | 'texto';
  negrita?: boolean;
  /** encabezado: cabecera de tabla · dato: dato del enunciado (azul) · resultado: respuesta destacada · nota: aclaración */
  estilo?: 'encabezado' | 'dato' | 'resultado' | 'nota' | 'titulo';
  combinar?: string;
}
export interface SheetSpec { nombre: string; anchos?: number[]; celdas: CellSpec[] }
export interface WorkbookSpec { nombre_archivo: string; hojas: SheetSpec[] }

export interface WorkbookResult { buffer: Buffer; computed: Record<string, string | number | boolean>; errors: string[]; formulas: number }

const FORMATS: Record<string, string> = { entero: '0', decimal: '0.0000', porcentaje: '0.00%', texto: '@' };
const border = { style: 'thin' as const, color: { argb: 'FFD9D4C7' } };
const SHEET_NAME = /[\\/*?:[\]]/g;

function parseRef(ref: string): { col: number; row: number } {
  const m = /^([A-Z]{1,3})([1-9]\d{0,5})$/.exec(String(ref).toUpperCase());
  if (!m) throw new Error(`Referencia de celda no válida: «${ref}».`);
  let col = 0; for (const ch of m[1]!) col = col * 26 + ch.charCodeAt(0) - 64;
  return { col, row: Number(m[2]) };
}
const colName = (n: number) => { let s = ''; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };

export async function buildWorkbook(spec: WorkbookSpec): Promise<WorkbookResult> {
  const sheets = (Array.isArray(spec.hojas) ? spec.hojas : []).slice(0, 12);
  if (sheets.length === 0) throw new Error('El libro no tiene hojas.');
  const names = sheets.map((s, i) => (String(s.nombre ?? `Hoja${i + 1}`).replace(SHEET_NAME, ' ').trim().slice(0, 31) || `Hoja${i + 1}`));
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new Error('Los nombres de las hojas deben ser distintos.');

  // 1) Matriz de valores y fórmulas por hoja para el motor de cálculo.
  const data: Record<string, Array<Array<string | number | boolean | null>>> = {};
  sheets.forEach((sheet, i) => {
    const rows: Array<Array<string | number | boolean | null>> = [];
    for (const cell of (sheet.celdas ?? []).slice(0, 3000)) {
      const { col, row } = parseRef(cell.ref);
      rows[row - 1] ??= []; rows[row - 1]![col - 1] = cell.formula ? `=${String(cell.formula).replace(/^=/, '')}` : (cell.valor ?? null);
    }
    data[names[i]!] = Array.from(rows, (r) => r ?? []);
  });
  const hf = HyperFormula.buildFromSheets(data, { licenseKey: 'gpl-v3' });

  // 2) Libro de Excel con estilos y resultados guardados.
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Academic Hub (borrador con IA)';
  const computed: Record<string, string | number | boolean> = {}; const errors: string[] = []; let formulas = 0;
  sheets.forEach((sheet, i) => {
    const name = names[i]!; const sheetId = hf.getSheetId(name)!;
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });
    (sheet.anchos ?? []).slice(0, 30).forEach((w, c) => { if (Number.isFinite(w) && w > 0) ws.getColumn(c + 1).width = Math.min(w, 80); });
    for (const cell of (sheet.celdas ?? []).slice(0, 3000)) {
      const { col, row } = parseRef(cell.ref); const target = ws.getCell(row, col);
      if (cell.formula) {
        formulas += 1;
        const got = hf.getCellValue({ sheet: sheetId, row: row - 1, col: col - 1 });
        const result = typeof got === 'number' || typeof got === 'string' || typeof got === 'boolean' ? got : null;
        if (result === null) errors.push(`${name}!${cell.ref.toUpperCase()}: ${String((got as { value?: string } | null)?.value ?? 'error de fórmula')}`);
        else computed[`${name}!${cell.ref.toUpperCase()}`] = typeof result === 'number' ? Number(result.toPrecision(12)) : result;
        target.value = { formula: String(cell.formula).replace(/^=/, ''), result: result ?? undefined } as ExcelJS.CellFormulaValue;
      } else if (cell.valor !== undefined) target.value = cell.valor;
      if (cell.formato) target.numFmt = FORMATS[cell.formato] ?? 'General';
      target.alignment = { vertical: 'middle', wrapText: true, horizontal: typeof cell.valor === 'string' && !cell.formula ? 'left' : 'center' };
      if (cell.negrita) target.font = { ...target.font, bold: true };
      if (cell.estilo === 'encabezado') { target.font = { bold: true, color: { argb: 'FF7C2D12' } }; target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE3DA' } }; target.border = { top: border, left: border, bottom: border, right: border }; target.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; }
      else if (cell.estilo === 'dato') { target.font = { bold: true, color: { argb: 'FF1D4ED8' } }; target.border = { top: border, left: border, bottom: border, right: border }; }
      else if (cell.estilo === 'resultado') { target.font = { bold: true }; target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F2EC' } }; target.border = { top: border, left: border, bottom: border, right: border }; }
      else if (cell.estilo === 'nota') { target.font = { italic: true, color: { argb: 'FF5B6472' } }; target.alignment = { vertical: 'top', wrapText: true, horizontal: 'left' }; }
      else if (cell.estilo === 'titulo') { target.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }; target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF5A36' } }; target.alignment = { vertical: 'middle', indent: 1 }; }
      if (cell.combinar && /^[A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/i.test(cell.combinar)) { try { ws.mergeCells(cell.combinar.toUpperCase()); } catch { /* ya combinada */ } }
    }
  });
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, computed, errors, formulas };
}

export { colName };
