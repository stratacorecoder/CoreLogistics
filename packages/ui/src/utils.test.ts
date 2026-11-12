import assert from "node:assert/strict";
import test from "node:test";
import { api, qs } from "./api.js";
import { fmtDateTime, fmtTime, fromLocalInput, fromNow, toLocalInput } from "./format.js";

test("qs skips nullish/empty values and URI-encodes query pairs", () => {
  assert.equal(qs({}), "");
  assert.equal(qs({ a: undefined, b: null, c: "" }), "");
  assert.equal(
    qs({ siteId: "site_1", limit: 25, open: true, q: "WH A&B", empty: "" }),
    "?siteId=site_1&limit=25&open=true&q=WH%20A%26B",
  );
  assert.equal(qs({ count: 0, active: false }), "?count=0&active=false");
});

test("format helpers handle missing values, relative times, and local datetime round-trips", () => {
  assert.equal(fmtTime(null), "—");
  assert.equal(fmtTime(undefined), "—");
  assert.equal(fmtDateTime(null), "—");
  assert.equal(fromNow(null), "—");

  const now = Date.UTC(2026, 4, 10, 12, 0, 0);
  assert.equal(fromNow(new Date(now).toISOString(), now), "now");
  assert.equal(fromNow(new Date(now + 15 * 60_000).toISOString(), now), "in 15m");
  assert.equal(fromNow(new Date(now - 90 * 60_000).toISOString(), now), "1h 30m ago");
  assert.equal(fromNow(new Date(now + 2 * 86_400_000).toISOString(), now), "in 2d");

  const todayNoon = new Date();
  todayNoon.setHours(12, 0, 0, 0);
  const tomorrowNoon = new Date(todayNoon.getTime() + 86_400_000);
  const laterDay = new Date(todayNoon.getTime() + 5 * 86_400_000);

  assert.equal(fmtDateTime(todayNoon.toISOString()), fmtTime(todayNoon.toISOString()));
  assert.match(fmtDateTime(tomorrowNoon.toISOString()), /^Tomorrow /);
  assert.notEqual(fmtDateTime(laterDay.toISOString()), fmtTime(laterDay.toISOString()));

  const localStr = toLocalInput(todayNoon);
  assert.match(localStr, /^\d{4}-\d{2}-\d{2}T12:00$/);
  assert.equal(Date.parse(fromLocalInput(localStr)), todayNoon.getTime());
});

test("api emits corelogistics:unauthorized on non-login 401 responses", async () => {
  const prevFetch = globalThis.fetch;
  const prevWindow = (globalThis as { window?: unknown }).window;
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;

  const events: string[] = [];
  const fakeWindow = {
    location: { protocol: "http:", hostname: "localhost" },
    dispatchEvent(evt: Event) {
      events.push(evt.type);
      return true;
    },
  };
  (globalThis as { window: unknown }).window = fakeWindow;
  (globalThis as { localStorage: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "Sign in required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  try {
    await assert.rejects(() => api.post("/auth/login", { username: "a", password: "b" }), /Sign in required/);
    assert.deepEqual(events, []);

    await assert.rejects(() => api.get("/trips"), /Sign in required/);
    assert.deepEqual(events, ["corelogistics:unauthorized"]);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window: unknown }).window = prevWindow;
    if (prevStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage: unknown }).localStorage = prevStorage;
  }
});
