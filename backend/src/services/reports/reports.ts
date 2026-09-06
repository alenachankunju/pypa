/**
 * Report data shaping and document generation (FSD 5.13).
 *
 * Each report is fetched through the same services the on-screen result
 * views already use — churchLeaderboard(), individualStandings(),
 * getItemResult() — so a printed figure can never drift from what the
 * console shows for the same data.
 */
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import ExcelJS from 'exceljs';
import { db } from '../../db/pool.js';
import { getItemResult } from '../results/itemResults.js';
import { publicationSummary } from '../results/publication.js';
import { categoryChampions, churchLeaderboard, individualStandings } from '../results/standings.js';
import { renderPdf } from './pdf.js';

export type ReportFormat = 'pdf' | 'xlsx';

interface ReportFile {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

async function excelBuffer(build: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PYPA Marking System';
  workbook.created = new Date();
  build(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B36AD' } };
  });
}

// ---------------------------------------------------------------------------
// Item result sheet
// ---------------------------------------------------------------------------

export async function itemResultSheet(itemId: string, eventName: string, format: ReportFormat): Promise<ReportFile> {
  const result = await getItemResult(itemId);
  const judgeNames = [...new Set(result.rows.flatMap((r) => r.judgeMarks.map((m) => m.judgeName)))].sort();
  const safeName = result.item.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  if (format === 'xlsx') {
    const buffer = await excelBuffer((workbook) => {
      const sheet = workbook.addWorksheet('Item Result');
      sheet.addRow([eventName]);
      sheet.addRow([`${result.item.name} (${result.item.code})`]);
      sheet.addRow([`State: ${result.publication.state} · Published: ${formatDate(result.publication.publishedAt)}`]);
      sheet.addRow([]);
      const header = sheet.addRow(['Position', 'Chest', 'Participant', 'Church', ...judgeNames, 'Aggregate', 'Grade', 'Points']);
      styleHeaderRow(header);
      for (const row of result.rows) {
        const marksByJudge = new Map(row.judgeMarks.map((m) => [m.judgeName, m.mark]));
        sheet.addRow([
          row.isSharedPosition ? `${row.position}=` : (row.position ?? '—'),
          row.chestNumber ?? '—',
          row.participantName,
          row.churchName ?? '—',
          ...judgeNames.map((n) => marksByJudge.get(n) ?? ''),
          row.aggregate ?? '',
          row.grade ?? '',
          row.points,
        ]);
      }
      sheet.columns.forEach((col) => (col.width = 16));
    });
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `item-result-${safeName}.xlsx` };
  }

  const tableHeader: TableCell[] = ['Pos', 'Chest', 'Participant', 'Church', ...judgeNames, 'Agg', 'Grade', 'Pts'].map((t) => ({
    text: t,
    style: 'tableHeader',
  }));
  const tableBody: TableCell[][] = [tableHeader];
  for (const row of result.rows) {
    const marksByJudge = new Map(row.judgeMarks.map((m) => [m.judgeName, m.mark]));
    tableBody.push([
      { text: row.isSharedPosition ? `${row.position}=` : String(row.position ?? '—') },
      { text: row.chestNumber ?? '—' },
      { text: row.participantName },
      { text: row.churchName ?? '—' },
      ...judgeNames.map((n) => ({ text: String(marksByJudge.get(n) ?? '—') })),
      { text: row.aggregate?.toFixed(2) ?? '—' },
      { text: row.grade ?? '—' },
      { text: String(row.points) },
    ]);
  }

  const content: Content[] = [
    { text: eventName, style: 'subtitle' },
    { text: `${result.item.name} (${result.item.code})`, style: 'title' },
    { text: `State: ${result.publication.state} · Published: ${formatDate(result.publication.publishedAt)}`, style: 'subtitle' },
  ];
  if (result.publication.state !== 'PUBLISHED') {
    content.push({ text: 'PROVISIONAL — not yet published. Not for announcement.', style: 'watermark' });
  }
  content.push({
    table: { headerRows: 1, widths: ['auto', 'auto', '*', 'auto', ...judgeNames.map(() => 'auto'), 'auto', 'auto', 'auto'], body: tableBody },
    layout: 'lightHorizontalLines',
  });

  const buffer = await renderPdf({ content } as TDocumentDefinitions);
  return { buffer, contentType: 'application/pdf', filename: `item-result-${safeName}.pdf` };
}

// ---------------------------------------------------------------------------
// Church leaderboard
// ---------------------------------------------------------------------------

