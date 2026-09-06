/**
 * Database snapshots (FSD 5.15, ADM-15-02..05). Super Admin only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Capability, requireCapability } from '../../middleware/authorize.js';
import { requireLiveSession } from '../../middleware/authenticate.js';
import { requireActiveEvent } from '../../middleware/eventContext.js';
import { validate } from '../../middleware/validate.js';
import { actorFromRequest } from '../../services/audit.js';
import { createSnapshot, exportEventData, listSnapshots, restoreSnapshot } from '../../services/snapshots.js';
import { asyncHandler, created, ok } from '../../utils/http.js';

export function snapshotRoutes(): Router {
  const router = Router();
  router.use(requireActiveEvent());
  router.use(requireCapability(Capability.BACKUP_RESTORE));

  router.get(
    '/',
    asyncHandler(async (req, res) => ok(res, await listSnapshots(req.eventId!))),
  );

  /** ADM-15-03: manual "snapshot now", intended for use before any bulk operation. */
  router.post(
    '/',
    requireLiveSession(),
    validate({ body: z.object({ label: z.string().max(200).optional() }) }),
    asyncHandler(async (req, res) => {
      const { label } = req.body as { label?: string };
      const result = await createSnapshot(
        req.eventId!,
        'MANUAL',
        label,
        actorFromRequest(req),
        req.auth!.userId,
      );
      return created(res, result);
    }),
  );

  /** ADM-15-04: full data export in a restorable format. */
  router.post(
    '/export',
    requireLiveSession(),
    asyncHandler(async (req, res) => ok(res, await exportEventData(req.eventId!))),
  );

  /** ADM-15-05: restore is restricted to Super Admin, with a hard confirmation. */
  router.post(
    '/:id/restore',
    requireLiveSession(),
    validate({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ confirm: z.literal(true) }),
    }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as { id: string };
      await restoreSnapshot(id, req.eventId!, actorFromRequest(req), req.auth!.userId);
      return ok(res, { restored: true });
    }),
  );

  return router;
}
