import { sqlite } from "./db.js";
import { migrate } from "./migrate.js";
import { seedIfEmpty } from "./seed.js";

const tables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .all() as { name: string }[];
sqlite.exec("PRAGMA foreign_keys = OFF");
for (const { name } of tables) sqlite.exec(`DROP TABLE IF EXISTS "${name}"`);
sqlite.exec("PRAGMA foreign_keys = ON");

migrate();
seedIfEmpty();
console.log("Database reset and reseeded. Restart the API if it is running.");
