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
import { errors } from '../../utils/errors.js';
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

// ---------------------------------------------------------------------------
// Consolidated results — every published item, one document
// ---------------------------------------------------------------------------

export async function consolidatedResultsReport(eventId: string, eventName: string, format: ReportFormat): Promise<ReportFile> {
  const publishedItems = await db
    .selectFrom('v_item_readiness')
    .select(['item_id', 'item_name', 'item_code'])
    .where('event_id', '=', eventId)
    .where('publication_state', '=', 'PUBLISHED')
    .orderBy('item_name')
    .execute();

  const results = await Promise.all(publishedItems.map((i) => getItemResult(i.item_id)));

  if (format === 'xlsx') {
    const buffer = await excelBuffer((workbook) => {
      for (const result of results) {
        const judgeNames = [...new Set(result.rows.flatMap((r) => r.judgeMarks.map((m) => m.judgeName)))].sort();
        const sheet = workbook.addWorksheet(result.item.code.slice(0, 31));
        sheet.addRow([`${result.item.name} (${result.item.code})`]);
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
      }
    });
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'consolidated-results.xlsx' };
  }

  const content: Content[] = [
    { text: eventName, style: 'subtitle' },
    { text: 'Consolidated Results', style: 'title' },
    { text: `${results.length} published item(s)`, style: 'subtitle' },
  ];

  results.forEach((result, index) => {
    const judgeNames = [...new Set(result.rows.flatMap((r) => r.judgeMarks.map((m) => m.judgeName)))].sort();
    const tableBody: TableCell[][] = [
      ['Pos', 'Chest', 'Participant', 'Church', ...judgeNames, 'Agg', 'Grade', 'Pts'].map((t) => ({ text: t, style: 'tableHeader' })),
    ];
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
    content.push({ text: `${result.item.name} (${result.item.code})`, style: 'sectionHeader', pageBreak: index > 0 ? 'before' : undefined });
    content.push({
      table: { headerRows: 1, widths: ['auto', 'auto', '*', 'auto', ...judgeNames.map(() => 'auto'), 'auto', 'auto', 'auto'], body: tableBody },
      layout: 'lightHorizontalLines',
    });
  });

  const buffer = await renderPdf({ content } as TDocumentDefinitions);
  return { buffer, contentType: 'application/pdf', filename: 'consolidated-results.pdf' };
}

// ---------------------------------------------------------------------------
// Church detail sheet
// ---------------------------------------------------------------------------

