import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../openapi.json");
const app = await buildApp();
await app.ready();
fs.writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
console.log(`OpenAPI spec written to ${out}`);
