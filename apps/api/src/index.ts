import { buildApp } from "./app.js";
import { prepareDatabase } from "./boot.js";
import { dbFile } from "./db.js";

const { applied, seeded, refreshedTrips, refreshedOrders } = prepareDatabase();

const app = await buildApp({ logger: true });
if (applied.length) app.log.info({ applied }, "migrations applied");
if (seeded) app.log.info("seeded demo data");
if (refreshedTrips || refreshedOrders) app.log.info({ refreshedTrips, refreshedOrders }, "moved stale open jobs onto today's schedule");
app.log.info({ dbFile }, "database");

const port = Number(process.env.PORT ?? 3100);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`API docs at http://localhost:${port}/docs`);