export async function churchDetailSheet(churchId: string, eventId: string, eventName: string, format: ReportFormat): Promise<ReportFile> {
  const church = await db.selectFrom('churches').select(['id', 'name', 'short_code']).where('id', '=', churchId).executeTakeFirst();
  if (!church) throw errors.notFound('Church', churchId);

  const [standings, members] = await Promise.all([churchLeaderboard(eventId), individualStandings(eventId)]);
  const churchStanding = standings.find((s) => s.churchId === churchId) ?? null;
  const churchMembers = members.filter((m) => m.churchId === churchId).sort((a, b) => b.totalPoints - a.totalPoints);

  if (format === 'xlsx') {
    const buffer = await excelBuffer((workbook) => {
      const sheet = workbook.addWorksheet('Church Detail');
      sheet.addRow([eventName]);
      sheet.addRow([`${church.name} (${church.short_code})`]);
      if (churchStanding) {
        sheet.addRow([
          `Rank ${churchStanding.rank}${churchStanding.isTied ? ' (tied)' : ''} · ${churchStanding.totalPoints} points · ${churchStanding.firstPlaces} first(s), ${churchStanding.secondPlaces} second(s), ${churchStanding.thirdPlaces} third(s)`,
        ]);
      }
      sheet.addRow([]);
      const header = sheet.addRow(['Chest', 'Name', 'Category', 'Points', 'Items', '1st', '2nd', '3rd']);
      styleHeaderRow(header);
      for (const m of churchMembers) {
        sheet.addRow([m.chestNumber, m.fullName, m.categoryName ?? '—', m.totalPoints, m.itemsCompeted, m.firstPlaces, m.secondPlaces, m.thirdPlaces]);
      }
      sheet.columns.forEach((col) => (col.width = 16));
    });
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `church-detail-${church.short_code}.xlsx` };
  }

  const tableBody: TableCell[][] = [
    ['Chest', 'Name', 'Category', 'Points', 'Items', '1st', '2nd', '3rd'].map((t) => ({ text: t, style: 'tableHeader' })),
  ];
  for (const m of churchMembers) {
    tableBody.push([
      { text: m.chestNumber },
      { text: m.fullName },
      { text: m.categoryName ?? '—' },
      { text: String(m.totalPoints) },
      { text: String(m.itemsCompeted) },
      { text: String(m.firstPlaces) },
      { text: String(m.secondPlaces) },
      { text: String(m.thirdPlaces) },
    ]);
  }

  const content: Content[] = [
    { text: eventName, style: 'subtitle' },
    { text: `${church.name} (${church.short_code})`, style: 'title' },
  ];
  if (churchStanding) {
    content.push({
      text: `Rank ${churchStanding.rank}${churchStanding.isTied ? ' (tied)' : ''} · ${churchStanding.totalPoints} points · ${churchStanding.firstPlaces} first(s), ${churchStanding.secondPlaces} second(s), ${churchStanding.thirdPlaces} third(s)`,
      style: 'subtitle',
    });
  }
  content.push({ table: { headerRows: 1, widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'], body: tableBody }, layout: 'lightHorizontalLines' });

  const buffer = await renderPdf({ content } as TDocumentDefinitions);
  return { buffer, contentType: 'application/pdf', filename: `church-detail-${church.short_code}.pdf` };
}

// ---------------------------------------------------------------------------
// Participation list / call sheet
// ---------------------------------------------------------------------------

export async function participationListReport(itemId: string, eventName: string, format: ReportFormat): Promise<ReportFile> {
  const item = await db.selectFrom('items').select(['id', 'name', 'code', 'stage']).where('id', '=', itemId).executeTakeFirst();
  if (!item) throw errors.notFound('Item', itemId);

  const rows = await db
    .selectFrom('registrations as r')
    .leftJoin('members as m', 'm.id', 'r.member_id')
    .innerJoin('churches as c', 'c.id', 'r.church_id')
    .select(['r.call_order', 'r.team_name', 'm.chest_number', 'm.full_name', 'c.name as church_name'])
    .where('r.item_id', '=', itemId)
    .where('r.status', '=', 'REGISTERED')
    .orderBy('r.call_order')
    .orderBy('m.chest_number_numeric')
    .execute();

  const safeName = item.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  if (format === 'xlsx') {
    const buffer = await excelBuffer((workbook) => {
      const sheet = workbook.addWorksheet('Call Sheet');
      sheet.addRow([eventName]);
      sheet.addRow([`${item.name} (${item.code}) — ${item.stage ?? 'Stage not set'}`]);
      sheet.addRow([]);
      const header = sheet.addRow(['#', 'Chest', 'Participant', 'Church']);
      styleHeaderRow(header);
      rows.forEach((r, i) => {
        sheet.addRow([r.call_order ?? i + 1, r.chest_number ?? '—', r.full_name ?? r.team_name ?? 'Unknown', r.church_name]);
      });
      sheet.columns.forEach((col) => (col.width = 20));
    });
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `call-sheet-${safeName}.xlsx` };
  }

  const tableBody: TableCell[][] = [['#', 'Chest', 'Participant', 'Church'].map((t) => ({ text: t, style: 'tableHeader' }))];
  rows.forEach((r, i) => {
    tableBody.push([
      { text: String(r.call_order ?? i + 1) },
      { text: r.chest_number ?? '—' },
      { text: r.full_name ?? r.team_name ?? 'Unknown' },
      { text: r.church_name },
    ]);
  });

  const content: Content[] = [
    { text: eventName, style: 'subtitle' },
    { text: `${item.name} (${item.code})`, style: 'title' },
    { text: item.stage ?? 'Stage not set', style: 'subtitle' },
    { table: { headerRows: 1, widths: ['auto', 'auto', '*', '*'], body: tableBody }, layout: 'lightHorizontalLines' },
  ];

  const buffer = await renderPdf({ content } as TDocumentDefinitions);
  return { buffer, contentType: 'application/pdf', filename: `call-sheet-${safeName}.pdf` };
}

// ---------------------------------------------------------------------------
// Certificates — one per placed (1st/2nd/3rd) participant in an item
// ---------------------------------------------------------------------------

/**
 * A4 landscape usable content box once the certificate's own 40pt margins
 * are applied — used to size the border frame and the full-width rules so
 * every measurement is a real number, not a guess (841.89 x 595.28 is
 * pdfmake's own A4-landscape point size).
 */
const CERT_MARGIN = 40;
const CERT_CONTENT_WIDTH = 841.89 - CERT_MARGIN * 2;
const CERT_CONTENT_HEIGHT = 595.28 - CERT_MARGIN * 2;
const CERT_INK = '#1b2130';
const CERT_ACCENT = '#3b36ad';
const CERT_GOLD = '#b8892b';
const CERT_MUTED = '#6b7280';

function certificateBorder(): Content {
  // Absolutely positioned to the page margin, drawn first, independent of
  // everything that flows after it — a double frame (indigo outer, gold
  // inner) is what actually reads as "certificate" rather than "memo".
  return {
    canvas: [
      { type: 'rect', x: 0, y: 0, w: CERT_CONTENT_WIDTH, h: CERT_CONTENT_HEIGHT, r: 6, lineColor: CERT_ACCENT, lineWidth: 2 },
      { type: 'rect', x: 10, y: 10, w: CERT_CONTENT_WIDTH - 20, h: CERT_CONTENT_HEIGHT - 20, r: 3, lineColor: CERT_GOLD, lineWidth: 0.75 },
    ],
    absolutePosition: { x: CERT_MARGIN, y: CERT_MARGIN },
  };
}

function certificateRule(marginTop: number, marginBottom: number): Content {
  // Full width, so centering it is free — no coordinate guessing needed,
  // unlike a short centered rule would require.
  return {
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: CERT_CONTENT_WIDTH, y2: 0, lineWidth: 0.75, lineColor: CERT_GOLD }],
    margin: [0, marginTop, 0, marginBottom],
  };
}

