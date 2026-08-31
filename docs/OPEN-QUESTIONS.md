# Open Questions for the Committee

The FSD (§17) lists seventeen questions with recommended defaults, "so that work is not blocked, but each should be explicitly confirmed." This build implements every recommended default exactly as specified, all of them **configurable** through the admin console (`/admin/config`) rather than hardcoded — so confirming or changing an answer here is a settings change, not a code change.

## FSD §17 — implemented as configurable, defaults applied

| # | Question | Default implemented | Where to change it |
|---|---|---|---|
| Q1 | Exact categories, age bands, cut-off date | *No default possible — supplied by committee* | `/admin/categories`, `/admin/settings` |
| Q2 | Panel size fixed or variable? | Configurable per panel, no assumption of 3 anywhere in the schema | `/admin/panels` |
| Q3 | Aggregation method | Average | `/admin/config` |
| Q4 | Points for 1st/2nd/3rd | 5, 3, 1 | `/admin/config` |
| Q5 | Third-place points awarded? | Yes | `/admin/config` |
| Q6 | Shared positions permitted? | No — resolve by tie-break, escalate if unresolved | `/admin/config` |
| Q7 | Tie-break order | As FSD §4.5: judge-top-mark-count → highest-single-mark → lowest-spread → chief-judge-mark | `/admin/config` (drag order not yet in the UI — reorder via `PUT /api/config/scoring` `tiebreakOrder` array) |
| Q8 | Grades used / carry points? | Displayed; grade points disabled | `/admin/config` |
| Q9 | Group item weight multiplier | 2.0 | Per-item, `/admin/items` |
| Q10 | Cap on items per member | 4 | `/admin/config` |
| Q11 | Cap on entries per church per item | 1 (configurable per item) | `/admin/items` |
| Q12 | Stage Coordinator staffed? | Role implemented; falls back to Admin/Super Admin on the live console | N/A — both work identically against `CONTROL_STAGE`/`MARK_ABSENT` |
| Q13 | Single mark or multiple criteria? | Single mark by default; criteria available per item | `PUT /api/admin/items/:id/criteria` |
| Q14 | Minimum items for individual champion | 2 | `/admin/config` |
| Q15 | Results public during event or only at announcement? | Only at announcement — no public route exists; `/admin/results/champions` and `/admin/results/churches` require `VIEW_PROVISIONAL_RESULTS` | N/A |
| Q16 | On-site fallback server available? | Not provisioned in this build — `backend/src/server.ts` runs identically outside Netlify if one is needed | Deploy separately if required |
| Q17 | Who holds Super Admin credentials? | One seeded account (`npm run db:seed`); create more via `/admin/users` once signed in | Organisational decision |

## Implementation assumption requiring confirmation

**Group-item points for individual standings.** The FSD specifies clearly how a *church's* points are counted from a team result (the team's points credit the owning church once — FSD §4.7.4) but does not state whether a team's points count toward *each team member's own* individual champion total (FSD §4.7.6).

This build assumes **yes** — every member of a scoring team is credited the team's full points for individual-standings purposes (see `backend/migrations/0010_views.sql`, view `v_member_points`, and the comment on `backend/src/services/results/standings.ts`). This is the more generous reading and matches how a group item's points are described as being "worth more" (§4.7.2) for those who took part.

**If the committee intends group-item points to count only toward the church total and NOT toward any individual's personal champion tally**, that is a one-line change: exclude the `UNION ALL` branch for team registrations in `v_member_points`. Flag this to the development team before the first event where group items are scored, since it changes who wins Individual Champion.

## Not yet built (Phase 4/5 items, FSD §16)

These are explicitly out of scope for this pass and tracked here rather than silently dropped:

- PDF/Excel generation for the report catalogue in FSD §5.13 (the *data* for every report — item results, church leaderboard, judge activity, exceptions — is already served by the API; only the file-rendering layer is pending)
- CSV/Excel bulk import commit flow (the `import_batches`/`import_rows` schema exists; the parsing and preview UI does not)
- Certificate and badge PDF merge-printing
- Scheduled automatic snapshots (manual snapshot-before-bulk-operation is supported; the 15-minute cron is a deployment step — see `docs/DEPLOYMENT.md`)
- On-site fallback server provisioning (Q16)
- Drag-to-reorder UI for the tie-break sequence (the API and engine fully support any order; only the admin control for reordering visually is missing — it's currently a raw array field)
