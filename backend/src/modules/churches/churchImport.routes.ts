/**
 * Bulk church import — same two-phase mechanics as member import
 * (backend/src/modules/members/memberImport.routes.ts): stage into
 * import_batches/import_rows, preview, then commit only the VALID rows.
 *
 * Churches themselves are global master data (FSD ADM-02-01) — created rows
 * aren't scoped to an event, and there's no dropdown-sourced reference field,
 * so there's nothing here for a row to get wrong except its own name/code
 * clashing with another row. The staging batch row still needs an active
 * event, though: import_batches.event_id is NOT NULL, same as every other
 * import kind, since it's simply "whichever admin session staged this."
 */
import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { AuditAction, actorFromRequest, writeAudit } from '../../services/audit.js';
import { cellText, findHeaderRow, styleHeaderRow } from '../../services/importUtil.js';
import { AppError, errors } from '../../utils/errors.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

const HEADERS = {
  name: 'Church Name',
  shortCode: 'Short Code',
  zone: 'Zone',
  contactPerson: 'Contact Person',
  contactMobile: 'Contact Mobile',
  contactEmail: 'Contact Email',
} as const;

const COLUMN_WIDTHS = [30, 12, 20, 24, 16, 28];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

interface RowError {
  field: string;
  code: string;
  message: string;
}
interface NormalisedChurch {
  name: string;
  shortCode: string;
  zone: string | null;
  contactPerson: string | null;
  contactMobile: string | null;
  contactEmail: string | null;
}
interface StagedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  normalised: NormalisedChurch | null;
  errors: RowError[];
  warnings: never[];
  status: 'VALID' | 'INVALID';
}

