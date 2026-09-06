/**
 * Report generation (FSD 5.13). Real PDF/Excel output for the four highest-
 * value reports; the rest of the catalogue (consolidated results, call
 * sheets, certificates, badges) remains the Phase 4 placeholder in Reports.tsx.
 */
import { Router } from 'express';
import { z } from 'zod';
import { activeEvent } from '../../middleware/eventContext.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import {
  championSheet,
  churchLeaderboardReport,
  itemResultSheet,
  judgeActivityReport,
  type ReportFormat,
} from '../../services/reports/reports.js';
import { asyncHandler } from '../../utils/http.js';

const formatQuery = z.object({ format: z.enum(['pdf', 'xlsx']).default('pdf') });

function send(res: import('express').Response, file: { buffer: Buffer; contentType: string; filename: string }): void {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
}

export function reportRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());
  router.use(requireCapability(Capability.EXPORT_REPORTS));

  router.get(
    '/items/:itemId',
    validate({ params: z.object({ itemId: z.string().uuid() }), query: formatQuery }),
    asyncHandler(async (req, res) => {
      const { itemId } = req.params as { itemId: string };
      const { format } = req.query as unknown as { format: ReportFormat };
      const event = activeEvent(res);
      send(res, await itemResultSheet(itemId, event.name, format));
    }),
  );

  router.get(
    '/church-leaderboard',
    validate({ query: formatQuery }),
    asyncHandler(async (req, res) => {
      const { format } = req.query as unknown as { format: ReportFormat };
      const event = activeEvent(res);
      send(res, await churchLeaderboardReport(event.id, event.name, format));
    }),
  );

  router.get(
    '/champions',
    validate({ query: formatQuery }),
    asyncHandler(async (req, res) => {
      const { format } = req.query as unknown as { format: ReportFormat };
      const event = activeEvent(res);
      send(res, await championSheet(event.id, event.name, format));
    }),
  );

  router.get(
    '/judge-activity',
    validate({ query: formatQuery }),
    asyncHandler(async (req, res) => {
      const { format } = req.query as unknown as { format: ReportFormat };
      const event = activeEvent(res);
      send(res, await judgeActivityReport(event.id, event.name, format));
    }),
  );

  return router;
}
