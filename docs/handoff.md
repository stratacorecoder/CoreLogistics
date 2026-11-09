# Handoff: production readiness, stages 1–5b

Audit this against the code and by re-running the checks below. Nothing here is a release sign-off. Auto-Pilot stays off. Stage 5b is a sheet for people with the devices; it has not been executed.

Last local run on 9 Nov 2026: `npm test` passed 55 API tests and 6 UI tests, `npm run typecheck` exited 0, `npm run build` exited 0, and `npm run audit:triage` reported the six deferred major upgrades. Re-run them. Do not treat this paragraph as evidence.

## How to re-check

From the repo root, on Node 22.13+:

```powershell
npm test
npm run typecheck
npm run build
npm run audit:triage
```

`npm test` sets an in-memory database when `CORELOGISTICS_DB` is unset, including on Windows. CI is `.github/workflows/release.yml` and runs those four commands on Node 22.

| Suite | File |
| --- | --- |
| Auth, dock overlap, FEFO, e-POD, ingest, copilot happy path | `apps/api/src/flow.test.ts` |
| Appointment windows, overlap, checked-in and cancelled, stale revision, rollback, auto-pilot, actor, lost and racing apply | `apps/api/src/copilot-scheduling.test.ts` |
| Event dedup, escalation, resolve, restart listener, retry then Tower requeue, failed-job list | `apps/api/src/copilot-queue.test.ts` |
| Wrong label, other site, hazmat, capacity, Tower override, idempotent pick and putaway | `apps/api/src/stock-confirm.test.ts` |
| Driver trip scope, warehouse confirm role | `apps/api/src/operator-access.test.ts` |
| Migration, backup and restore, crashed job, demo opt-in | `apps/api/src/release-validation.test.ts` |
| Copilot surfaces and copy | `packages/ui/src/copilotSurface.test.ts` |
| Scanner session | `packages/ui/src/scanSession.test.ts` |
| Lost connection versus a certain rejection | `packages/ui/src/confirmError.test.ts` |

Migrations `001`–`003` were already applied history. This work added `004` through `008` and did not edit an applied file.

| Migration | What it adds |
| --- | --- |
| `004_copilot.sql` | Recommendations, config, events |
| `005_copilot_preconditions.sql` | Preconditions used at apply time |
| `006_copilot_jobs.sql` | Job queue, cursor, revision history, `resolved` status. Rebuilds the recommendation table and keeps prior rows |
| `007_stock_confirmations.sql` | Request-id dedup for pick and putaway |
| `008_copilot_actor.sql` | Nullable `actor` column. No table rebuild |

The on-disk demo file `apps/api/data/corelogistics.db` was used for browser checks. Do not reset it as part of an audit unless the operator asks. Browser checks used warehouse `http://localhost:5182` as Mina and Control Tower `http://localhost:5180` as Ava.

## Stage 1 — scheduling and copilot execution

Appointment moves go through the gate service. A proposed window keeps the original duration, is not earlier than the booked window, and must still be in the future. Missing trip timing becomes a manual review. Preconditions are stored and checked again inside the apply transaction. A dock swap reuses dock assignment. Unknown actions are rejected before writes. Apply and dismiss send the revision the planner reviewed.

A mismatch refreshes the recommendation outside the failed transaction and returns 409 `Recommendation changed; review revision N`. Any `scheduled` or `checked_in` appointment whose window has not ended reserves the dock. Success events commit with the change. `copilot.failed` is written after rollback. An empty action list is a 400 and is audited.

Auto-apply is allowed only when Auto-Pilot is on, severity is low or medium, and every action is `reschedule_appointment`. The server enforces that. Windows are judged with `Date.now()`. The system actor is null.

## Stage 2 — disruption queue and escalation

`apps/api/src/modules/copilot/worker.ts` is a durable SQLite queue. Each monitored event is queued once. The worker claims jobs in order. Failures wait 5 seconds, then 30 seconds, then the job is `failed` at 3 attempts. `POST /copilot/jobs/:id/retry` is Tower-only and resets the attempt count.

The first install sets the cursor to the current max event id and does not replay history. Later restarts continue from the cursor. A job left in `processing` is queued again without burning an attempt. Copilot’s own events are not queued.

Monitored types, in this order: `trip.issue`, `trip.updated`, `trip.dispatched`, `trip.departed`, `trip.arrived`, `trip.stop_arrived`, `trip.stop_departed`, `trip.completed`, `trip.cancelled`.

One open recommendation per trip. The same event does not bump the revision. A new event after dismiss, apply, or resolve creates a new row. `trip.issue` raises severity only: breakdown and accident are critical, seal breach and traffic are high, otherwise medium. Lifecycle events do not change severity or root cause. `trip.cancelled` and `trip.completed` resolve the open row. A trip that is no longer delayed does not by itself resolve a row. A review with no safe action stays `status=pending` and `lifecycle=human_review`.

`GET /health` is public and returns `ok`, `heartbeatAt`, `backlog`, and `failedJobs`. `GET /copilot/monitoring` is signed in and adds the cursor, last sweep, and `monitoredEvents`.

## Stage 3 — camera and stock confirmation

The scanner uses the rear camera, a torch control only when the track reports one, and an explicit **Resume camera** after the page is hidden. It does not restart itself. Native `BarcodeDetector` is used when present. Otherwise `@zxing/browser` decodes the stream that is already open. Formats are QR, Code 128, Code 39, EAN-13, EAN-8, UPC-A, and UPC-E. A detected code fills the field. Stock changes only when the operator submits.

