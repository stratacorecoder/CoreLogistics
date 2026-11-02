import {
  HuQuerySchema,
  ReceiptInputSchema,
  ReceiveInputSchema,
  SkuInputSchema,
  SortRuleInputSchema,
  type HandlingUnit,
  type InventoryRow,
  type PutawayTask,
  type Receipt,
  type Sku,
  type SortResult,
  type SortRule,
} from "@corelogistics/contracts";
import type { z } from "zod";
import { many, newId, nextCode, nowIso, one, placeholders, run, splitList, toBool, tx, type Row } from "../../db.js";
import { badRequest, conflict, must, notFound } from "../../errors.js";
import { at, emit, type Ctx } from "../../events.js";
import { getLocation, getSite } from "../sites/service.js";

// SKUs -----------------------------------------------------------------------

export function toSku(r: Row): Sku {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    zone: r.zone,
    unitWeightKg: r.unit_weight_kg,
    unitVolumeM3: r.unit_volume_m3,
  };
}

export function listSkus(): Sku[] {
  return many("SELECT * FROM skus ORDER BY code").map(toSku);
}

export function getSku(id: string): Sku {
  return toSku(must(one("SELECT * FROM skus WHERE id = ? OR code = ?", [id, id]), "SKU"));
}

export function createSku(input: z.output<typeof SkuInputSchema>): Sku {
  if (one("SELECT 1 FROM skus WHERE code = ?", [input.code])) throw conflict(`SKU ${input.code} exists`);
  const id = newId("sku");
  run(
    `INSERT INTO skus (id, code, name, category, zone, unit_weight_kg, unit_volume_m3) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.code, input.name, input.category, input.zone, input.unitWeightKg, input.unitVolumeM3],
  );
  return getSku(id);
}

// Handling units -------------------------------------------------------------

const HU_SELECT = `
  SELECT h.*, s.code AS sku_code, s.name AS sku_name, s.zone AS sku_zone,
         s.unit_weight_kg, s.unit_volume_m3, l.code AS location_code, sl.code AS sort_lane_code
  FROM handling_units h
  JOIN skus s ON s.id = h.sku_id
  LEFT JOIN locations l ON l.id = h.location_id
  LEFT JOIN locations sl ON sl.id = h.sort_lane_id`;

export function toHu(r: Row): HandlingUnit {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind,
    siteId: r.site_id,
    skuId: r.sku_id,
    skuCode: r.sku_code,
    skuName: r.sku_name,
    zone: r.sku_zone,
    qty: r.qty,
    status: r.status,
    locationId: r.location_id ?? null,
    locationCode: r.location_code ?? null,
    sortLaneId: r.sort_lane_id ?? null,
    sortLaneCode: r.sort_lane_code ?? null,
    destinationSiteId: r.destination_site_id ?? null,
    receiptId: r.receipt_id ?? null,
    orderId: r.order_id ?? null,
    shipmentId: r.shipment_id ?? null,
    weightKg: Math.round(r.qty * r.unit_weight_kg * 10) / 10,
    volumeM3: Math.round(r.qty * r.unit_volume_m3 * 1000) / 1000,
    lotNumber: r.lot_number ?? null,
    expiryDate: r.expiry_date ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getHu(idOrCode: string): HandlingUnit {
  return toHu(must(one(`${HU_SELECT} WHERE h.id = ? OR h.code = ?`, [idOrCode, idOrCode]), "Handling unit"));
}

export function listHus(q: z.output<typeof HuQuerySchema>): HandlingUnit[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.siteId) {
    where.push("h.site_id = ?");
    params.push(q.siteId);
  }
  const statuses = splitList(q.status);
  if (statuses.length) {
    where.push(`h.status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
  }
  if (q.receiptId) {
    where.push("h.receipt_id = ?");
    params.push(q.receiptId);
  }
  if (q.orderId) {
    where.push("h.order_id = ?");
    params.push(q.orderId);
  }
  return many(
    `${HU_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY h.updated_at DESC LIMIT ?`,
    [...params, q.limit],
  ).map(toHu);
}

