import { buildApp } from "./app.js";
import { dbFile } from "./db.js";
import { migrate } from "./migrate.js";
import { rebaseStaleOpenOrders } from "./modules/outbound/service.js";
import { rebaseStaleOpenTrips } from "./modules/trips/service.js";
import { ensureDemoUsers, seedIfEmpty } from "./seed.js";

const applied = migrate();
const seeded = seedIfEmpty();
ensureDemoUsers();
const refreshedTrips = rebaseStaleOpenTrips();
const refreshedOrders = rebaseStaleOpenOrders();

const app = await buildApp({ logger: true });
if (applied.length) app.log.info({ applied }, "migrations applied");
if (seeded) app.log.info("seeded demo data");
if (refreshedTrips || refreshedOrders) app.log.info({ refreshedTrips, refreshedOrders }, "moved stale open jobs onto today's schedule");
app.log.info({ dbFile }, "database");

const port = Number(process.env.PORT ?? 3100);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`API docs at http://localhost:${port}/docs`);
