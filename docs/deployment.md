# Deployment

CoreLogistics runs as one Node 22.13+ process. The API owns the SQLite database, the business rules, and the live event stream. The four web apps are static Vite builds that call that API.

## Persistent storage

Set `CORELOGISTICS_DATA_DIR` to a directory that survives restarts, and leave `CORELOGISTICS_DB` as a file name (the default is `corelogistics.db`). The API creates the directory and opens the file with WAL mode. `:memory:` is for tests only.

The container image expects the database at `/app/data`. Mount a volume there. `npm start` applies migrations and does not load demo data.

Demo sites, the published demo passwords, and the startup move of stale open trips and orders onto today run only when the process is started with `--demo` or `CORELOGISTICS_DEMO=1`. `npm run dev` passes `--demo`. `npm run db:reset` wipes and reseeds the operational demo rows; demo logins are issued on the next demo start.

## HTTPS for phones and handhelds

The warehouse scanner and the driver app need a secure origin before a browser will allow the camera. Terminate TLS at the reverse proxy and serve the built apps and the API on that origin. Point the apps at the API with `VITE_API_URL` at build time. Browsers on the warehouse floor and in the cab should use the HTTPS host, not a raw IP over HTTP.

## Monitoring

`GET /health` is public and returns `ok`, `heartbeatAt`, `backlog`, and `failedJobs`. `GET /copilot/monitoring` (signed in) adds the cursor, the last sweep, and the event types the worker actually watches. The copilot drawer shows loading, disconnected, processing-failed, pending-review, and empty separately. "No pending recommendations" is only the empty state after a successful fetch while the worker is running and the stream is online.

A failed disruption job stays failed until a Tower user retries it from the drawer or `POST /copilot/jobs/:id/retry`. Auto-pilot stays off until the release gate. When it is turned on, the server still auto-runs only low and medium appointment reschedules.

## Recovery

Migrations are forward-only files in `apps/api/migrations`. On startup the API applies any file not recorded in `schema_migrations`.

To back up, stop the API or let a checkpoint finish, then copy the database file. To restore, stop the API, replace the file, remove any leftover `-wal` and `-shm` files, and start again. A job left in `processing` by a crash is queued again on the next start without adding an attempt.

## Checks

`npm test` runs the API suite and the scanner and monitoring checks. It sets an in-memory database when `CORELOGISTICS_DB` is unset, including on Windows. `npm run typecheck` and `npm run build` cover the workspaces. `npm run audit:triage` fails when a dependency advisory appears outside the six deferred major upgrades, or when one of those six gains a non-major fix.

The deferred upgrades are `@fastify/static`, `@fastify/swagger-ui`, `fastify-type-provider-zod`, `glob`, `minimatch`, and `zod`. Each published fix changes a major version. The static-host issues sit behind Swagger UI. Zod's memory advisory applies to unbounded collections; the route schemas already bound request bodies. Do not run `npm audit fix --force`.
