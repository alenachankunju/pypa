/**
 * Bulk member import (FSD 5.5 ADM-05-07, schema in migration 0008_operations.sql).
 *
 * Two phases, matching the migration's own comment: "nothing is written until
 * the administrator reviews the preview." POST /import/preview stages every row
 * into import_batches/import_rows and reports per-row errors without touching
 * the members table; POST /import/:batchId/commit then creates a member for
 * every row that was VALID at preview time (re-checked, since another admin may
 * have created a clashing chest number in between).
 *
 * The downloadable template (GET /import/template) carries the event's current
 * church list twice over: as a visible reference sheet a person can read before
 * typing, and as the source range for an in-cell dropdown on the Church column,
 * so a typo either becomes an Excel-level "not in the list" refusal or, if
 * pasted in anyway, a named error in the preview rather than a silent bad row.
 */
import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import { deriveCategory, type CategoryBand } from '../../services/eligibility.js';
import { AppError, errors } from '../../utils/errors.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

const HEADERS = {
  chestNumber: 'Chest Number',
  fullName: 'Full Name',
  dateOfBirth: 'Date of Birth (YYYY-MM-DD)',
  gender: 'Gender',
  church: 'Church',
  mobile: 'Mobile',
  notes: 'Notes',
} as const;

const COLUMN_WIDTHS = [16, 28, 24, 12, 30, 16, 30];
const TEMPLATE_DATA_ROWS = 500;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
});

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B36AD' } };
  });
}

interface RowError {
  field: string;
  code: string;
  message: string;
}
interface RowWarning {
  field: string;
  message: string;
}
interface NormalisedMember {
  chestNumber: string;
  fullName: string;
  dateOfBirth: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  churchId: string;
  churchName: string;
  categoryId: string | null;
  categoryName: string | null;
  mobile: string | null;
  notes: string | null;
}
interface StagedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  normalised: NormalisedMember | null;
  errors: RowError[];
  warnings: RowWarning[];
  status: 'VALID' | 'INVALID';
}