export function insertHu(
  ctx: Ctx,
  h: {
    code?: string;
    kind: string;
    siteId: string;
    skuId: string;
    qty: number;
    status: string;
    locationId?: string | null;
    destinationSiteId?: string | null;
    receiptId?: string | null;
    orderId?: string | null;
    lotNumber?: string | null;
    expiryDate?: string | null;
  },
): HandlingUnit {
  const code = h.code?.trim().toUpperCase() || nextCode("hu", "HU", 6, 100000);
  if (one("SELECT 1 FROM handling_units WHERE code = ?", [code])) throw conflict(`Handling unit ${code} already exists`);
  const id = newId("hu");
  const when = at(ctx);
  run(
    `INSERT INTO handling_units (id, code, kind, site_id, sku_id, qty, status, location_id, destination_site_id, receipt_id, order_id, lot_number, expiry_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      code,
      h.kind,
      h.siteId,
      h.skuId,
      h.qty,
      h.status,
      h.locationId ?? null,
      h.destinationSiteId ?? null,
      h.receiptId ?? null,
      h.orderId ?? null,
      h.lotNumber ?? null,
      h.expiryDate ?? null,
      when,
      when,
    ],
  );
  return getHu(id);
}

export function adjustInventory(siteId: string, locationId: string, skuId: string, delta: number) {
  run(
    `INSERT INTO inventory (site_id, location_id, sku_id, qty) VALUES (?, ?, ?, ?)
     ON CONFLICT(location_id, sku_id) DO UPDATE SET qty = qty + excluded.qty`,
    [siteId, locationId, skuId, delta],
  );
  run("DELETE FROM inventory WHERE location_id = ? AND sku_id = ? AND qty <= 0", [locationId, skuId]);
}

export function listInventory(siteId?: string, skuId?: string): InventoryRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (siteId) {
    where.push("i.site_id = ?");
    params.push(siteId);
  }
  if (skuId) {
    where.push("i.sku_id = ?");
    params.push(skuId);
  }
  const today = nowIso().slice(0, 10);
  return many(
    `SELECT i.*, l.code AS location_code, l.zone, s.code AS sku_code, s.name AS sku_name,
            (SELECT MIN(h.expiry_date) FROM handling_units h
             WHERE h.location_id = i.location_id AND h.sku_id = i.sku_id AND h.status = 'stored' AND h.expiry_date IS NOT NULL) AS earliest_expiry,
            (SELECT COALESCE(SUM(h.qty), 0) FROM handling_units h
             WHERE h.location_id = i.location_id AND h.sku_id = i.sku_id AND h.status = 'stored' AND h.expiry_date IS NOT NULL AND h.expiry_date < ?) AS expired_qty
     FROM inventory i JOIN locations l ON l.id = i.location_id JOIN skus s ON s.id = i.sku_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.code, l.code`,
    [today, ...params],
  ).map((r) => ({
    siteId: r.site_id,
    locationId: r.location_id,
    locationCode: r.location_code,
    zone: r.zone ?? null,
    skuId: r.sku_id,
    skuCode: r.sku_code,
    skuName: r.sku_name,
    qty: r.qty,
    earliestExpiry: r.earliest_expiry ?? null,
    expiredQty: Number(r.expired_qty || 0),
  }));
}

// Receiving ------------------------------------------------------------------

function toReceipt(r: Row): Receipt {
  const lines = many(
    `SELECT rl.*, s.code AS sku_code, s.name AS sku_name FROM receipt_lines rl JOIN skus s ON s.id = rl.sku_id
     WHERE rl.receipt_id = ? ORDER BY s.code`,
    [r.id],
  );
  return {
    id: r.id,
    code: r.code,
    siteId: r.site_id,
    tripId: r.trip_id ?? null,
    visitId: r.visit_id ?? null,
    supplier: r.supplier,
    status: r.status,
    createdAt: r.created_at,
    closedAt: r.closed_at ?? null,
    lines: lines.map((l) => ({
      id: l.id,
      skuId: l.sku_id,
      skuCode: l.sku_code,
      skuName: l.sku_name,
      expectedQty: l.expected_qty,
      receivedQty: l.received_qty,
    })),
    huCount: Number(one("SELECT COUNT(*) AS n FROM handling_units WHERE receipt_id = ?", [r.id])!.n),
  };
}

export function getReceipt(id: string): Receipt {
  return toReceipt(must(one("SELECT * FROM inbound_receipts WHERE id = ? OR code = ?", [id, id]), "Receipt"));
}

export function listReceipts(siteId?: string, status?: string): Receipt[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (siteId) {
    where.push("site_id = ?");
    params.push(siteId);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  return many(
    `SELECT * FROM inbound_receipts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY status = 'closed', created_at DESC LIMIT 200`,
    params,
  ).map(toReceipt);
}

export function createReceipt(input: z.output<typeof ReceiptInputSchema>, ctx: Ctx): Receipt {
  return tx(() => {
    const site = getSite(input.siteId);
    if (site.kind !== "warehouse" && site.kind !== "depot") throw badRequest("Receipts belong to a warehouse or depot");
    const id = newId("rcv");
    const code = nextCode("receipt", "RCV");
    run(
      `INSERT INTO inbound_receipts (id, code, site_id, trip_id, visit_id, supplier, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      [id, code, site.id, input.tripId ?? null, input.visitId ?? null, input.supplier, at(ctx)],
    );
    for (const line of input.lines) {
      getSku(line.skuId);
      run(`INSERT INTO receipt_lines (id, receipt_id, sku_id, expected_qty) VALUES (?, ?, ?, ?)`, [
        newId("rcl"),
        id,
        line.skuId,
        line.expectedQty,
      ]);
    }
    emit(ctx, {
      type: "receipt.created",
      siteId: site.id,
      tripId: input.tripId ?? null,
      entityId: id,
      message: `Receipt ${code} opened${input.supplier ? ` for ${input.supplier}` : ""}`,
    });
    return getReceipt(id);
  });
}

