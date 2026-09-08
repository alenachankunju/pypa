/**
 * Report generation (FSD 5.13). Real PDF/Excel output for every catalogue
 * report except certificates and badges, which are PDF-only print layouts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { activeEvent } from '../../middleware/eventContext.js';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import {
  badgeSheetReport,
  categoryResultsReport,
  certificatesReport,
  championSheet,
  churchDetailSheet,
  churchLeaderboardReport,
  consolidatedResultsReport,
  itemResultSheet,
  judgeActivityReport,
  participationListReport,
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

  router.get(
    '/consolidated',
    validate({ query: formatQuery }),
    asyncHandler(async (req, res) => {
      const { format } = req.query as unknown as { format: ReportFormat };
      const event = activeEvent(res);
      send(res, await consolidatedResultsReport(event.id, event.name, format));
    }),
  );

  router.get(
    '/category-results',
    validate({ query: formatQuery.extend({ categoryId: z.string().uuid().optional() }) }),
    asyncHandler(async (req, res) => {
      const { format, categoryId } = req.query as unknown as { format: ReportFormat; categoryId?: string };
      const event = activeEvent(res);
      send(res, await categoryResultsReport(event.id, event.name, format, categoryId));
    }),
  );

  router.get(
    '/churches/:churchId',
    validate({ params: z.object({ churchId: z.string().uuid() }), query: formatQuery }),
    asyncHandler(async (req, res) => {
      const { churchId } = req.params as { churchId: string };
      const { format } = req.query as unknown as { format: ReportFormat };
      const event = activeEvent(res);
      send(res, await churchDetailSheet(churchId, event.id, event.name, format));
    }),
  );

  router.get(
    '/call-sheet/:itemId',
    validate({ params: z.object({ itemId: z.string().uuid() }), query: formatQuery }),
    asyncHandler(async (req, res) => {
      const { itemId } = req.params as { itemId: string };
      const { format } = req.query as unknown as { format: ReportFormat };
      const event = activeEvent(res);
      send(res, await participationListReport(itemId, event.name, format));
    }),
  );

  router.get(
    '/certificates/:itemId',
    validate({ params: z.object({ itemId: z.string().uuid() }) }),
    asyncHandler(async (req, res) => {
      const { itemId } = req.params as { itemId: string };
      const event = activeEvent(res);
      send(res, await certificatesReport(itemId, event.name));
    }),
  );

  router.get(
    '/badges',
    asyncHandler(async (req, res) => {
      const event = activeEvent(res);
      send(res, await badgeSheetReport(event.id, event.name));
    }),
  );

  return router;
}