export async function certificatesReport(itemId: string, eventName: string): Promise<ReportFile> {
  const result = await getItemResult(itemId);
  const placed = result.rows.filter((r) => r.placed && r.position !== null && r.position <= 3);
  const safeName = result.item.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  if (placed.length === 0) {
    throw errors.validation(`"${result.item.name}" has no placed results yet — nothing to certify.`);
  }

  const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
  const today = new Date().toLocaleDateString('en-IN', { dateStyle: 'long' });

  const content: Content[] = placed.map((row, index) => ({
    // The 24pt horizontal margin insets the flowing content clear of the
    // inner gold border (itself inset 10pt from the frame) — absolutePosition
    // on certificateBorder() is relative to the page, not this stack, so the
    // border itself is unaffected by this margin and stays frame-accurate.
    margin: [24, 0, 24, 0],
    stack: [
      certificateBorder(),
      { text: eventName.toUpperCase(), font: 'Helvetica', bold: true, fontSize: 10, color: CERT_GOLD, alignment: 'center', margin: [0, 58, 0, 0] },
      { text: 'Certificate of Achievement', font: 'Times', bold: true, fontSize: 27, color: CERT_ACCENT, alignment: 'center', margin: [0, 6, 0, 0] },
      certificateRule(14, 16),
      { text: 'This certifies that', font: 'Helvetica', italics: true, fontSize: 11, color: CERT_MUTED, alignment: 'center' },
      { text: row.participantName, font: 'Times', bold: true, fontSize: 30, color: CERT_INK, alignment: 'center', margin: [0, 8, 0, 4] },
      ...(row.churchName ? [{ text: row.churchName, font: 'Helvetica', fontSize: 11, color: CERT_MUTED, alignment: 'center' } as Content] : []),
      {
        text: [
          { text: 'has secured the ', font: 'Times', fontSize: 14, color: CERT_INK },
          { text: `${ordinal(row.position!)} position`, font: 'Times', bold: true, fontSize: 17, color: CERT_GOLD },
          { text: ' in ', font: 'Times', fontSize: 14, color: CERT_INK },
          { text: `"${result.item.name}"`, font: 'Times', italics: true, fontSize: 14, color: CERT_INK },
        ],
        alignment: 'center',
        margin: [50, 18, 50, 0],
      },
      ...(row.grade
        ? [{ text: `Grade ${row.grade}`, font: 'Helvetica', fontSize: 10, color: CERT_MUTED, alignment: 'center', margin: [0, 6, 0, 0] } as Content]
        : []),
      // Anchored to the frame's bottom edge by absolute position rather than
      // a guessed margin-top after the content above — that leaves the
      // footer's placement correct regardless of how tall the name/church/
      // sentence block above happens to render for a given certificate.
      {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: CERT_CONTENT_WIDTH - 48, y2: 0, lineWidth: 0.75, lineColor: CERT_GOLD }],
        absolutePosition: { x: CERT_MARGIN + 24, y: CERT_MARGIN + CERT_CONTENT_HEIGHT - 55 },
      },
      {
        columns: [
          { width: '*', text: result.item.code, font: 'Helvetica', fontSize: 8.5, color: CERT_MUTED },
          { width: '*', text: today, font: 'Helvetica', fontSize: 8.5, color: CERT_MUTED, alignment: 'right' },
        ],
        absolutePosition: { x: CERT_MARGIN + 24, y: CERT_MARGIN + CERT_CONTENT_HEIGHT - 44 },
        // Columns need an explicit width to lay out against — the frame's
        // inner content width, minus the same inset used everywhere else.
        width: CERT_CONTENT_WIDTH - 48,
      },
    ],
    pageBreak: index < placed.length - 1 ? 'after' : undefined,
  }));

  const buffer = await renderPdf({
    pageOrientation: 'landscape',
    pageMargins: [CERT_MARGIN, CERT_MARGIN, CERT_MARGIN, CERT_MARGIN],
    content,
  } as TDocumentDefinitions);

  return { buffer, contentType: 'application/pdf', filename: `certificates-${safeName}.pdf` };
}

