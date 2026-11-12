import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");

export interface E2ECluster {
  urls: {
    api: string;
    tower: string;
    gate: string;
    warehouse: string;
    driver: string;
  };
  browser: Browser;
  stop: () => Promise<void>;
}

async function allocatePorts(count: number): Promise<number[]> {
  const servers: net.Server[] = [];
  try {
    const ports: number[] = [];
    for (let i = 0; i < count; i++) {
      const srv = net.createServer();
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => resolve());
      });
      servers.push(srv);
      ports.push((srv.address() as net.AddressInfo).port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }
}

function resolveBrowserExecutable(): string | undefined {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath) {
    if (!fs.existsSync(envPath)) throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist: ${envPath}`);
    return envPath;
  }
  const bundled = chromium.executablePath();
  if (bundled && fs.existsSync(bundled)) return undefined;

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error("No Chromium executable found. Run `npx playwright install chromium` or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.");
  }
  return found;
}

async function waitForHttp(url: string, child: ChildProcess, logs: () => string, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Process exited early (${child.exitCode}) waiting for ${url}\n${logs()}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Retry until ready
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}\n${logs()}`);
}

function spawnService(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, children: ChildProcess[]) {
  const proc = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
  };
  proc.stdout?.on("data", capture);
  proc.stderr?.on("data", capture);
  children.push(proc);
  return { proc, logs: () => output };
}

export async function startE2ECluster(): Promise<E2ECluster> {
  const [apiPort, towerPort, gatePort, whPort, driverPort] = await allocatePorts(5);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "corelogistics-e2e-"));
  const dbPath = path.join(tempDir, "e2e.db");
  const children: ChildProcess[] = [];
  let browser: Browser | undefined;

  const cleanup = async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await browser?.close().catch(() => {});
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 400));
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  const onSignal = () => void cleanup().finally(() => process.exit(1));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const apiUrl = `http://localhost:${apiPort}`;
  const appPorts = { tower: towerPort!, gate: gatePort!, warehouse: whPort!, driver: driverPort! };
  const corsOrigins = Object.values(appPorts)
    .flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`])
    .join(",");

  const tsxBin = path.join(ROOT, "node_modules/.bin/tsx");
  const viteBin = path.join(ROOT, "node_modules/.bin/vite");

  try {
    const apiProc = spawnService(
      tsxBin,
      ["src/index.ts"],
      path.join(ROOT, "apps/api"),
      { ...process.env, PORT: String(apiPort), CORELOGISTICS_DB: dbPath, CORELOGISTICS_CORS_ORIGINS: corsOrigins, LOG_LEVEL: "warn" },
      children,
    );
    await waitForHttp(`${apiUrl}/health`, apiProc.proc, apiProc.logs);

    // shortcut: launch Vite dev servers instead of rebuilding 4 static bundles per test run; upgrade to preview build if testing prod bundling in CI.
    const webEnv = { ...process.env, VITE_API_URL: apiUrl };
    const apps: Array<[string, number]> = [
      ["apps/control-tower", appPorts.tower],
      ["apps/gate", appPorts.gate],
      ["apps/warehouse", appPorts.warehouse],
      ["apps/driver", appPorts.driver],
    ];
    await Promise.all(
      apps.map(([dir, port]) => {
        const s = spawnService(viteBin, ["--port", String(port), "--strictPort", "--host", "127.0.0.1"], path.join(ROOT, dir), webEnv, children);
        return waitForHttp(`http://localhost:${port}/`, s.proc, s.logs);
      }),
    );

    const executablePath = resolveBrowserExecutable();
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

    return {
      urls: {
        api: apiUrl,
        tower: `http://localhost:${appPorts.tower}`,
        gate: `http://localhost:${appPorts.gate}`,
        warehouse: `http://localhost:${appPorts.warehouse}`,
        driver: `http://localhost:${appPorts.driver}`,
      },
      browser,
      stop: cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export async function openSignedInRole(
  browser: Browser,
  url: string,
  username: string,
  password: string,
  viewport: { width: number; height: number } = { width: 1280, height: 800 },
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  let signedIn = false;

  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Browser status console errors omit URLs; the response listener below asserts exact HTTP failures.
    if (msg.text().startsWith("Failed to load resource: the server responded with a status of ")) return;
    errors.push(`console.error: ${msg.text()}`);
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status < 400) return;
    const pathname = new URL(res.url()).pathname;
    if (!signedIn && status === 401 && res.request().method() === "GET" && pathname.endsWith("/auth/me")) {
      return;
    }
    errors.push(`HTTP ${status} on ${res.url()}`);
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#signin-username").fill(username);
  await page.locator("#signin-password").fill(password);
  await page.locator(".signin-submit").click();
  // Driver intentionally hides .live-dot on compact viewports, so check DOM attachment rather than visibility.
  await page.locator(".live-dot.is-on").waitFor({ state: "attached", timeout: 10_000 });
  signedIn = true;
  return { context, page, errors };
}

export async function assertFitsViewport(page: Page, label: string) {
  const fit = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(fit.scrollWidth <= fit.innerWidth, `${label}: horizontal overflow ${fit.scrollWidth} > ${fit.innerWidth}`);
}
