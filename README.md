# CoreLogistics

Fleet, yard and warehouse management in one system: trucks and drivers, trips with departure and arrival tracking, gate and yard control, dock doors, inbound receiving, rule-based sorting, putaway, picking, staging and loading, plus network analytics.

Every action is recorded manually from the apps today. Cameras (ANPR), RFID readers and GPS trackers can feed the same pipeline through `/ingest/events`.

## Run it

Requires Node 22.13+ (uses the built-in `node:sqlite`). New to the codebase? Start with [CONTRIBUTING.md](CONTRIBUTING.md).

```powershell
npm ci
npm run dev        # API + all four apps
npm run db:reset   # wipe and reseed the demo data (API stopped)
```

| What | URL |
| --- | --- |
| API | http://localhost:3100 |
| OpenAPI docs | http://localhost:3100/docs |
| Control Tower | http://localhost:5180 |
| Gate & Yard | http://localhost:5181 |
| Warehouse floor | http://localhost:5182 |
| Driver | http://localhost:5183 |

The database lives at `apps/api/data/corelogistics.db` and is seeded with a week of history on first start. See `.env.example` for the port, database and API URL overrides.

## Apps

- **Control Tower** (planners): live site map, dispatch board, fleet, drivers, maintenance, device registry, site layout designer, analytics.
- **Gate & Yard** (guards): expected arrivals and collections, check-in/out by plate, auto yard slot, dock suggestion and assignment, yard moves.
- **Warehouse floor** (tablet): receive against a receipt, sort by rules, putaway to the suggested bin, release and pick orders FIFO, stage, build shipments and load with weight/volume checks.
- **Driver** (phone): current trip, confirm departure, stops and arrival, report a problem.

Sign in with an issued username and password. The account’s role opens the matching app; your name is recorded on every action. Demo logins:

| Username | Password | App |
| --- | --- | --- |
| `ava` | `planner` | Control Tower |
| `rico` | `yard` | Gate & Yard |
| `mina` | `floor` | Warehouse |
| `jose` … `nina` (first name) | `drive` | Driver (tied to that person) |

## Demo walkthrough

1. Gate (WH-C): pick the waiting truck in **On site**, send it to the suggested dock. Unloading at a warehouse opens a receipt.
2. Warehouse → Receive: receive units against that receipt (set "Cross-dock to" for freight that ships straight out).
3. Sort: each unit goes to a lane by rule; a putaway task suggests a bin (hazmat only to H bins).
4. Putaway: confirm the bin, or tap a rack and choose another.
5. Pick & stage: release an order, confirm picks, stage at a staging lane.
6. Load: build a shipment, attach the outbound trip, load once the truck is at a dock, then close it. The trip departs when the truck checks out at the gate.
7. Driver: confirm arrival at the customer and finish the trip.

## Automation ingest

Devices are registered in Control Tower → Fleet → Devices (the key is shown once). The seed creates these demo keys:

| Key | Device |
| --- | --- |
| `demo-wh-gate-cam` | WH-C gate ANPR camera |
| `demo-depot-gate-cam` | Depot gate ANPR camera |
| `demo-wh-dock1-rfid` | WH-C dock D01 portal reader |
| `demo-wh-bin-rfid` | WH-C bin R01-1 shelf reader |
| `demo-gps-t01` | T01 telematics |
| `demo-gps-t02` | T02 telematics |

```bash
# Camera at a gate: checks the truck in (or out with "direction": "out")
curl -X POST http://localhost:3100/ingest/events \
  -H "content-type: application/json" -H "x-device-key: demo-wh-gate-cam" \
  -d '{"type":"plate_read","plate":"<plate>","direction":"in"}'

# RFID at a dock door: a truck tag docks the truck; an HU tag loads it
curl -X POST http://localhost:3100/ingest/events \
  -H "content-type: application/json" -H "x-device-key: demo-wh-dock1-rfid" \
  -d '{"type":"rfid_read","tag":"E200-TRK-0004"}'

# GPS: geofences mark trips departed/arrived; positions are throttled
curl -X POST http://localhost:3100/ingest/events \
  -H "content-type: application/json" -H "x-device-key: demo-gps-t01" \
  -d '{"type":"gps_ping","lat":14.33,"lng":121.08,"speedKph":62}'
```

Every read is resolved by the same services the apps call, and the resulting event carries `source: camera | rfid | gps`.

## Layout

```
apps/api            Fastify + node:sqlite, all business rules, plain SQL migrations
apps/control-tower  React + Vite
apps/gate           React + Vite
apps/warehouse      React + Vite
apps/driver         React + Vite
packages/contracts  Zod schemas, enums and shared types (the API contract)
packages/ui         Shared React components, site map renderer, API/SSE client
```

## Porting the backend to Python

The backend is kept deliberately portable:

- All business logic lives in `apps/api/src/modules/*/service.ts`; the apps only call HTTP endpoints.
- The schema is plain SQL in `apps/api/migrations/` and runs unchanged on SQLite from Python.
- `npm run openapi` writes `apps/api/openapi.json`, generated from the Zod contracts. A FastAPI + Pydantic port can be checked against it.
- Live updates use Server-Sent Events on `/stream` (`event: event`, JSON body, `Last-Event-ID` replay), which maps directly to a Starlette `StreamingResponse`.
- No ORM, no framework-specific features in the data model.
