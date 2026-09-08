/**
 * Shared helpers for the bulk-import template/parse pipeline (members,
 * churches, categories, items — one module each, same mechanics).
 */
import ExcelJS from 'exceljs';

export function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B36AD' } };
  });
}

/** Reads a cell's value as plain text, regardless of how ExcelJS represents it. */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'richText' in value) {
    return (value as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
  }
  if (typeof value === 'object' && 'text' in value) {
    return String((value as { text: unknown }).text ?? '');
  }
  if (typeof value === 'object' && 'result' in value) {
    return String((value as { result: unknown }).result ?? '');
  }
  return String(value).trim();
}

/** Locates the header row by content, so a stray blank row above it can't break parsing. */
export function findHeaderRow(sheet: ExcelJS.Worksheet, firstColumnHeader: string): number {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    if (cellText(sheet.getRow(r).getCell(1).value) === firstColumnHeader) return r;
  }
  return -1;
}