export async function churchLeaderboardReport(eventId: string, eventName: string, format: ReportFormat): Promise<ReportFile> {
  const [standings, summary] = await Promise.all([churchLeaderboard(eventId), publicationSummary(eventId)]);

  if (format === 'xlsx') {
    const buffer = await excelBuffer((workbook) => {
      const sheet = workbook.addWorksheet('Church Leaderboard');
      sheet.addRow([eventName]);
      sheet.addRow(['Church Leaderboard']);
      sheet.addRow([summary.unpublished > 0 ? `${summary.unpublished} item(s) still unpublished — provisional` : 'All items published']);
      sheet.addRow([]);
      const header = sheet.addRow(['Rank', 'Church', 'Code', 'Points', '1st', '2nd', '3rd', 'Members', 'Champion']);
      styleHeaderRow(header);
      for (const s of standings) {
        sheet.addRow([s.rank, s.churchName, s.shortCode, s.totalPoints, s.firstPlaces, s.secondPlaces, s.thirdPlaces, s.memberCount, s.isChampion ? 'Yes' : '']);
      }
      sheet.columns.forEach((col) => (col.width = 16));
    });
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'church-leaderboard.xlsx' };
  }

  const tableBody: TableCell[][] = [
    ['Rank', 'Church', 'Code', 'Points', '1st', '2nd', '3rd', 'Members'].map((t) => ({ text: t, style: 'tableHeader' })),
  ];
  for (const s of standings) {
    tableBody.push([
      { text: `${s.rank}${s.isTied ? ' =' : ''}` },
      { text: s.isChampion ? `${s.churchName} (Champion)` : s.churchName },
      { text: s.shortCode },
      { text: String(s.totalPoints) },
      { text: String(s.firstPlaces) },
      { text: String(s.secondPlaces) },
      { text: String(s.thirdPlaces) },
      { text: String(s.memberCount) },
    ]);
  }

  const content: Content[] = [
    { text: eventName, style: 'subtitle' },
    { text: 'Church Leaderboard', style: 'title' },
  ];
  if (summary.unpublished > 0) {
    content.push({ text: `PROVISIONAL — ${summary.unpublished} item(s) still unpublished. Not for announcement.`, style: 'watermark' });
  }
  content.push({
    table: { headerRows: 1, widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'], body: tableBody },
    layout: 'lightHorizontalLines',
  });

  const buffer = await renderPdf({ content } as TDocumentDefinitions);
  return { buffer, contentType: 'application/pdf', filename: 'church-leaderboard.pdf' };
}

// ---------------------------------------------------------------------------
// Individual champion sheet
// ---------------------------------------------------------------------------

export async function championSheet(eventId: string, eventName: string, format: ReportFormat): Promise<ReportFile> {
  const [standings, categories, summary] = await Promise.all([
    individualStandings(eventId, { limit: 25 }),
    categoryChampions(eventId),
    publicationSummary(eventId),
  ]);

  if (format === 'xlsx') {
    const buffer = await excelBuffer((workbook) => {
      const sheet = workbook.addWorksheet('Individual Champion');
      sheet.addRow([eventName]);
      sheet.addRow(['Individual Champion Sheet']);
      sheet.addRow([summary.unpublished > 0 ? `${summary.unpublished} item(s) still unpublished — provisional` : 'All items published']);
      sheet.addRow([]);
      const header = sheet.addRow(['Rank', 'Chest', 'Name', 'Church', 'Points', 'Items', 'Eligible', 'Champion']);
      styleHeaderRow(header);
      for (const m of standings) {
        sheet.addRow([m.rank, m.chestNumber, m.fullName, m.churchName, m.totalPoints, m.itemsCompeted, m.eligible ? 'Yes' : 'No', m.isChampion ? 'Yes' : '']);
      }
      sheet.addRow([]);
      const catHeader = sheet.addRow(['Category', 'Champion', 'Church', 'Points']);
      styleHeaderRow(catHeader);
      for (const c of categories) {
        sheet.addRow([c.categoryName, c.champion?.fullName ?? '—', c.champion?.churchName ?? '—', c.champion?.totalPoints ?? '']);
      }
      sheet.columns.forEach((col) => (col.width = 16));
    });
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'individual-champion.xlsx' };
  }

  const tableBody: TableCell[][] = [
    ['Rank', 'Chest', 'Name', 'Church', 'Points', 'Items', 'Eligible'].map((t) => ({ text: t, style: 'tableHeader' })),
  ];
  for (const m of standings) {
    tableBody.push([
      { text: String(m.rank) },
      { text: m.chestNumber },
      { text: m.isChampion ? `${m.fullName} (Champion)` : m.fullName },
      { text: m.churchName },
      { text: String(m.totalPoints) },
      { text: String(m.itemsCompeted) },
      { text: m.eligible ? 'Yes' : 'No' },
    ]);
  }

  const catBody: TableCell[][] = [['Category', 'Champion', 'Church', 'Points'].map((t) => ({ text: t, style: 'tableHeader' }))];
  for (const c of categories) {
    catBody.push([
      { text: c.categoryName },
      { text: c.champion?.fullName ?? '—' },
      { text: c.champion?.churchName ?? '—' },
      { text: c.champion ? String(c.champion.totalPoints) : '—' },
    ]);
  }

  const content: Content[] = [
    { text: eventName, style: 'subtitle' },
    { text: 'Individual Champion Sheet', style: 'title' },
  ];
  if (summary.unpublished > 0) {
    content.push({ text: `PROVISIONAL — ${summary.unpublished} item(s) still unpublished. Not for announcement.`, style: 'watermark' });
  }
  content.push({ table: { headerRows: 1, widths: ['auto', 'auto', '*', '*', 'auto', 'auto', 'auto'], body: tableBody }, layout: 'lightHorizontalLines' });
  if (categories.length > 0) {
    content.push({ text: 'Category Champions', style: 'sectionHeader' });
    content.push({ table: { headerRows: 1, widths: ['auto', '*', '*', 'auto'], body: catBody }, layout: 'lightHorizontalLines' });
  }

  const buffer = await renderPdf({ content } as TDocumentDefinitions);
  return { buffer, contentType: 'application/pdf', filename: 'individual-champion.pdf' };
}

