import { buildApp } from "./app.js";
import { dbFile } from "./db.js";
import { migrate } from "./migrate.js";
import { ensureDemoUsers, seedIfEmpty } from "./seed.js";

const applied = migrate();
const seeded = seedIfEmpty();
ensureDemoUsers();

const app = await buildApp({ logger: true });
if (applied.length) app.log.info({ applied }, "migrations applied");
if (seeded) app.log.info("seeded demo data");
app.log.info({ dbFile }, "database");

const port = Number(process.env.PORT ?? 3100);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`API docs at http://localhost:${port}/docs`);