/** Called when a truck docks to unload: reuse the trip's receipt or open one. */
export function ensureReceiptForVisit(visitId: string, ctx: Ctx): Receipt {
  const visit = must(one("SELECT * FROM gate_visits WHERE id = ?", [visitId]), "Gate visit");
  const existing =
    one("SELECT id FROM inbound_receipts WHERE visit_id = ? AND status = 'open'", [visit.id]) ??
    (visit.trip_id
      ? one("SELECT id FROM inbound_receipts WHERE trip_id = ? AND status = 'open'", [visit.trip_id])
      : undefined);
  if (existing) {
    run("UPDATE inbound_receipts SET visit_id = ? WHERE id = ?", [visit.id, existing.id]);
    return getReceipt(existing.id);
  }
  const trip = visit.trip_id ? one("SELECT origin_site_id FROM trips WHERE id = ?", [visit.trip_id]) : undefined;
  const supplier = trip ? getSite(trip.origin_site_id).name : `Walk-in ${visit.plate}`;
  return createReceipt(
    { siteId: visit.site_id, tripId: visit.trip_id ?? null, visitId: visit.id, supplier, lines: [] },
    ctx,
  );
}

export function receive(receiptId: string, input: z.output<typeof ReceiveInputSchema>, ctx: Ctx): HandlingUnit {
  return tx(() => {
    const receipt = getReceipt(receiptId);
    if (receipt.status !== "open") throw badRequest(`Receipt ${receipt.code} is closed`);
    const sku = getSku(input.skuId);
    if (input.destinationSiteId) getSite(input.destinationSiteId);
    const dock = receipt.visitId
      ? one("SELECT location_id FROM dock_assignments WHERE visit_id = ? AND released_at IS NULL", [receipt.visitId])
      : undefined;
    const hu = insertHu(ctx, {
      code: input.code,
      kind: input.kind,
      siteId: receipt.siteId,
      skuId: sku.id,
      qty: input.qty,
      status: "received",
      locationId: dock?.location_id ?? null,
      destinationSiteId: input.destinationSiteId ?? null,
      receiptId: receipt.id,
      lotNumber: input.lotNumber ?? null,
      expiryDate: input.expiryDate ?? null,
    });
    const line = receipt.lines.find((l) => l.skuId === sku.id);
    if (line) run("UPDATE receipt_lines SET received_qty = received_qty + ? WHERE id = ?", [input.qty, line.id]);
    else {
      run(`INSERT INTO receipt_lines (id, receipt_id, sku_id, expected_qty, received_qty) VALUES (?, ?, ?, 0, ?)`, [
        newId("rcl"),
        receipt.id,
        sku.id,
        input.qty,
      ]);
    }
    const lotDesc = hu.lotNumber ? ` [Lot ${hu.lotNumber}]` : "";
    const expDesc = hu.expiryDate ? ` [Exp ${hu.expiryDate}]` : "";
    emit(ctx, {
      type: "hu.received",
      siteId: receipt.siteId,
      tripId: receipt.tripId,
      huId: hu.id,
      locationId: hu.locationId,
      entityId: receipt.id,
      message: `${hu.code}: ${hu.qty} × ${sku.code}${lotDesc}${expDesc} received on ${receipt.code}${hu.destinationSiteId ? " (cross-dock)" : ""}`,
      payload: { lotNumber: hu.lotNumber, expiryDate: hu.expiryDate },
    });
    return hu;
  });
}

