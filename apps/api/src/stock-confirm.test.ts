import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { one, run, scalar } from "./db.js";
import { migrate } from "./migrate.js";
import { ensureDemoUsers, seedIfEmpty } from "./seed.js";

describe("Stock confirmation", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let towerToken: string;
  let warehouseToken: string;
  let siteId: string;
  let customerId: string;
  let skuId: string;
  let n = 0;

  const tower = () => ({ "x-session": towerToken });
  const floor = () => ({ "x-session": warehouseToken });

  before(async () => {
    migrate();
    seedIfEmpty();
    ensureDemoUsers();
    app = await buildApp({ logger: false });
    await app.ready();
    towerToken = JSON.parse((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "ava", password: "planner" } })).payload).token;
    warehouseToken = JSON.parse((await app.inject({ method: "POST", url: "/auth/login", payload: { username: "mina", password: "floor" } })).payload).token;
    siteId = one<{ id: string }>("SELECT id FROM sites WHERE code = 'WH-C'")!.id;
    customerId = one<{ id: string }>("SELECT id FROM sites WHERE kind = 'customer' LIMIT 1")!.id;
    skuId = one<{ id: string }>("SELECT id FROM skus WHERE zone != 'H' LIMIT 1")!.id;
  });

  function requestId(prefix: string) {
    n += 1;
    return `${prefix}-${String(n).padStart(4, "0")}-confirm`;
  }

  async function receiveSorted(qty = 8, forSku = skuId) {
    const receipt = await app.inject({
      method: "POST",
      url: "/warehouse/receipts",
      headers: floor(),
      payload: { siteId, supplier: "Confirm test", lines: [{ skuId: forSku, expectedQty: qty }] },
    });
    assert.equal(receipt.statusCode, 200, receipt.payload);
    const receiptId = JSON.parse(receipt.payload).id as string;
    const received = await app.inject({
      method: "POST",
      url: `/warehouse/receipts/${receiptId}/receive`,
      headers: floor(),
      payload: { skuId: forSku, qty, kind: "pallet" },
    });
    assert.equal(received.statusCode, 200, received.payload);
    const hu = JSON.parse(received.payload) as { id: string; code: string };
    const sorted = await app.inject({ method: "POST", url: `/warehouse/hus/${hu.id}/sort`, headers: floor() });
    assert.equal(sorted.statusCode, 200, sorted.payload);
    const putaway = JSON.parse(sorted.payload).putaway as { id: string; huCode: string; suggestedCode: string | null };
    assert.ok(putaway?.suggestedCode);
    return { hu, putaway };
  }

  function matchPutaway(task: { id: string; huCode: string; suggestedCode: string | null }, id = requestId("put"), bin = task.suggestedCode) {
    return {
      mode: "match" as const,
      requestId: id,
      entryMethod: "keyboard" as const,
      huBarcode: task.huCode,
      binBarcode: bin,
    };
  }

  it("rejects a wrong unit, another site's bin, a hazmat mismatch, and a full bin", async () => {
    const { hu, putaway } = await receiveSorted();
    const wrong = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: { ...matchPutaway(putaway), huBarcode: "NOT-A-UNIT" },
    });
    assert.equal(wrong.statusCode, 400, wrong.payload);
    assert.match(JSON.parse(wrong.payload).error, /^Wrong label/);

    const other = one<{ code: string }>(
      `SELECT d.code FROM locations d
       WHERE d.site_id = (SELECT id FROM sites WHERE code = 'DEP-N') AND d.active = 1
         AND NOT EXISTS (SELECT 1 FROM locations w WHERE w.site_id = ? AND UPPER(w.code) = UPPER(d.code))
       LIMIT 1`,
      [siteId],
    );
    assert.ok(other);
    const otherSite = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: matchPutaway(putaway, requestId("put"), other!.code),
    });
    assert.equal(otherSite.statusCode, 400, otherSite.payload);
    assert.match(JSON.parse(otherSite.payload).error, /another site/);

    const hazmat = one<{ code: string }>(
      "SELECT code FROM locations WHERE site_id = ? AND kind = 'bin' AND active = 1 AND zone = 'H' LIMIT 1",
      [siteId],
    );
    assert.ok(hazmat);
    const blocked = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: matchPutaway(putaway, requestId("put"), hazmat!.code),
    });
    assert.equal(blocked.statusCode, 400, blocked.payload);
    assert.match(JSON.parse(blocked.payload).error, /Hazmat/);

    const bin = one<{ id: string; capacity: number }>("SELECT id, capacity FROM locations WHERE site_id = ? AND code = ?", [
      siteId,
      putaway.suggestedCode,
    ])!;
    run("UPDATE locations SET capacity = 0 WHERE id = ?", [bin.id]);
    const fullId = requestId("put");
    const full = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: matchPutaway(putaway, fullId),
    });
    assert.equal(full.statusCode, 409, full.payload);
    assert.match(JSON.parse(full.payload).error, /full/);
    run("UPDATE locations SET capacity = ? WHERE id = ?", [bin.capacity, bin.id]);
    assert.equal(one("SELECT status FROM putaway_tasks WHERE id = ?", [putaway.id])?.status, "open");
    assert.equal(one("SELECT status FROM handling_units WHERE id = ?", [hu.id])?.status, "sorted");

    const stored = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: matchPutaway(putaway, fullId),
    });
    assert.equal(stored.statusCode, 200, stored.payload);
    const body = JSON.parse(stored.payload);
    const eventsBefore = Number(scalar("SELECT COUNT(*) FROM events WHERE type = 'putaway.done' AND entity_id = ?", [putaway.id]));
    const replay = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: matchPutaway(putaway, fullId),
    });
    assert.equal(replay.statusCode, 200, replay.payload);
    assert.equal(JSON.parse(replay.payload).confirmedLocationId, body.confirmedLocationId);
    assert.equal(Number(scalar("SELECT COUNT(*) FROM events WHERE type = 'putaway.done' AND entity_id = ?", [putaway.id])), eventsBefore);

    const changed = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: { ...matchPutaway(putaway, fullId), binBarcode: hazmat!.code },
    });
    assert.equal(changed.statusCode, 409, changed.payload);
    assert.match(JSON.parse(changed.payload).error, /different input/);
  });

  it("lets only Tower bypass a label, and records the review", async () => {
    const { putaway } = await receiveSorted();
    const denied = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: {
        mode: "override",
        requestId: requestId("ovr"),
        entryMethod: "manual",
        reason: "Label destroyed on the floor",
      },
    });
    assert.equal(denied.statusCode, 403, denied.payload);
    assert.equal(one("SELECT status FROM putaway_tasks WHERE id = ?", [putaway.id])?.status, "open");

    const allowed = await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: tower(),
      payload: {
        mode: "override",
        requestId: requestId("ovr"),
        entryMethod: "manual",
        huBarcode: "UNREADABLE",
        reason: "Label destroyed on the floor",
      },
    });
    assert.equal(allowed.statusCode, 200, allowed.payload);
    const audit = one<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'putaway.done' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      [putaway.id],
    );
    assert.equal(JSON.parse(audit!.payload).review, "tower_override");
  });

  it("requires the source pallet, keeps one stock change for a repeated request, and reports a stale unit", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/skus",
      headers: tower(),
      payload: { code: `CFM${n + 1}`, name: "Confirm item", category: "test", zone: "A", unitWeightKg: 1, unitVolumeM3: 0.01 },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const privateSku = JSON.parse(created.payload).id as string;
    const { hu, putaway } = await receiveSorted(6, privateSku);
    await app.inject({
      method: "POST",
      url: `/warehouse/putaway/${putaway.id}/confirm`,
      headers: floor(),
      payload: matchPutaway(putaway),
    });
    const order = await app.inject({
      method: "POST",
      url: "/outbound/orders",
      headers: tower(),
      payload: {
        siteId,
        customerSiteId: customerId,
        dueAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
        lines: [{ skuId: privateSku, qty: 2 }],
      },
    });
    assert.equal(order.statusCode, 200, order.payload);
    const released = await app.inject({
      method: "POST",
      url: `/outbound/orders/${JSON.parse(order.payload).id}/release`,
      headers: tower(),
    });
    assert.equal(released.statusCode, 200, released.payload);
    const task = (JSON.parse(released.payload).tasks as Array<{ id: string; fromHuId: string; fromHuCode: string; qty: number }>).find(
      (row) => row.fromHuId === hu.id,
    );
    assert.ok(task);

    const mismatch = await app.inject({
      method: "POST",
      url: `/outbound/picks/${task!.id}/confirm`,
      headers: floor(),
      payload: { mode: "match", requestId: requestId("pick"), entryMethod: "camera", huBarcode: "BIN-ONLY" },
    });
    assert.equal(mismatch.statusCode, 400, mismatch.payload);
    assert.match(JSON.parse(mismatch.payload).error, /^Wrong label/);

    run("UPDATE handling_units SET qty = 0 WHERE id = ?", [hu.id]);
    const stale = await app.inject({
      method: "POST",
      url: `/outbound/picks/${task!.id}/confirm`,
      headers: floor(),
      payload: { mode: "match", requestId: requestId("pick"), entryMethod: "manual", huBarcode: task!.fromHuCode },
    });
    assert.equal(stale.statusCode, 409, stale.payload);
    assert.match(JSON.parse(stale.payload).error, /^Stale task/);
    run("UPDATE handling_units SET qty = 6 WHERE id = ?", [hu.id]);

    const id = requestId("pick");
    const body = { mode: "match", requestId: id, entryMethod: "keyboard", huBarcode: task!.fromHuCode };
    const confirmed = await app.inject({
      method: "POST",
      url: `/outbound/picks/${task!.id}/confirm`,
      headers: floor(),
      payload: body,
    });
    assert.equal(confirmed.statusCode, 200, confirmed.payload);
    const qtyAfter = Number(one<{ qty: number }>("SELECT qty FROM handling_units WHERE id = ?", [hu.id])!.qty);
    const replay = await app.inject({
      method: "POST",
      url: `/outbound/picks/${task!.id}/confirm`,
      headers: floor(),
      payload: body,
    });
    assert.equal(replay.statusCode, 200, replay.payload);
    assert.equal(JSON.parse(replay.payload).hu.id, JSON.parse(confirmed.payload).hu.id);
    assert.equal(Number(one<{ qty: number }>("SELECT qty FROM handling_units WHERE id = ?", [hu.id])!.qty), qtyAfter);
    assert.equal(
      Number(scalar("SELECT COUNT(*) FROM events WHERE type = 'pick.done' AND json_extract(payload, '$.requestId') = ?", [id])),
      1,
    );
  });
});
