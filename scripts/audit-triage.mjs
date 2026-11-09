import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** These six need a major upgrade. A new advisory, or a non-major fix, fails this check. */
const deferred = {
  "@fastify/static": "Path traversal and non-canonical path bypass in the Swagger UI static host. The API does not serve operator uploads through it. Fix is @fastify/swagger-ui 6.",
  "@fastify/swagger-ui": "Reaches the static-host advisories. Compatible 5.x builds still pull the affected static package.",
  "fastify-type-provider-zod": "Reported through Zod. The compatible line stops at 4.0.2; the fix is provider 7 with Zod 4.",
  glob: "AbortSignal and minimatch issues inside the static file host, not application code.",
  minimatch: "Glob amplification inside the same static host.",
  zod: "Memory use while validating huge collections. Request bodies are already bounded by the route schemas. The fix is Zod 4.",
};

const audit = spawnSync("npm audit --json", { cwd: root, encoding: "utf8", shell: true });
if (audit.status !== 0 && audit.status !== 1) {
  console.error(audit.stderr || audit.stdout || "npm audit did not run");
  process.exit(audit.status ?? 1);
}
const report = JSON.parse(audit.stdout || "{}");
if (!report.vulnerabilities) {
  console.error(audit.stderr || "npm audit returned no vulnerability report");
  process.exit(1);
}
const found = Object.keys(report.vulnerabilities ?? {});
const unexpected = found.filter((name) => !Object.hasOwn(deferred, name));
const resolved = Object.keys(deferred).filter((name) => !found.includes(name));
const compatible = found.filter((name) => report.vulnerabilities[name]?.fixAvailable && report.vulnerabilities[name].fixAvailable.isSemVerMajor === false);

if (unexpected.length || compatible.length) {
  console.error(JSON.stringify({ unexpected, compatible, resolved }, null, 2));
  process.exit(1);
}

console.log(`Dependency audit: ${found.length} deferred major upgrades (${found.sort().join(", ")}).`);
if (resolved.length) console.log(`No longer reported: ${resolved.join(", ")}.`);
