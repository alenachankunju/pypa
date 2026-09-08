/**
 * Bulk category import — same two-phase mechanics as member/church import.
 * Categories are event-scoped (FSD ADM-03-02), so validation and commit both
 * work against the active event only.
 */
import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import { cellText, findHeaderRow, styleHeaderRow } from '../../services/importUtil.js';
import { AppError, errors } from '../../utils/errors.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

const HEADERS = {
  name: 'Category Name',
  minAge: 'Min Age',
  maxAge: 'Max Age',
  genderRestriction: 'Gender Restriction',
  displayOrder: 'Display Order',
} as const;

const COLUMN_WIDTHS = [28, 10, 10, 18, 14];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

interface RowError {
  field: string;
  code: string;
  message: string;
}
interface NormalisedCategory {
  name: string;
  minAge: number;
  maxAge: number;
  genderRestriction: 'ANY' | 'MALE' | 'FEMALE';
  displayOrder: number;
}
interface StagedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  normalised: NormalisedCategory | null;
  errors: RowError[];
  warnings: never[];
  status: 'VALID' | 'INVALID';
}

export function categoryImportRoutes(): Router {
  const router = Router();

  router.get(
    '/template',
    requireCapability(Capability.MANAGE_CATEGORIES),
    asyncHandler(async (_req, res) => {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'PYPA Marking System';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Categories');
      sheet.mergeCells('A1:E1');
      const instructions = sheet.getCell('A1');
      instructions.value =
        'One row per category (age band). Do not rename or reorder the columns. Gender Restriction must be picked from the dropdown.';
      instructions.font = { italic: true, color: { argb: 'FF6B7280' } };
      instructions.alignment = { wrapText: true, vertical: 'top' };
      sheet.getRow(1).height = 32;

      const header = sheet.addRow([HEADERS.name, HEADERS.minAge, HEADERS.maxAge, HEADERS.genderRestriction, HEADERS.displayOrder]);
      styleHeaderRow(header);
      sheet.columns.forEach((col, i) => {
        col.width = COLUMN_WIDTHS[i];
      });

      for (let r = 3; r <= 502; r += 1) {
        sheet.getCell(`D${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"ANY,MALE,FEMALE"'],
          showErrorMessage: true,
          errorStyle: 'error',
          errorTitle: 'Invalid gender restriction',
          error: 'Choose ANY, MALE, FEMALE, or leave blank for ANY.',
        };
      }

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="category-import-template.xlsx"');
      res.send(Buffer.from(buffer));
    }),
  );

  router.post(
    '/preview',
    requireCapability(Capability.MANAGE_CATEGORIES),
    upload.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw errors.validation('No file was uploaded. Attach an .xlsx file.');
      const eventId = req.eventId!;
      const actor = actorFromRequest(req);

      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(req.file.buffer as unknown as ExcelJS.Buffer);
      } catch {
        throw errors.validation('That file could not be read as an Excel workbook (.xlsx). Download the template and try again.');
      }

      const sheet = workbook.getWorksheet('Categories') ?? workbook.worksheets[0];
      if (!sheet) throw errors.validation('The workbook has no worksheet to read.');

      const headerRowNumber = findHeaderRow(sheet, HEADERS.name);
      if (headerRowNumber === -1) {
        throw errors.validation(
          'Could not find the header row (expected "Category Name" in the first column). Use the downloaded template without renaming its columns.',
        );
      }

      const existing = await db.selectFrom('categories').select('name').where('event_id', '=', eventId).execute();
      const existingNames = new Set(existing.map((c) => c.name.trim().toLowerCase()));

      const results: StagedRow[] = [];
      const seenNames = new Map<string, number>();

      for (let r = headerRowNumber + 1; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const nameRaw = cellText(row.getCell(1).value);
        const minAgeRaw = cellText(row.getCell(2).value);
        const maxAgeRaw = cellText(row.getCell(3).value);
        const genderRaw = cellText(row.getCell(4).value);
        const displayOrderRaw = cellText(row.getCell(5).value);

        if (!nameRaw && !minAgeRaw && !maxAgeRaw) continue;

        const rowErrors: RowError[] = [];

        const name = nameRaw.trim();
        if (!name) {
          rowErrors.push({ field: 'name', code: 'REQUIRED', message: 'Category name is required.' });
        } else {
          const key = name.toLowerCase();
          const firstSeenAt = seenNames.get(key);
          if (firstSeenAt !== undefined) {
            rowErrors.push({ field: 'name', code: 'DUPLICATE', message: `"${name}" is repeated in this file (first seen on row ${firstSeenAt}).` });
          } else {
            seenNames.set(key, r);
            if (existingNames.has(key)) {
              rowErrors.push({ field: 'name', code: 'DUPLICATE', message: `A category named "${name}" already exists in this event.` });
            }
          }
        }

        const minAge = Number(minAgeRaw);
        if (!minAgeRaw || !Number.isInteger(minAge) || minAge < 0 || minAge > 120) {
          rowErrors.push({ field: 'minAge', code: 'INVALID', message: `"${minAgeRaw}" is not a valid minimum age (0-120).` });
        }

        const maxAge = Number(maxAgeRaw);
        if (!maxAgeRaw || !Number.isInteger(maxAge) || maxAge < 0 || maxAge > 120) {
          rowErrors.push({ field: 'maxAge', code: 'INVALID', message: `"${maxAgeRaw}" is not a valid maximum age (0-120).` });
        } else if (!Number.isNaN(minAge) && maxAge < minAge) {
          rowErrors.push({ field: 'maxAge', code: 'INVALID', message: 'Max age cannot be less than min age.' });
        }

        let genderRestriction: 'ANY' | 'MALE' | 'FEMALE' = 'ANY';
        const genderTrim = genderRaw.trim().toUpperCase();
        if (genderTrim) {
          if (genderTrim === 'ANY' || genderTrim === 'MALE' || genderTrim === 'FEMALE') {
            genderRestriction = genderTrim;
          } else {
            rowErrors.push({ field: 'genderRestriction', code: 'INVALID', message: `"${genderRaw}" is not ANY, MALE or FEMALE.` });
          }
        }

        let displayOrder = 0;
        if (displayOrderRaw.trim()) {
          const parsed = Number(displayOrderRaw);
          if (!Number.isInteger(parsed) || parsed < 0) {
            rowErrors.push({ field: 'displayOrder', code: 'INVALID', message: `"${displayOrderRaw}" is not a valid display order.` });
          } else {
            displayOrder = parsed;
          }
        }

        const normalised: NormalisedCategory | null =
          rowErrors.length === 0 ? { name, minAge, maxAge, genderRestriction, displayOrder } : null;

        results.push({
          rowNumber: r,
          raw: { name: nameRaw, minAge: minAgeRaw, maxAge: maxAgeRaw, genderRestriction: genderRaw, displayOrder: displayOrderRaw },
          normalised,
          errors: rowErrors,
          warnings: [],
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
            type: 'CATEGORIES',
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
            newValue: { kind: 'categories', filename: batchRow.filename, totalRows: results.length, validRows: validCount },
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

  router.post(
    '/:batchId/commit',
    requireCapability(Capability.MANAGE_CATEGORIES),
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
        const normalised = row.normalised as NormalisedCategory;
        try {
          await db.transaction().execute(async (trx) => {
            const clash = await trx
              .selectFrom('categories')
              .select('id')
              .where('event_id', '=', eventId)
              .where('name', 'ilike', normalised.name)
              .executeTakeFirst();
            if (clash) throw errors.conflict(`A category named "${normalised.name}" already exists in this event.`);

            const category = await trx
              .insertInto('categories')
              .values({
                event_id: eventId,
                name: normalised.name,
                min_age: normalised.minAge,
                max_age: normalised.maxAge,
                gender_restriction: normalised.genderRestriction,
                display_order: normalised.displayOrder,
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
                entityType: 'category',
                entityId: category.id,
                newValue: { name: category.name, minAge: category.min_age, maxAge: category.max_age, batchId },
              },
              trx,
            );

            await trx
              .updateTable('import_rows')
              .set({ status: 'COMMITTED', created_entity_id: category.id })
              .where('id', '=', row.id)
              .execute();
          });
          committed += 1;
          rowResults.push({ rowNumber: row.row_number, status: 'COMMITTED' });
        } catch (err) {
          failed += 1;
          const message = err instanceof AppError ? err.message : 'Could not create this category.';
          await db
            .updateTable('import_rows')
            .set({ status: 'INVALID', errors: JSON.stringify([{ field: 'name', code: 'COMMIT_FAILED', message }]) as never })
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
