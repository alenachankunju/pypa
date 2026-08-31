# API Reference

All routes are mounted under `/api`. Every response uses the envelope described in FSD §9:

```json
{ "success": true, "data": { ... }, "meta": { "requestId": "..." } }
{ "success": false, "error": { "code": "MARK_OUT_OF_RANGE", "message": "...", "details": {...} }, "meta": {...} }
```

Error codes are the FSD §9.4 table plus the extensions in `backend/src/utils/errors.ts` (`ErrorCode`). Every endpoint below except `/auth/login` and `/auth/refresh` requires `Authorization: Bearer <access token>`.

## Authentication — `/api/auth`

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | `/login` | Sign in | Rate-limited 10/min/IP (FSD §11.2) |
| POST | `/refresh` | Rotate the refresh token, issue a new access token | |
| POST | `/logout` | Revoke the current session | |
| POST | `/change-password` | ADM-01-05 forced change / voluntary change | Revokes every *other* session |
| GET | `/me` | Current identity, role, capabilities | Capabilities are a UI convenience only (FSD §3.2) — every route below re-checks server-side |

There is **no** registration endpoint anywhere (AC-02).

## Judge namespace — `/api/judge` (role: JUDGE only)

Every route here is scoped to the judge's own assignment (FSD §6.9 — a judge can never see another judge's data).

| Method | Path | FSD ref |
|---|---|---|
| GET | `/sessions` | JDG-01-02/03 |
| GET | `/sessions/:id/bundle` | JDG-08-01 — the offline cache payload |
| GET | `/current?sessionId=` | JDG-02-01 |
| GET | `/search?sessionId=&q=` | JDG-03 |
| GET | `/members/:memberId/items?sessionId=` | JDG-04 |
| POST | `/scores` | JDG-05/06 — idempotent, immutable |
| GET | `/my-scores?sessionId=&itemId=` | JDG-07 — read-only |

## Administration — `/api/admin/*` (roles per FSD §3.2 matrix; judges get 403 on the whole tree)

### Users — `/users`
`GET /`, `POST /`, `PATCH /:id`, `POST /:id/reset-password`, `POST /:id/force-logout`, `POST /:id/release-device-pin`, `POST /:id/unlock`

### Churches — `/churches`
`GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` (refused with `IN_USE` if members exist — ADM-02-03)

### Categories — `/categories`
`GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` — list response includes `meta.bandWarnings` (ADM-03-04)

### Items — `/items`
`GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/cancel`, `DELETE /:id`, `PUT /:id/criteria`

### Members — `/members`
`GET /`, `GET /by-chest/:chestNumber`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` (soft — reserves the chest number), `GET /:id/eligible-items`

### Registrations — `/registrations`
`GET /`, `POST /`, `POST /teams`, `DELETE /:id` (withdraws, never deletes), `POST /call-order`

### Panels — `/panels`
`GET /`, `POST /`, `PATCH /:id`, `POST /:id/judges`, `DELETE /:id/judges/:userId`

### Sessions — `/sessions`
`GET /`, `POST /`, `PATCH /:id`, `POST /:id/open`, `POST /:id/close`, `GET /:id/progress` (drives the whole live console)

### Performances — `/performances`
`POST /`, `POST /:id/set-current`, `POST /advance`, `POST /:id/absent`, `POST /:id/void`, `POST /:id/reinstate`

### Scores — `/scores`
`POST /:id/revoke`, `GET /performance/:performanceId`, `POST /back-entry` (FSD §11.4 paper contingency)

### Results — `/results`
`GET /summary`, `GET /items`, `GET /items/:id`, `POST /items/:id/provisional`, `POST /items/:id/publish`, `POST /publish-all`, `POST /items/:id/unpublish`, `POST /items/:id/withhold`, `POST /items/:id/resolve-tie`, `GET /churches?provisional=`, `GET /champions`, `POST /recompute`, `GET /recompute-runs`

### Config — `/config`
`GET /scoring`, `PUT /scoring` (refused `CONFIG_LOCKED` once anything is published), `POST /scoring/unlock` (two-phase: `dryRun` then `confirmUnpublishAll`), `PUT /scoring/items/:itemId/points`

### Audit — `/audit`
`GET /` (search by date/actor/action/entity), `GET /filters`, `GET /exceptions` (ADM-10-04)

### Events — `/events`
`GET /`, `GET /active`, `POST /`, `PATCH /:id`, `POST /:id/activate`, `POST /:id/freeze`, `POST /:id/archive`

### Dashboard — `/dashboard`
`GET /`, `GET /setup-checklist` (FSD §13), `GET /readiness` (the pre-event readiness report)

## Standard error codes (FSD §9.4 + extensions)

See `backend/src/utils/errors.ts` for the authoritative list and the exact wording returned. The FSD-mandated eleven (`ALREADY_SCORED`, `SESSION_NOT_OPEN`, `NOT_ON_PANEL`, `PERFORMANCE_LOCKED`, `MARK_OUT_OF_RANGE`, `DUPLICATE_CHEST_NUMBER`, `INELIGIBLE_ITEM`, `ENTRY_LIMIT_EXCEEDED`, `RESULT_PUBLISHED`, `CONFIG_LOCKED`, `TIE_UNRESOLVED`) carry the exact HTTP status the FSD table specifies.

## Idempotency

`POST /judge/scores` requires an `idempotencyKey` (generated client-side at *confirm* time, per JDG-06-04). A repeated key returns the original result rather than an error or a duplicate row — this is what makes the offline queue and network retries safe (FSD §7.2, §8.2).