Pick and putaway confirmation is one contract with `mode` `match` or `override`, a request id, an entry method of `camera`, `keyboard`, or `manual`, and the barcodes. The server matches codes inside the stock transaction. Match checks the source pallet for a pick and both the unit and a real bin for putaway. A bin that is valid at the site is accepted even when it is not the suggestion. The client cannot send a location id. Choosing a bin on the map fills that bin’s code as a manual entry.

Tower override requires a reason of at least 3 characters and `role === "tower"`. It skips barcode equality and still enforces stock, site, capacity, and hazmat. The warehouse app only shows the override controls when the signed-in role is tower, and that app redirects anyone who is not warehouse, so floor users do not see the bypass. The API still rejects a non-tower override.

The same request id and the same input return the original result and do not move stock again. The same id with different input after a committed success is 409. A wrong label, a stale task, or a permission error does not store a dedup row, so a corrected code can reuse the id. A network failure or HTTP 500 keeps the codes and is retried with the same id. Capacity and hazmat rejections are certain.

Demo seed and RFID ingest confirm through match mode with the real codes and `entryMethod: "manual"`. A driver scan stores a delivery-note reference. The driver screen says it does not prove the document or the seal.

Browser check: warehouse as Mina, wrong unit and wrong pallet kept the typed codes, a matching putaway stored the unit, and a matching pick completed. The camera permission prompt was blocked, so torch, rear camera, and resume-after-background were not exercised on hardware.

## Stage 4 — monitoring and operator scope

The copilot badge and drawer distinguish loading, disconnected, processing-failed, pending-review, and empty. **No pending recommendations** is only the empty state after a successful fetch, with the worker running and the stream not offline. A stream that is still connecting is not treated as disconnected. The watched-event sentence comes from `GET /copilot/monitoring`. The drawer shows revision, cause, impact, proposed window, auto-pilot eligibility, execution error, superseded revisions, and history with actor. Apply is disabled when there are no executable actions. Dismiss stays available. A 409 stays on the card and the list reloads.

History actor: the stored name when present, **System** for `auto_applied` or `resolved` with a null actor, **Not recorded** for older applied or dismissed rows with a null actor.

`GET /copilot/jobs` lists the existing job resource. Retry stays Tower-only. Apply, dismiss, config, and retry stay Tower-protected.

Stock confirm on the pick and putaway routes requires warehouse or tower before the service runs. A driver or gate login gets 403 and does not consume a request id. Receive, sort, and other warehouse writes were left as they were.

Trip association applies only when `role === "driver"`. A driver with no `driverId` is rejected. A driver cannot create, patch, dispatch, or cancel a trip. Depart, arrive, complete, stop moves, issues, and reading one trip require that trip’s driver. `GET /trips` is forced to that driver’s own id. Tower, warehouse, and gate trip actions are unchanged, which is why the existing tower flow tests still depart trips assigned to other drivers.

Browser check: Ava opened Copilot, saw loading and then the empty state, the nine monitored events, heartbeat, backlog 0, failed jobs 0, and Auto-Pilot off. There was no live pending card, failed job, or stale 409 to click.

## Stage 5a — automated release checks

`apps/api/scripts/run-tests.mjs` is the Windows-safe test entry. A concurrent apply and a repeated apply of the same recommendation reschedule once. `apps/api/src/release-validation.test.ts` migrates a disposable file, seeds only when demo mode is on, restores a backup, and recovers a crashed job without adding an attempt or rebasing the trip.

`demoMode()` in `apps/api/src/boot.ts` is on only for `--demo` or `CORELOGISTICS_DEMO=1`. `CORELOGISTICS_DEMO=0` forces it off. Production `npm start` and the Docker image do not pass `--demo`, so they do not seed, do not write demo passwords, and do not move stale open trips or orders onto today. `npm run dev` passes `--demo` only after that process is started from the current `package.json`. The dev server that was already running predates that script change.

`docs/deployment.md` covers the SQLite file, HTTPS for the camera, health and monitoring, and backup restore. `scripts/audit-triage.mjs` allows exactly these six packages, all of whose fixes are major upgrades: `@fastify/static`, `@fastify/swagger-ui`, `fastify-type-provider-zod`, `glob`, `minimatch`, and `zod`. A new advisory, or a non-major fix for one of those six, fails the script. `npm audit fix --force` was not run.

The scanner checks exercise `packages/ui/src/scanSession.ts`: fallback decoder, permission denial, one delivery per session, no camera restart after background, and cleanup. They do not open a physical camera.

## Stage 5b — physical sheet only

`docs/physical-acceptance.md` is the sheet. It records Android handheld Chrome, Android driver Chrome, and iPhone Safari, with real labels, lighting, and connectivity, then Tower sign-off. It has not been filled in. Do not switch Auto-Pilot on to complete it.

## Release gate

Still open. Automated checks were green locally and must be re-run, including CI. The physical sheet is unsigned. Ops has not accepted manual execution or the limited automatic path. Auto-Pilot stays off until that gate.

## Assumptions an auditor should keep

- `human_review` is a lifecycle on `status=pending`, not a separate status.
- Only a cancelled or completed trip resolves an open recommendation.
- Driver restrictions apply only to `role === "driver"`.
- Stock confirm allows warehouse and tower. Other warehouse writes were not narrowed.
- A map bin choice is a manual barcode, not a client location id.
- RFID ingest and demo seed use match mode.
- Uncertain retries are network failures and HTTP 500 and above.
- A null actor displays as System for auto-applied and resolved rows, and as Not recorded for older applied or dismissed rows.
- The public health payload includes backlog counts.

## Out of scope

No LLM copilot. No offline action queue. No new runtime dependency besides `@zxing/browser`. No edit to migrations `001`–`007` after they were added. No major dependency upgrade. No physical camera run.