export function closeReceipt(id: string, ctx: Ctx): Receipt {
  return tx(() => {
    const r = getReceipt(id);
    if (r.status === "closed") return r;
    run("UPDATE inbound_receipts SET status = 'closed', closed_at = ? WHERE id = ?", [at(ctx), r.id]);
    const short = r.lines.filter((l) => l.receivedQty < l.expectedQty);
    emit(ctx, {
      type: "receipt.closed",
      siteId: r.siteId,
      tripId: r.tripId,
      entityId: r.id,
      message: `Receipt ${r.code} closed with ${r.huCount} HU${short.length ? `, ${short.length} line(s) short` : ""}`,
      payload: { short: short.map((l) => ({ sku: l.skuCode, missing: l.expectedQty - l.receivedQty })) },
    });
    return getReceipt(r.id);
  });
}

// Sortation ------------------------------------------------------------------

function toRule(r: Row): SortRule {
  return {
    id: r.id,
    siteId: r.site_id,
    priority: r.priority,
    matchKind: r.match_kind,
    matchValue: r.match_value,
    sortLaneId: r.sort_lane_id,
    sortLaneCode: r.lane_code,
    active: toBool(r.active),
  };
}

export function listRules(siteId?: string): SortRule[] {
  return many(
    `SELECT r.*, l.code AS lane_code FROM sort_rules r JOIN locations l ON l.id = r.sort_lane_id
     ${siteId ? "WHERE r.site_id = ?" : ""} ORDER BY r.site_id, r.priority, r.match_kind`,
    siteId ? [siteId] : [],
  ).map(toRule);
}

