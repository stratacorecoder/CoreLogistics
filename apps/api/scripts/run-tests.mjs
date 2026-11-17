import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
if (!env.CORELOGISTICS_DB) env.CORELOGISTICS_DB = ":memory:";
env.CORELOGISTICS_OLLAMA = "0";

const files = [
  "src/flow.test.ts",
  "src/copilot-scheduling.test.ts",
  "src/copilot-queue.test.ts",
  "src/copilot-ask.test.ts",
  "src/stock-confirm.test.ts",
  "src/operator-access.test.ts",
  "src/release-validation.test.ts",
];

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: apiRoot,
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