// ---------------------------------------------------------------------------
// Judge activity report
// ---------------------------------------------------------------------------

interface JudgeActivityRow {
  judgeName: string;
  scoresSubmitted: number;
  scoresRevoked: number;
  outOfSequenceCount: number;
  averageMark: number | null;
  meanDeviation: number | null;
}

async function loadJudgeActivity(eventId: string): Promise<JudgeActivityRow[]> {
  const rows = await db
    .selectFrom('v_judge_activity')
    .select(['judge_name', 'scores_submitted', 'scores_revoked', 'out_of_sequence_count', 'average_mark', 'mean_deviation'])
    .where('event_id', '=', eventId)
    .orderBy('judge_name')
    .execute();

  return rows.map((r) => ({
    judgeName: r.judge_name,
    scoresSubmitted: Number(r.scores_submitted),
    scoresRevoked: Number(r.scores_revoked),
    outOfSequenceCount: Number(r.out_of_sequence_count),
    averageMark: r.average_mark === null ? null : Number(r.average_mark),
    meanDeviation: r.mean_deviation === null ? null : Number(r.mean_deviation),
  }));
}

export async function judgeActivityReport(eventId: string, eventName: string, format: ReportFormat): Promise<ReportFile> {
  const rows = await loadJudgeActivity(eventId);

  if (format === 'xlsx') {
    const buffer = await excelBuffer((workbook) => {
      const sheet = workbook.addWorksheet('Judge Activity');
      sheet.addRow([eventName]);
      sheet.addRow(['Judge Activity Report']);
      sheet.addRow([]);
      const header = sheet.addRow(['Judge', 'Submitted', 'Revoked', 'Out of sequence', 'Average mark', 'Mean deviation']);
      styleHeaderRow(header);
      for (const r of rows) {
        sheet.addRow([r.judgeName, r.scoresSubmitted, r.scoresRevoked, r.outOfSequenceCount, r.averageMark ?? '', r.meanDeviation ?? '']);
      }
      sheet.columns.forEach((col) => (col.width = 18));
    });
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'judge-activity.xlsx' };
  }

  const tableBody: TableCell[][] = [
    ['Judge', 'Submitted', 'Revoked', 'Out of sequence', 'Average mark', 'Mean deviation'].map((t) => ({ text: t, style: 'tableHeader' })),
  ];
  for (const r of rows) {
    tableBody.push([
      { text: r.judgeName },
      { text: String(r.scoresSubmitted) },
      { text: String(r.scoresRevoked) },
      { text: String(r.outOfSequenceCount) },
      { text: r.averageMark?.toFixed(2) ?? '—' },
      { text: r.meanDeviation !== null ? (r.meanDeviation > 0 ? `+${r.meanDeviation.toFixed(2)}` : r.meanDeviation.toFixed(2)) : '—' },
    ]);
  }

  const content: Content[] = [
    { text: eventName, style: 'subtitle' },
    { text: 'Judge Activity Report', style: 'title' },
    { text: 'Mean deviation is signed: positive means this judge marks above their panel.', style: 'subtitle' },
    { table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'], body: tableBody }, layout: 'lightHorizontalLines' },
  ];

  const buffer = await renderPdf({ content } as TDocumentDefinitions);
  return { buffer, contentType: 'application/pdf', filename: 'judge-activity.pdf' };
}