export function createRule(input: z.output<typeof SortRuleInputSchema>): SortRule {
  const lane = getLocation(input.sortLaneId);
  if (lane.siteId !== input.siteId || lane.kind !== "sort_lane") throw badRequest("Target must be a sort lane at the site");
  const id = newId("srt");
  run(
    `INSERT INTO sort_rules (id, site_id, priority, match_kind, match_value, sort_lane_id, active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.siteId, input.priority, input.matchKind, input.matchValue, lane.id, input.active],
  );
  return listRules(input.siteId).find((r) => r.id === id)!;
}

export function setRuleActive(id: string, active: boolean): SortRule {
  const r = must(one("SELECT * FROM sort_rules WHERE id = ?", [id]), "Sort rule");
  run("UPDATE sort_rules SET active = ? WHERE id = ?", [active, id]);
  return listRules(r.site_id).find((x) => x.id === id)!;
}

export function deleteRule(id: string) {
  must(one("SELECT 1 FROM sort_rules WHERE id = ?", [id]), "Sort rule");
  run("DELETE FROM sort_rules WHERE id = ?", [id]);
  return { ok: true as const };
}

/** First active rule by priority wins; falls back to a lane in the SKU's zone. */
export function chooseLane(hu: HandlingUnit): { laneId: string; ruleId: string | null; reason: string } {
  const sku = getSku(hu.skuId);
  const destCode = hu.destinationSiteId ? getSite(hu.destinationSiteId).code : null;
  for (const rule of listRules(hu.siteId).filter((r) => r.active)) {
    const v = rule.matchValue.toUpperCase();
    const hit =
      (rule.matchKind === "destination" && destCode !== null && (v === destCode.toUpperCase() || rule.matchValue === hu.destinationSiteId)) ||
      (rule.matchKind === "sku" && v === sku.code.toUpperCase()) ||
      (rule.matchKind === "category" && v === sku.category.toUpperCase()) ||
      (rule.matchKind === "zone" && v === sku.zone);
    if (hit) {
      return {
        laneId: rule.sortLaneId,
        ruleId: rule.id,
        reason: `Rule P${rule.priority}: ${rule.matchKind} = ${rule.matchValue} → ${rule.sortLaneCode}`,
      };
    }
  }
  const lanes = many(
    "SELECT * FROM locations WHERE site_id = ? AND kind = 'sort_lane' AND active = 1 ORDER BY (zone = ?) DESC, code",
    [hu.siteId, sku.zone],
  );
  if (!lanes.length) throw badRequest("This site has no sort lanes; add one in the layout designer");
  const lane = lanes[0]!;
  return {
    laneId: lane.id,
    ruleId: null,
    reason: lane.zone === sku.zone ? `No rule matched; zone ${sku.zone} lane ${lane.code}` : `No rule matched; default lane ${lane.code}`,
  };
}

export function sortHu(huIdOrCode: string, ctx: Ctx): SortResult {
  return tx(() => {
    const hu = getHu(huIdOrCode);
    if (hu.status !== "received") throw badRequest(`${hu.code} is ${hu.status}; only received units are sorted`);
    const choice = chooseLane(hu);
    const crossDock = Boolean(hu.destinationSiteId);
    run(
      `UPDATE handling_units SET status = ?, sort_lane_id = ?, location_id = ?, updated_at = ? WHERE id = ?`,
      [crossDock ? "staged" : "sorted", choice.laneId, choice.laneId, at(ctx), hu.id],
    );
    const sorted = getHu(hu.id);
    emit(ctx, {
      type: "hu.sorted",
      siteId: hu.siteId,
      huId: hu.id,
      locationId: choice.laneId,
      message: `${hu.code} sorted to ${sorted.sortLaneCode}${crossDock ? " (cross-dock, staged)" : ""}`,
      payload: { ruleId: choice.ruleId, reason: choice.reason },
    });
    const putaway = crossDock ? null : createPutaway(sorted, ctx);
    return { hu: getHu(hu.id), ruleId: choice.ruleId, reason: choice.reason, putaway };
  });
}

// Putaway --------------------------------------------------------------------

const PUTAWAY_SELECT = `
  SELECT p.*, h.code AS hu_code, h.qty, s.code AS sku_code, s.name AS sku_name, s.zone,
         fl.code AS from_code, sl.code AS suggested_code, cl.code AS confirmed_code
  FROM putaway_tasks p
  JOIN handling_units h ON h.id = p.hu_id
  JOIN skus s ON s.id = h.sku_id
  LEFT JOIN locations fl ON fl.id = p.from_location_id
  LEFT JOIN locations sl ON sl.id = p.suggested_location_id
  LEFT JOIN locations cl ON cl.id = p.confirmed_location_id`;

function toPutaway(r: Row): PutawayTask {
  return {
    id: r.id,
    siteId: r.site_id,
    huId: r.hu_id,
    huCode: r.hu_code,
    skuCode: r.sku_code,
    skuName: r.sku_name,
    qty: r.qty,
    zone: r.zone,
    fromLocationId: r.from_location_id ?? null,
    fromCode: r.from_code ?? null,
    suggestedLocationId: r.suggested_location_id ?? null,
    suggestedCode: r.suggested_code ?? null,
    confirmedLocationId: r.confirmed_location_id ?? null,
    confirmedCode: r.confirmed_code ?? null,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
    actor: r.actor ?? null,
  };
}

export function getPutaway(id: string): PutawayTask {
  return toPutaway(must(one(`${PUTAWAY_SELECT} WHERE p.id = ?`, [id]), "Putaway task"));
}

export function listPutaway(siteId?: string, status?: string): PutawayTask[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (siteId) {
    where.push("p.site_id = ?");
    params.push(siteId);
  }
  if (status) {
    where.push("p.status = ?");
    params.push(status);
  }
  return many(
    `${PUTAWAY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.status = 'open' DESC, p.created_at DESC LIMIT 200`,
    params,
  ).map(toPutaway);
}

/** Units stored in a bin plus open putaway tasks already pointed at it. */
function binLoad(binId: string, excludeTaskId?: string): number {
  const stored = Number(
    one("SELECT COUNT(*) AS n FROM handling_units WHERE location_id = ? AND status = 'stored'", [binId])!.n,
  );
  const reserved = Number(
    one(
      "SELECT COUNT(*) AS n FROM putaway_tasks WHERE suggested_location_id = ? AND status = 'open' AND id != ?",
      [binId, excludeTaskId ?? ""],
    )!.n,
  );
  return stored + reserved;
}

/**
 * Picks a bin with free capacity. Hazmat only goes to H bins and nothing else
 * does. Prefers the SKU's own zone, bins already holding the SKU, then the
 * shortest walk from where the unit is now, then lower levels.
 */
export function suggestBin(hu: HandlingUnit, excludeTaskId?: string): { id: string; code: string } | null {
  const sku = getSku(hu.skuId);
  const from = hu.locationId ? getLocation(hu.locationId) : null;
  const bins = many("SELECT * FROM locations WHERE site_id = ? AND kind = 'bin' AND active = 1", [hu.siteId]);
  const holding = new Set(
    many("SELECT location_id FROM inventory WHERE site_id = ? AND sku_id = ?", [hu.siteId, sku.id]).map((r) => r.location_id),
  );
  const ranked = bins
    .filter((b) => (sku.zone === "H" ? b.zone === "H" : b.zone !== "H"))
    .filter((b) => binLoad(b.id, excludeTaskId) < b.capacity)
    .map((b) => ({
      b,
      zoneRank: b.zone === sku.zone ? 0 : b.zone == null ? 1 : 2,
      same: holding.has(b.id) ? 0 : 1,
      dist: from ? Math.abs(from.x - b.x) + Math.abs(from.y - b.y) : 0,
    }))
    .sort((a, c) => a.zoneRank - c.zoneRank || a.same - c.same || a.dist - c.dist || a.b.level - c.b.level);
  const best = ranked[0]?.b;
  return best ? { id: best.id, code: best.code } : null;
}

export function createPutaway(hu: HandlingUnit, ctx: Ctx): PutawayTask {
  const bin = suggestBin(hu);
  const id = newId("put");
  run(
    `INSERT INTO putaway_tasks (id, site_id, hu_id, from_location_id, suggested_location_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    [id, hu.siteId, hu.id, hu.locationId, bin?.id ?? null, at(ctx)],
  );
  emit(ctx, {
    type: "putaway.created",
    siteId: hu.siteId,
    huId: hu.id,
    locationId: bin?.id ?? null,
    entityId: id,
    message: bin ? `Put ${hu.code} away to ${bin.code}` : `No free bin for ${hu.code}; choose one manually`,
  });
  return getPutaway(id);
}

export function confirmPutaway(taskId: string, locationId: string | undefined, ctx: Ctx): PutawayTask {
  return tx(() => {
    const task = getPutaway(taskId);
    if (task.status !== "open") throw badRequest(`Task is ${task.status}`);
    const hu = getHu(task.huId);
    const targetId = locationId ?? task.suggestedLocationId;
    if (!targetId) throw badRequest("No suggested bin; pass locationId");
    const bin = getLocation(targetId);
    if (bin.siteId !== task.siteId || bin.kind !== "bin" || !bin.active) throw badRequest("Target must be a bin at this site");
    if ((hu.zone === "H") !== (bin.zone === "H")) throw badRequest("Hazmat goods and H bins must match");
    if (binLoad(bin.id, task.id) >= bin.capacity) throw conflict(`${bin.code} is full`);
    const when = at(ctx);
    run("UPDATE handling_units SET status = 'stored', location_id = ?, updated_at = ? WHERE id = ?", [bin.id, when, hu.id]);
    adjustInventory(task.siteId, bin.id, hu.skuId, hu.qty);
    run(
      "UPDATE putaway_tasks SET status = 'done', confirmed_location_id = ?, completed_at = ?, actor = ? WHERE id = ?",
      [bin.id, when, ctx.actor, task.id],
    );
    emit(ctx, {
      type: "putaway.done",
      siteId: task.siteId,
      huId: hu.id,
      locationId: bin.id,
      entityId: task.id,
      message: `${hu.code} stored in ${bin.code}${bin.id !== task.suggestedLocationId ? ` (suggested ${task.suggestedCode ?? "none"})` : ""}`,
    });
    return getPutaway(task.id);
  });
}

export function openPutawayForHu(huId: string): PutawayTask | undefined {
  const r = one(`${PUTAWAY_SELECT} WHERE p.hu_id = ? AND p.status = 'open'`, [huId]);
  return r ? toPutaway(r) : undefined;
}

export function findHuByCode(code: string): HandlingUnit {
  const r = one(`${HU_SELECT} WHERE h.code = ?`, [code.trim().toUpperCase()]);
  if (!r) throw notFound(`Handling unit ${code}`);
  return toHu(r);
}