export function churchImportRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());

  router.get(
    '/template',
    requireCapability(Capability.MANAGE_CHURCHES),
    asyncHandler(async (_req, res) => {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'PYPA Marking System';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Churches');
      sheet.mergeCells('A1:F1');
      const instructions = sheet.getCell('A1');
      instructions.value =
        'One row per church. Do not rename or reorder the columns. Short Code is 3-6 letters/numbers and must be unique.';
      instructions.font = { italic: true, color: { argb: 'FF6B7280' } };
      instructions.alignment = { wrapText: true, vertical: 'top' };
      sheet.getRow(1).height = 32;

      const header = sheet.addRow([
        HEADERS.name,
        HEADERS.shortCode,
        HEADERS.zone,
        HEADERS.contactPerson,
        HEADERS.contactMobile,
        HEADERS.contactEmail,
      ]);
      styleHeaderRow(header);
      sheet.columns.forEach((col, i) => {
        col.width = COLUMN_WIDTHS[i];
      });

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="church-import-template.xlsx"');
      res.send(Buffer.from(buffer));
    }),
  );

  router.post(
    '/preview',
    requireCapability(Capability.MANAGE_CHURCHES),
    upload.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw errors.validation('No file was uploaded. Attach an .xlsx file.');
      const actor = actorFromRequest(req);

      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(req.file.buffer as unknown as ExcelJS.Buffer);
      } catch {
        throw errors.validation('That file could not be read as an Excel workbook (.xlsx). Download the template and try again.');
      }

      const sheet = workbook.getWorksheet('Churches') ?? workbook.worksheets[0];
      if (!sheet) throw errors.validation('The workbook has no worksheet to read.');

      const headerRowNumber = findHeaderRow(sheet, HEADERS.name);
      if (headerRowNumber === -1) {
        throw errors.validation(
          'Could not find the header row (expected "Church Name" in the first column). Use the downloaded template without renaming its columns.',
        );
      }

      const existing = await db.selectFrom('churches').select(['name', 'short_code']).execute();
      const existingNames = new Set(existing.map((c) => c.name.trim().toLowerCase()));
      const existingCodes = new Set(existing.map((c) => c.short_code.trim().toLowerCase()));

      const results: StagedRow[] = [];
      const seenNames = new Map<string, number>();
      const seenCodes = new Map<string, number>();

      for (let r = headerRowNumber + 1; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const nameRaw = cellText(row.getCell(1).value);
        const codeRaw = cellText(row.getCell(2).value);
        const zoneRaw = cellText(row.getCell(3).value);
        const contactPersonRaw = cellText(row.getCell(4).value);
        const contactMobileRaw = cellText(row.getCell(5).value);
        const contactEmailRaw = cellText(row.getCell(6).value);

        if (!nameRaw && !codeRaw) continue;

        const rowErrors: RowError[] = [];

        const name = nameRaw.trim();
        if (!name || name.length < 2) {
          rowErrors.push({ field: 'name', code: 'REQUIRED', message: 'Church name is required (at least 2 characters).' });
        } else {
          const key = name.toLowerCase();
          const firstSeenAt = seenNames.get(key);
          if (firstSeenAt !== undefined) {
            rowErrors.push({ field: 'name', code: 'DUPLICATE', message: `"${name}" is repeated in this file (first seen on row ${firstSeenAt}).` });
          } else {
            seenNames.set(key, r);
            if (existingNames.has(key)) {
              rowErrors.push({ field: 'name', code: 'DUPLICATE', message: `A church named "${name}" already exists.` });
            }
          }
        }

        const shortCode = codeRaw.trim().toUpperCase();
        if (!shortCode || !/^[A-Za-z0-9]{3,6}$/.test(shortCode)) {
          rowErrors.push({ field: 'shortCode', code: 'INVALID', message: `"${codeRaw}" must be 3-6 letters/numbers.` });
        } else {
          const key = shortCode.toLowerCase();
          const firstSeenAt = seenCodes.get(key);
          if (firstSeenAt !== undefined) {
            rowErrors.push({ field: 'shortCode', code: 'DUPLICATE', message: `Short code ${shortCode} is repeated in this file (first seen on row ${firstSeenAt}).` });
          } else {
            seenCodes.set(key, r);
            if (existingCodes.has(key)) {
              rowErrors.push({ field: 'shortCode', code: 'DUPLICATE', message: `Short code ${shortCode} is already in use.` });
            }
          }
        }

        const contactEmail = contactEmailRaw.trim();
        if (contactEmail && !EMAIL_RE.test(contactEmail)) {
          rowErrors.push({ field: 'contactEmail', code: 'INVALID', message: `"${contactEmail}" is not a valid email address.` });
        }

        const normalised: NormalisedChurch | null =
          rowErrors.length === 0
            ? {
                name,
                shortCode,
                zone: zoneRaw.trim() || null,
                contactPerson: contactPersonRaw.trim() || null,
                contactMobile: contactMobileRaw.trim() || null,
                contactEmail: contactEmail || null,
              }
            : null;

        results.push({
          rowNumber: r,
          raw: { name: nameRaw, shortCode: codeRaw, zone: zoneRaw, contactPerson: contactPersonRaw, contactMobile: contactMobileRaw, contactEmail: contactEmailRaw },
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
            event_id: req.eventId!,
            type: 'CHURCHES',
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
            eventId: req.eventId!,
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

  router.post(
    '/:batchId/commit',
    requireCapability(Capability.MANAGE_CHURCHES),
    validate({ params: z.object({ batchId: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { batchId } = req.params as { batchId: string };
      const actor = actorFromRequest(req);

      const batch = await db
        .selectFrom('import_batches')
        .selectAll()
        .where('id', '=', batchId)
        .where('event_id', '=', req.eventId!)
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
        const normalised = row.normalised as NormalisedChurch;
        try {
          await db.transaction().execute(async (trx) => {
            const clash = await trx
              .selectFrom('churches')
              .select('id')
              .where((eb) => eb.or([eb('name', 'ilike', normalised.name), eb('short_code', 'ilike', normalised.shortCode)]))
              .executeTakeFirst();
            if (clash) throw errors.conflict(`"${normalised.name}" or short code ${normalised.shortCode} already exists.`);

            const church = await trx
              .insertInto('churches')
              .values({
                name: normalised.name,
                short_code: normalised.shortCode,
                zone: normalised.zone,
                contact_person: normalised.contactPerson,
                contact_mobile: normalised.contactMobile,
                contact_email: normalised.contactEmail,
                created_by: req.auth!.userId,
                updated_by: req.auth!.userId,
              })
              .returningAll()
              .executeTakeFirstOrThrow();

            await writeAudit(
              {
                eventId: req.eventId!,
                actor,
                action: AuditAction.IMPORTED,
                entityType: 'church',
                entityId: church.id,
                newValue: { name: church.name, shortCode: church.short_code, batchId },
              },
              trx,
            );

            await trx
              .updateTable('import_rows')
              .set({ status: 'COMMITTED', created_entity_id: church.id })
              .where('id', '=', row.id)
              .execute();
          });
          committed += 1;
          rowResults.push({ rowNumber: row.row_number, status: 'COMMITTED' });
        } catch (err) {
          failed += 1;
          const message = err instanceof AppError ? err.message : 'Could not create this church.';
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