export function memberImportRoutes(): Router {
  const router = Router();

  /**
   * The template. Churches are global master data (not event-scoped), so the
   * same reference list applies regardless of which event is active.
   */
  router.get(
    '/template',
    requireCapability(Capability.MANAGE_MEMBERS),
    asyncHandler(async (_req, res) => {
      const churches = await db.selectFrom('churches').select(['name', 'short_code']).orderBy('name').execute();

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'PYPA Marking System';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Members');
      sheet.mergeCells('A1:G1');
      const instructions = sheet.getCell('A1');
      instructions.value =
        'One row per member. Do not rename or reorder the columns. Church must be picked from the dropdown ' +
        '(or typed to match the "Valid Values" sheet exactly) — see that sheet for the current list.';
      instructions.font = { italic: true, color: { argb: 'FF6B7280' } };
      instructions.alignment = { wrapText: true, vertical: 'top' };
      sheet.getRow(1).height = 32;

      const header = sheet.addRow([
        HEADERS.chestNumber,
        HEADERS.fullName,
        HEADERS.dateOfBirth,
        HEADERS.gender,
        HEADERS.church,
        HEADERS.mobile,
        HEADERS.notes,
      ]);
      styleHeaderRow(header);
      sheet.columns.forEach((col, i) => {
        col.width = COLUMN_WIDTHS[i];
      });

      const ref = workbook.addWorksheet('Valid Values');
      const refHeader = ref.addRow(['Church name', 'Church code', '', 'Gender']);
      styleHeaderRow(refHeader);
      ref.getCell('D2').value = 'MALE';
      ref.getCell('D3').value = 'FEMALE';
      churches.forEach((c, i) => {
        ref.getCell(`A${i + 2}`).value = c.name;
        ref.getCell(`B${i + 2}`).value = c.short_code;
      });
      ref.columns = [{ width: 32 }, { width: 14 }, { width: 3 }, { width: 12 }];

      const genderFormula = ['"MALE,FEMALE"'];
      const churchFormula =
        churches.length > 0 ? [`'Valid Values'!$A$2:$A$${churches.length + 1}`] : undefined;

      for (let r = 3; r <= TEMPLATE_DATA_ROWS + 2; r += 1) {
        sheet.getCell(`D${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: genderFormula,
          showErrorMessage: true,
          errorStyle: 'error',
          errorTitle: 'Invalid gender',
          error: 'Choose MALE, FEMALE, or leave blank.',
        };
        if (churchFormula) {
          sheet.getCell(`E${r}`).dataValidation = {
            type: 'list',
            allowBlank: false,
            formulae: churchFormula,
            showErrorMessage: true,
            errorStyle: 'error',
            errorTitle: 'Unknown church',
            error: 'Pick a church from the dropdown — it must match the "Valid Values" sheet exactly.',
          };
        }
      }

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', 'attachment; filename="member-import-template.xlsx"');
      res.send(Buffer.from(buffer));
    }),
  );

  /**
   * Stage a workbook. Nothing is written to `members` here — only to the
   * import_batches/import_rows staging tables — so a bad upload costs nothing
   * to retry.
   */
  router.post(
    '/preview',
    requireCapability(Capability.MANAGE_MEMBERS),
    upload.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw errors.validation('No file was uploaded. Attach an .xlsx file.');
      const eventId = req.eventId!;
      const actor = actorFromRequest(req);

      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(req.file.buffer as unknown as ExcelJS.Buffer);
      } catch {
        throw errors.validation(
          'That file could not be read as an Excel workbook (.xlsx). Download the template and try again.',
        );
      }

      const sheet = workbook.getWorksheet('Members') ?? workbook.worksheets[0];
      if (!sheet) throw errors.validation('The workbook has no worksheet to read.');

      let headerRowNumber = -1;
      for (let r = 1; r <= sheet.rowCount; r += 1) {
        if (cellText(sheet.getRow(r).getCell(1).value) === HEADERS.chestNumber) {
          headerRowNumber = r;
          break;
        }
      }
      if (headerRowNumber === -1) {
        throw errors.validation(
          'Could not find the header row (expected "Chest Number" in the first column). Use the downloaded template without renaming its columns.',
        );
      }

      const [churches, categoryRows, event, existingMembers] = await Promise.all([
        db.selectFrom('churches').select(['id', 'name', 'short_code']).execute(),
        db
          .selectFrom('categories')
          .select(['id', 'name', 'min_age', 'max_age', 'gender_restriction'])
          .where('event_id', '=', eventId)
          .where('is_active', '=', true)
          .execute(),
        db.selectFrom('events').select('age_cutoff_date').where('id', '=', eventId).executeTakeFirstOrThrow(),
        db.selectFrom('members').select('chest_number').where('event_id', '=', eventId).execute(),
      ]);

      const churchByKey = new Map<string, { id: string; name: string }>();
      for (const c of churches) {
        churchByKey.set(c.name.trim().toLowerCase(), { id: c.id, name: c.name });
        churchByKey.set(c.short_code.trim().toLowerCase(), { id: c.id, name: c.name });
      }
      const bands: CategoryBand[] = categoryRows.map((c) => ({
        id: c.id,
        name: c.name,
        minAge: c.min_age,
        maxAge: c.max_age,
        genderRestriction: c.gender_restriction,
      }));
      const existingChestNumbers = new Set(existingMembers.map((m) => m.chest_number.toLowerCase()));

      const results: StagedRow[] = [];
      const seenChestInFile = new Map<string, number>();

      for (let r = headerRowNumber + 1; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const chestNumberRaw = cellText(row.getCell(1).value);
        const fullNameRaw = cellText(row.getCell(2).value);
        const dobCell = row.getCell(3).value;
        const genderRaw = cellText(row.getCell(4).value);
        const churchRaw = cellText(row.getCell(5).value);
        const mobileRaw = cellText(row.getCell(6).value);
        const notesRaw = cellText(row.getCell(7).value);

        if (!chestNumberRaw && !fullNameRaw && !churchRaw) continue;

        const rowErrors: RowError[] = [];
        const rowWarnings: RowWarning[] = [];

        const chestNumber = chestNumberRaw.trim();
        if (!chestNumber) rowErrors.push({ field: 'chestNumber', code: 'REQUIRED', message: 'Chest number is required.' });

        const fullName = fullNameRaw.trim();
        if (!fullName || fullName.length < 2) {
          rowErrors.push({ field: 'fullName', code: 'REQUIRED', message: 'Full name is required (at least 2 characters).' });
        }

        let dateOfBirth: string | null = null;
        if (dobCell instanceof Date) {
          dateOfBirth = `${dobCell.getUTCFullYear()}-${String(dobCell.getUTCMonth() + 1).padStart(2, '0')}-${String(dobCell.getUTCDate()).padStart(2, '0')}`;
        } else {
          const dobRaw = cellText(dobCell).trim();
          if (dobRaw) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(dobRaw)) dateOfBirth = dobRaw;
            else rowErrors.push({ field: 'dateOfBirth', code: 'MALFORMED_DATE', message: `"${dobRaw}" is not a valid date. Use YYYY-MM-DD.` });
          }
        }

        let gender: 'MALE' | 'FEMALE' | null = null;
        if (genderRaw.trim()) {
          const g = genderRaw.trim().toUpperCase();
          if (g === 'MALE' || g === 'FEMALE') gender = g;
          else rowErrors.push({ field: 'gender', code: 'INVALID_GENDER', message: `"${genderRaw}" is not MALE or FEMALE.` });
        }

        let churchMatch: { id: string; name: string } | null = null;
        const churchKey = churchRaw.trim().toLowerCase();
        if (!churchKey) {
          rowErrors.push({ field: 'church', code: 'REQUIRED', message: 'Church is required.' });
        } else {
          churchMatch = churchByKey.get(churchKey) ?? null;
          if (!churchMatch) {
            rowErrors.push({
              field: 'church',
              code: 'INVALID_CHURCH',
              message: `"${churchRaw}" does not match any church name or code. Check the "Valid Values" sheet.`,
            });
          }
        }

        if (chestNumber) {
          const key = chestNumber.toLowerCase();
          const firstSeenAt = seenChestInFile.get(key);
          if (firstSeenAt !== undefined) {
            rowErrors.push({
              field: 'chestNumber',
              code: 'DUPLICATE_CHEST_NUMBER',
              message: `Chest number ${chestNumber} is repeated in this file (first seen on row ${firstSeenAt}).`,
            });
          } else {
            seenChestInFile.set(key, r);
            if (existingChestNumbers.has(key)) {
              rowErrors.push({
                field: 'chestNumber',
                code: 'DUPLICATE_CHEST_NUMBER',
                message: `Chest number ${chestNumber} is already assigned to an existing member.`,
              });
            }
          }
        }

        let categoryId: string | null = null;
        let categoryName: string | null = null;
        if (rowErrors.length === 0) {
          const derived = deriveCategory(dateOfBirth, gender, String(event.age_cutoff_date), bands);
          categoryId = derived.category?.id ?? null;
          categoryName = derived.category?.name ?? null;
          if (!categoryId && dateOfBirth) {
            rowWarnings.push({
              field: 'dateOfBirth',
              message: derived.reason ?? 'No category could be derived for this date of birth.',
            });
          }
        }

        const normalised: NormalisedMember | null =
          rowErrors.length === 0 && churchMatch
            ? {
                chestNumber,
                fullName,
                dateOfBirth,
                gender,
                churchId: churchMatch.id,
                churchName: churchMatch.name,
                categoryId,
                categoryName,
                mobile: mobileRaw.trim() || null,
                notes: notesRaw.trim() || null,
              }
            : null;

        results.push({
          rowNumber: r,
          raw: {
            chestNumber: chestNumberRaw,
            fullName: fullNameRaw,
            dateOfBirth: dateOfBirth ?? cellText(dobCell),
            gender: genderRaw,
            church: churchRaw,
            mobile: mobileRaw,
            notes: notesRaw,
          },
          normalised,
          errors: rowErrors,
          warnings: rowWarnings,
          status: rowErrors.length === 0 ? 'VALID' : 'INVALID',
        });
      }

      if (results.length === 0) {
        throw errors.validation('No data rows were found below the header. Fill in at least one row and try again.');
      }

      const validCount = results.filter((r) => r.status === 'VALID').length;

      const batch = await db.transaction().execute(async (trx) => {
        const batchRow = await trx
          .insertInto('import_batches')
          .values({
            event_id: eventId,
            type: 'MEMBERS',
            status: 'PENDING_REVIEW',
            filename: req.file!.originalname,
            total_rows: results.length,
            valid_rows: validCount,
            invalid_rows: results.length - validCount,
            created_by: req.auth!.userId,
            updated_by: req.auth!.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        for (const row of results) {
          await trx
            .insertInto('import_rows')
            .values({
              batch_id: batchRow.id,
              row_number: row.rowNumber,
              raw: JSON.stringify(row.raw) as never,
              normalised: row.normalised ? (JSON.stringify(row.normalised) as never) : null,
              errors: JSON.stringify(row.errors) as never,
              warnings: JSON.stringify(row.warnings) as never,
              status: row.status,
            })
            .execute();
        }

        await writeAudit(
          {
            eventId,
            actor,
            action: AuditAction.IMPORTED,
            entityType: 'import_batch',
            entityId: batchRow.id,
            newValue: { filename: batchRow.filename, totalRows: results.length, validRows: validCount },
          },
          trx,
        );

        return batchRow;
      });

      return created(res, {
        batchId: batch.id,
        filename: batch.filename,
        totalRows: results.length,
        validRows: validCount,
        invalidRows: results.length - validCount,
        rows: results,
      });
    }),
  );

  /**
   * Commit every VALID row from a staged batch. Each row is its own
   * transaction: one row failing at commit time (e.g. a chest number claimed by
   * someone else in the meantime) marks that row INVALID and keeps going,
   * rather than losing an otherwise-good batch to one late collision.
   */
  router.post(
    '/:batchId/commit',
    requireCapability(Capability.MANAGE_MEMBERS),
    validate({ params: z.object({ batchId: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { batchId } = req.params as { batchId: string };
      const eventId = req.eventId!;
      const actor = actorFromRequest(req);

      const batch = await db
        .selectFrom('import_batches')
        .selectAll()
        .where('id', '=', batchId)
        .where('event_id', '=', eventId)
        .executeTakeFirst();
      if (!batch) throw errors.notFound('Import batch', batchId);
      if (batch.status !== 'PENDING_REVIEW') {
        throw errors.conflict(`This import batch is already ${batch.status.toLowerCase().replace('_', ' ')}.`);
      }

      const rows = await db
        .selectFrom('import_rows')
        .selectAll()
        .where('batch_id', '=', batchId)
        .where('status', '=', 'VALID')
        .orderBy('row_number')
        .execute();

      let committed = 0;
      let failed = 0;
      const rowResults: { rowNumber: number; status: string; message?: string }[] = [];

      for (const row of rows) {
        const normalised = row.normalised as NormalisedMember;
        try {
          await db.transaction().execute(async (trx) => {
            const clash = await trx
              .selectFrom('members')
              .select('id')
              .where('event_id', '=', eventId)
              .where('chest_number', '=', normalised.chestNumber)
              .executeTakeFirst();
            if (clash) throw errors.duplicateChestNumber(normalised.chestNumber);

            const member = await trx
              .insertInto('members')
              .values({
                event_id: eventId,
                chest_number: normalised.chestNumber,
                full_name: normalised.fullName,
                date_of_birth: normalised.dateOfBirth,
                gender: normalised.gender,
                church_id: normalised.churchId,
                category_id: normalised.categoryId,
                derived_category_id: normalised.categoryId,
                mobile: normalised.mobile,
                notes: normalised.notes,
                created_by: req.auth!.userId,
                updated_by: req.auth!.userId,
              })
              .returningAll()
              .executeTakeFirstOrThrow();

            await writeAudit(
              {
                eventId,
                actor,
                action: AuditAction.IMPORTED,
                entityType: 'member',
                entityId: member.id,
                newValue: { chestNumber: member.chest_number, fullName: member.full_name, churchId: member.church_id, batchId },
              },
              trx,
            );

            await trx
              .updateTable('import_rows')
              .set({ status: 'COMMITTED', created_entity_id: member.id })
              .where('id', '=', row.id)
              .execute();
          });
          committed += 1;
          rowResults.push({ rowNumber: row.row_number, status: 'COMMITTED' });
        } catch (err) {
          failed += 1;
          const message = err instanceof AppError ? err.message : 'Could not create this member.';
          await db
            .updateTable('import_rows')
            .set({ status: 'INVALID', errors: JSON.stringify([{ field: 'chestNumber', code: 'COMMIT_FAILED', message }]) as never })
            .where('id', '=', row.id)
            .execute();
          rowResults.push({ rowNumber: row.row_number, status: 'INVALID', message });
        }
      }

      await db
        .updateTable('import_batches')
        .set({
          status: 'COMMITTED',
          committed_at: new Date(),
          committed_by: req.auth!.userId,
          committed_rows: committed,
          invalid_rows: batch.invalid_rows + failed,
          updated_by: req.auth!.userId,
        })
        .where('id', '=', batchId)
        .execute();

      return ok(res, { batchId, committed, failed, rows: rowResults });
    }),
  );

  return router;
}

function cellText(value: ExcelJS.CellValue): string {
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
