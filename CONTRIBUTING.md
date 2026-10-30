# Working on CoreLogistics

## First-time setup

1. Install Node 22.13 or newer (the repo pins 24 in `.nvmrc`; `nvm use` picks it up). Git and npm are the only other tools needed.
2. Clone and install:

   ```bash
   git clone <repo url> corelogistics
   cd corelogistics
   npm ci
   npm run dev
   ```

3. Open the Control Tower at http://localhost:5180. The API creates and seeds `apps/api/data/corelogistics.db` on first start; nothing else needs configuring.

Each developer has their own local database. It is not committed. Run `npm run db:reset` (with the API stopped) to get back to clean demo data.

If one of the default ports is taken, see `.env.example` for the overrides.

## Where things live

| Area | Code |
| --- | --- |
| Shared types and validation (the API contract) | `packages/contracts/src/<domain>.ts` |
| Database schema | `apps/api/migrations/NNN_name.sql` |
| Business rules | `apps/api/src/modules/<domain>/service.ts` |
| HTTP endpoints | `apps/api/src/modules/<domain>/routes.ts`, registered in `apps/api/src/app.ts` |
| Demo data | `apps/api/src/seed.ts` |
| Shared React pieces (site map, API client, live updates, modals) | `packages/ui/src` |
| Role apps | `apps/control-tower`, `apps/gate`, `apps/warehouse`, `apps/driver` |

Domains: `sites` (layouts and locations), `fleet` (vehicles, drivers, maintenance, devices), `trips`, `gate` (visits, yard, docks), `warehouse` (receiving, sorting, putaway, inventory), `outbound` (orders, picking, shipments), `ingest` (camera/RFID/GPS), `analytics`, `stream` (live updates).

## Adding a feature end to end

1. **Contract:** add or extend the Zod schema in `packages/contracts`. Both the API and the apps import the type from here, so never redefine it locally.
2. **Schema:** add a new migration file with the next number (for example `002_trailer_temperature.sql`). Never edit a migration that has already been shared: other people's databases have already run it.
3. **Service:** put the logic in the domain's `service.ts`. Every write must:
   - run inside `tx(...)` when it touches more than one row,
   - call `emit(ctx, {...})` with a readable `message`, which records the event and pushes it to every open app,
   - use `at(ctx)` for timestamps instead of `new Date()`, so device events and seed history keep their real times.
4. **Route:** declare `params`, `querystring`, `body` and `response` schemas from the contracts. Responses are validated, so a mismatch fails loudly in development.
5. **UI:** read with `useApi(path)` and write with `useAction()`. Lists refresh automatically when a related event arrives over the live stream.
6. **Check:** `npm run typecheck` must pass. Then walk the flow in the apps (the demo walkthrough in the README covers the main paths).

## Rules that keep a Python port possible

The backend may be rewritten in Python (FastAPI + Pydantic), so:

- Keep all business logic in `service.ts` files. Route handlers only parse input and call a service.
- Plain SQL only: no ORM, no SQLite-only tricks that the Python `sqlite3` module would not run.
- Every endpoint has full Zod schemas, so `npm run openapi` produces a complete spec to port against.
- Apps talk to the API over HTTP and `/stream` only, never to the database or to API internals.

## Git workflow

- Branch from `main` and name branches by area, such as `gate/seal-photos` or `warehouse/cycle-counts`.
- Keep pull requests to one feature and include the migration, contract, service, route and UI changes together.
- In the PR description, list how you tested it (which app, which steps).
- Do not commit `.env` files, database files or device keys other than the `demo-*` ones from the seed.
