/**
 * Bulk item import — same two-phase mechanics as member/church/category
 * import. Covers the core fields (name, code, category, type, gender
 * restriction, stage, scoring/entry limits, display order); scheduling and
 * group team-size fields are left to the per-item edit form, since they're
 * rarely set in bulk and would roughly double this template's width.
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
  name: 'Item Name',
  code: 'Code',
  category: 'Category',
  type: 'Type',
  genderRestriction: 'Gender Restriction',
  stage: 'Stage',
  maxMark: 'Max Mark Override',
  maxPerChurch: 'Max Per Church',
  displayOrder: 'Display Order',
} as const;

const COLUMN_WIDTHS = [30, 14, 24, 14, 18, 20, 18, 16, 14];
const TEMPLATE_DATA_ROWS = 500;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

interface RowError {
  field: string;
  code: string;
  message: string;
}
interface NormalisedItem {
  name: string;
  code: string;
  categoryId: string | null;
  categoryName: string | null;
  type: 'INDIVIDUAL' | 'GROUP';
  genderRestriction: 'ANY' | 'MALE' | 'FEMALE';
  stage: string | null;
  maxMark: number | null;
  maxPerChurch: number | null;
  displayOrder: number;
}
interface StagedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  normalised: NormalisedItem | null;
  errors: RowError[];
  warnings: never[];
  status: 'VALID' | 'INVALID';
}

export function itemImportRoutes(): Router {
  const router = Router();

  router.get(
    '/template',
    requireCapability(Capability.MANAGE_ITEMS),
    asyncHandler(async (req, res) => {
      const eventId = req.eventId!;
      const categories = await db
        .selectFrom('categories')
        .select(['name'])
        .where('event_id', '=', eventId)
        .where('is_active', '=', true)
        .orderBy('display_order')
        .orderBy('name')
        .execute();

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'PYPA Marking System';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Items');
      sheet.mergeCells('A1:I1');
      const instructions = sheet.getCell('A1');
      instructions.value =
        'One row per item. Do not rename or reorder the columns. Leave Category blank for "open to all categories" — ' +
        'otherwise pick one from the dropdown (see the "Valid Values" sheet). Type and Gender Restriction are also dropdowns.';
      instructions.font = { italic: true, color: { argb: 'FF6B7280' } };
      instructions.alignment = { wrapText: true, vertical: 'top' };
      sheet.getRow(1).height = 44;

      const header = sheet.addRow([
        HEADERS.name,
        HEADERS.code,
        HEADERS.category,
        HEADERS.type,
        HEADERS.genderRestriction,
        HEADERS.stage,
        HEADERS.maxMark,
        HEADERS.maxPerChurch,
        HEADERS.displayOrder,
      ]);
      styleHeaderRow(header);
      sheet.columns.forEach((col, i) => {
        col.width = COLUMN_WIDTHS[i];
      });

      const ref = workbook.addWorksheet('Valid Values');
      const refHeader = ref.addRow(['Category', '', 'Type', '', 'Gender Restriction']);
      styleHeaderRow(refHeader);
      categories.forEach((c, i) => {
        ref.getCell(`A${i + 2}`).value = c.name;
      });
      ref.getCell('C2').value = 'INDIVIDUAL';
      ref.getCell('C3').value = 'GROUP';
      ref.getCell('E2').value = 'ANY';
      ref.getCell('E3').value = 'MALE';
      ref.getCell('E4').value = 'FEMALE';
      ref.columns = [{ width: 28 }, { width: 3 }, { width: 14 }, { width: 3 }, { width: 16 }];

      const categoryFormula = categories.length > 0 ? [`'Valid Values'!$A$2:$A$${categories.length + 1}`] : undefined;

      for (let r = 3; r <= TEMPLATE_DATA_ROWS + 2; r += 1) {
        if (categoryFormula) {
          sheet.getCell(`C${r}`).dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: categoryFormula,
            showErrorMessage: true,
            errorStyle: 'error',
            errorTitle: 'Unknown category',
            error: 'Pick a category from the dropdown, or leave blank for "open to all". See the "Valid Values" sheet.',
          };
        }
        sheet.getCell(`D${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"INDIVIDUAL,GROUP"'],
          showErrorMessage: true,
          errorStyle: 'error',
          errorTitle: 'Invalid type',
          error: 'Choose INDIVIDUAL or GROUP (blank defaults to INDIVIDUAL).',
        };
        sheet.getCell(`E${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"ANY,MALE,FEMALE"'],
          showErrorMessage: true,
          errorStyle: 'error',
          errorTitle: 'Invalid gender restriction',
          error: 'Choose ANY, MALE or FEMALE (blank defaults to ANY).',
        };
      }

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="item-import-template.xlsx"');
      res.send(Buffer.from(buffer));
    }),
  );

  router.post(
    '/preview',
    requireCapability(Capability.MANAGE_ITEMS),
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

      const sheet = workbook.getWorksheet('Items') ?? workbook.worksheets[0];
      if (!sheet) throw errors.validation('The workbook has no worksheet to read.');

      const headerRowNumber = findHeaderRow(sheet, HEADERS.name);
      if (headerRowNumber === -1) {
        throw errors.validation(
          'Could not find the header row (expected "Item Name" in the first column). Use the downloaded template without renaming its columns.',
        );
      }

      const [categories, existingItems] = await Promise.all([
        db.selectFrom('categories').select(['id', 'name']).where('event_id', '=', eventId).execute(),
        db.selectFrom('items').select('code').where('event_id', '=', eventId).execute(),
      ]);
      const categoryByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));
      const existingCodes = new Set(existingItems.map((i) => i.code.trim().toLowerCase()));

      const results: StagedRow[] = [];
      const seenCodes = new Map<string, number>();

      for (let r = headerRowNumber + 1; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const nameRaw = cellText(row.getCell(1).value);
        const codeRaw = cellText(row.getCell(2).value);
        const categoryRaw = cellText(row.getCell(3).value);
        const typeRaw = cellText(row.getCell(4).value);
        const genderRaw = cellText(row.getCell(5).value);
        const stageRaw = cellText(row.getCell(6).value);
        const maxMarkRaw = cellText(row.getCell(7).value);
        const maxPerChurchRaw = cellText(row.getCell(8).value);
        const displayOrderRaw = cellText(row.getCell(9).value);

        if (!nameRaw && !codeRaw) continue;

        const rowErrors: RowError[] = [];

        const name = nameRaw.trim();
        if (!name) rowErrors.push({ field: 'name', code: 'REQUIRED', message: 'Item name is required.' });

        const code = codeRaw.trim();
        if (!code || !/^[A-Za-z0-9._-]+$/.test(code)) {
          rowErrors.push({ field: 'code', code: 'INVALID', message: `"${codeRaw}" must use only letters, numbers, dots, underscores or hyphens.` });
        } else {
          const key = code.toLowerCase();
          const firstSeenAt = seenCodes.get(key);
          if (firstSeenAt !== undefined) {
            rowErrors.push({ field: 'code', code: 'DUPLICATE', message: `Code ${code} is repeated in this file (first seen on row ${firstSeenAt}).` });
          } else {
            seenCodes.set(key, r);
            if (existingCodes.has(key)) {
              rowErrors.push({ field: 'code', code: 'DUPLICATE', message: `An item with code ${code} already exists in this event.` });
            }
          }
        }

        let categoryId: string | null = null;
        let categoryName: string | null = null;
        const categoryKey = categoryRaw.trim().toLowerCase();
        if (categoryKey) {
          const match = categoryByName.get(categoryKey);
          if (!match) {
            rowErrors.push({
              field: 'category',
              code: 'INVALID_CATEGORY',
              message: `"${categoryRaw}" does not match any category. Leave blank for "open to all", or check the "Valid Values" sheet.`,
            });
          } else {
            categoryId = match.id;
            categoryName = match.name;
          }
        }

        let type: 'INDIVIDUAL' | 'GROUP' = 'INDIVIDUAL';
        const typeTrim = typeRaw.trim().toUpperCase();
        if (typeTrim) {
          if (typeTrim === 'INDIVIDUAL' || typeTrim === 'GROUP') type = typeTrim;
          else rowErrors.push({ field: 'type', code: 'INVALID', message: `"${typeRaw}" is not INDIVIDUAL or GROUP.` });
        }

        let genderRestriction: 'ANY' | 'MALE' | 'FEMALE' = 'ANY';
        const genderTrim = genderRaw.trim().toUpperCase();
        if (genderTrim) {
          if (genderTrim === 'ANY' || genderTrim === 'MALE' || genderTrim === 'FEMALE') genderRestriction = genderTrim;
          else rowErrors.push({ field: 'genderRestriction', code: 'INVALID', message: `"${genderRaw}" is not ANY, MALE or FEMALE.` });
        }

        let maxMark: number | null = null;
        if (maxMarkRaw.trim()) {
          const parsed = Number(maxMarkRaw);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            rowErrors.push({ field: 'maxMark', code: 'INVALID', message: `"${maxMarkRaw}" is not a valid max mark.` });
          } else {
            maxMark = parsed;
          }
        }

        let maxPerChurch: number | null = null;
        if (maxPerChurchRaw.trim()) {
          const parsed = Number(maxPerChurchRaw);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            rowErrors.push({ field: 'maxPerChurch', code: 'INVALID', message: `"${maxPerChurchRaw}" is not a valid whole number.` });
          } else {
            maxPerChurch = parsed;
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

        const normalised: NormalisedItem | null =
          rowErrors.length === 0
            ? {
                name,
                code,
                categoryId,
                categoryName,
                type,
                genderRestriction,
                stage: stageRaw.trim() || null,
                maxMark,
                maxPerChurch,
                displayOrder,
              }
            : null;

        results.push({
          rowNumber: r,
          raw: {
            name: nameRaw,
            code: codeRaw,
            category: categoryRaw,
            type: typeRaw,
            genderRestriction: genderRaw,
            stage: stageRaw,
            maxMark: maxMarkRaw,
            maxPerChurch: maxPerChurchRaw,
            displayOrder: displayOrderRaw,
          },
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
            type: 'ITEMS',
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
            newValue: { kind: 'items', filename: batchRow.filename, totalRows: results.length, validRows: validCount },
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
    requireCapability(Capability.MANAGE_ITEMS),
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
        const normalised = row.normalised as NormalisedItem;
        try {
          await db.transaction().execute(async (trx) => {
            const clash = await trx
              .selectFrom('items')
              .select('id')
              .where('event_id', '=', eventId)
              .where('code', 'ilike', normalised.code)
              .executeTakeFirst();
            if (clash) throw errors.conflict(`An item with code ${normalised.code} already exists in this event.`);

            const item = await trx
              .insertInto('items')
              .values({
                event_id: eventId,
                name: normalised.name,
                code: normalised.code,
                category_id: normalised.categoryId,
                open_to_all_categories: normalised.categoryId === null,
                type: normalised.type,
                gender_restriction: normalised.genderRestriction,
                stage: normalised.stage,
                max_mark: normalised.maxMark,
                max_per_church: normalised.maxPerChurch,
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
                entityType: 'item',
                entityId: item.id,
                newValue: { name: item.name, code: item.code, categoryName: normalised.categoryName, batchId },
              },
              trx,
            );

            await trx
              .updateTable('import_rows')
              .set({ status: 'COMMITTED', created_entity_id: item.id })
              .where('id', '=', row.id)
              .execute();
          });
          committed += 1;
          rowResults.push({ rowNumber: row.row_number, status: 'COMMITTED' });
        } catch (err) {
          failed += 1;
          const message = err instanceof AppError ? err.message : 'Could not create this item.';
          await db
            .updateTable('import_rows')
            .set({ status: 'INVALID', errors: JSON.stringify([{ field: 'code', code: 'COMMIT_FAILED', message }]) as never })
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