// ---------------------------------------------------------------------------
// Badge sheet — printable name badges, laid out for cutting
// ---------------------------------------------------------------------------

export async function badgeSheetReport(eventId: string, eventName: string): Promise<ReportFile> {
  const members = await db
    .selectFrom('members as m')
    .innerJoin('churches as c', 'c.id', 'm.church_id')
    .select(['m.chest_number', 'm.full_name', 'c.name as church_name'])
    .where('m.event_id', '=', eventId)
    .where('m.is_active', '=', true)
    .orderBy('m.chest_number_numeric')
    .execute();

  const badge = (m: (typeof members)[number]): Content => ({
    table: {
      widths: ['*'],
      body: [
        [
          {
            stack: [
              { text: eventName, fontSize: 8, color: '#888888', alignment: 'center' },
              { text: m.chest_number, fontSize: 28, bold: true, alignment: 'center', margin: [0, 6, 0, 4] },
              { text: m.full_name, fontSize: 13, bold: true, alignment: 'center' },
              { text: m.church_name, fontSize: 10, color: '#555555', alignment: 'center', margin: [0, 2, 0, 0] },
            ],
            margin: [8, 10, 8, 10],
          },
        ],
      ],
    },
    layout: { hLineColor: () => '#3b36ad', vLineColor: () => '#3b36ad', hLineWidth: () => 1, vLineWidth: () => 1 },
  });

  // Two columns of badges, one badge per row cell — no barcode/QR (no such
  // library is installed in this build; FSD ADM-05-08 lists it as optional).
  const rows: Content[] = [];
  for (let i = 0; i < members.length; i += 2) {
    const left = members[i]!;
    const right = members[i + 1];
    rows.push({
      columns: [
        { width: '50%', stack: [badge(left)] },
        { width: '50%', stack: right ? [badge(right)] : [] },
      ],
      columnGap: 12,
      margin: [0, 0, 0, 12],
    });
  }

  const buffer = await renderPdf({ content: rows } as TDocumentDefinitions);
  return { buffer, contentType: 'application/pdf', filename: 'badge-sheet.pdf' };
}
