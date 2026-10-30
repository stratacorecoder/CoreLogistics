import {
  OrderInputSchema,
  OrderQuerySchema,
  ShipmentInputSchema,
  type HandlingUnit,
  type Order,
  type PickTask,
  type ReleaseResult,
  type Shipment,
} from "@corelogistics/contracts";
import type { z } from "zod";
import { many, newId, nextCode, one, placeholders, run, splitList, tx, type Row } from "../../db.js";
import { badRequest, conflict, must } from "../../errors.js";
import { at, emit, type Ctx } from "../../events.js";
import { getVehicle } from "../fleet/service.js";
import { getLocation, getSite } from "../sites/service.js";
import { departTrip, dispatchTrip, getTrip } from "../trips/service.js";
import { adjustInventory, getHu, getSku, insertHu, listHus } from "../warehouse/service.js";

// Orders ---------------------------------------------------------------------

function toOrder(r: Row): Order {
  const lines = many(
    `SELECT ol.*, s.code AS sku_code, s.name AS sku_name FROM order_lines ol JOIN skus s ON s.id = ol.sku_id
     WHERE ol.order_id = ? ORDER BY s.code`,
    [r.id],
  );
  return {
    id: r.id,
    code: r.code,
    siteId: r.site_id,
    customerSiteId: r.customer_site_id,
    status: r.status,
    dueAt: r.due_at,
    createdAt: r.created_at,
    shipmentId: r.shipment_id ?? null,
    lines: lines.map((l) => ({
      id: l.id,
      skuId: l.sku_id,
      skuCode: l.sku_code,
      skuName: l.sku_name,
      qty: l.qty,
      pickedQty: l.picked_qty,
    })),
    huCount: Number(one("SELECT COUNT(*) AS n FROM handling_units WHERE order_id = ?", [r.id])!.n),
  };
}

export function getOrder(id: string): Order {
  return toOrder(must(one("SELECT * FROM orders WHERE id = ? OR code = ?", [id, id]), "Order"));
}

export function listOrders(q: z.output<typeof OrderQuerySchema>): Order[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.siteId) {
    where.push("site_id = ?");
    params.push(q.siteId);
  }
  const statuses = splitList(q.status);
  if (statuses.length) {
    where.push(`status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
  }
  return many(
    `SELECT * FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY status IN ('shipped','cancelled'), due_at LIMIT ?`,
    [...params, q.limit],
  ).map(toOrder);
}

export function createOrder(input: z.output<typeof OrderInputSchema>, ctx: Ctx): Order {
  return tx(() => {
    const site = getSite(input.siteId);
    const customer = getSite(input.customerSiteId);
    const id = newId("ord");
    const code = nextCode("order", "ORD");
    run(
      `INSERT INTO orders (id, code, site_id, customer_site_id, status, due_at, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      [id, code, site.id, customer.id, input.dueAt, at(ctx)],
    );
    for (const line of input.lines) {
      getSku(line.skuId);
      run(`INSERT INTO order_lines (id, order_id, sku_id, qty) VALUES (?, ?, ?, ?)`, [newId("orl"), id, line.skuId, line.qty]);
    }
    emit(ctx, {
      type: "order.created",
      siteId: site.id,
      entityId: id,
      message: `Order ${code} for ${customer.name} (${input.lines.length} line(s))`,
    });
    return getOrder(id);
  });
}

// Picking --------------------------------------------------------------------

const PICK_SELECT = `
  SELECT p.*, o.code AS order_code, s.code AS sku_code, s.name AS sku_name, l.code AS from_location_code, h.code AS from_hu_code
  FROM pick_tasks p
  JOIN orders o ON o.id = p.order_id
  JOIN skus s ON s.id = p.sku_id
  JOIN locations l ON l.id = p.from_location_id
  JOIN handling_units h ON h.id = p.from_hu_id`;

function toPick(r: Row): PickTask {
  return {
    id: r.id,
    siteId: r.site_id,
    orderId: r.order_id,
    orderCode: r.order_code,
    orderLineId: r.order_line_id,
    skuId: r.sku_id,
    skuCode: r.sku_code,
    skuName: r.sku_name,
    fromLocationId: r.from_location_id,
    fromLocationCode: r.from_location_code,
    fromHuId: r.from_hu_id,
    fromHuCode: r.from_hu_code,
    qty: r.qty,
    status: r.status,
    toHuId: r.to_hu_id ?? null,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
    actor: r.actor ?? null,
  };
}

export function getPick(id: string): PickTask {
  return toPick(must(one(`${PICK_SELECT} WHERE p.id = ?`, [id]), "Pick task"));
}

export function listPicks(siteId?: string, status?: string, orderId?: string): PickTask[] {
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
  if (orderId) {
    where.push("p.order_id = ?");
    params.push(orderId);
  }
  return many(
    `${PICK_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY p.status = 'open' DESC, o.due_at, l.code LIMIT 300`,
    params,
  ).map(toPick);
}

/** Allocates stored stock FIFO (oldest unit first) and creates pick tasks. */
export function releaseOrder(id: string, ctx: Ctx): ReleaseResult {
  return tx(() => {
    const order = getOrder(id);
    if (order.status !== "open" && order.status !== "picking") throw badRequest(`Order is ${order.status}`);
    const created: string[] = [];
    const shortages: ReleaseResult["shortages"] = [];
    for (const line of order.lines) {
      const allocated = Number(
        one("SELECT COALESCE(SUM(qty), 0) AS n FROM pick_tasks WHERE order_line_id = ? AND status != 'cancelled'", [line.id])!.n,
      );
      let need = line.qty - allocated;
      if (need <= 0) continue;
      const units = many(
        `SELECT h.id, h.location_id, h.qty - COALESCE((SELECT SUM(p.qty) FROM pick_tasks p WHERE p.from_hu_id = h.id AND p.status = 'open'), 0) AS free
         FROM handling_units h WHERE h.site_id = ? AND h.sku_id = ? AND h.status = 'stored'
         ORDER BY h.created_at, h.code`,
        [order.siteId, line.skuId],
      );
      for (const u of units) {
        if (need <= 0) break;
        const take = Math.min(need, Number(u.free));
        if (take <= 0) continue;
        const taskId = newId("pck");
        run(
          `INSERT INTO pick_tasks (id, site_id, order_id, order_line_id, sku_id, from_location_id, from_hu_id, qty, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          [taskId, order.siteId, order.id, line.id, line.skuId, u.location_id, u.id, take, at(ctx)],
        );
        created.push(taskId);
        need -= take;
      }
      if (need > 0) shortages.push({ skuId: line.skuId, skuCode: line.skuCode, missing: need });
    }
    if (created.length) run("UPDATE orders SET status = 'picking' WHERE id = ?", [order.id]);
    emit(ctx, {
      type: "order.released",
      siteId: order.siteId,
      entityId: order.id,
      message: `Order ${order.code} released: ${created.length} pick task(s)${
        shortages.length ? `, short on ${shortages.map((s) => `${s.missing} × ${s.skuCode}`).join(", ")}` : ""
      }`,
      payload: { shortages },
    });
    return { order: getOrder(order.id), tasks: created.map(getPick), shortages };
  });
}

export function confirmPick(taskId: string, ctx: Ctx): { task: PickTask; hu: HandlingUnit; order: Order } {
  return tx(() => {
    const task = getPick(taskId);
    if (task.status !== "open") throw badRequest(`Task is ${task.status}`);
    const source = getHu(task.fromHuId);
    if (source.status !== "stored" || source.qty < task.qty) throw conflict(`${source.code} no longer holds ${task.qty} units`);
    const when = at(ctx);
    const remaining = source.qty - task.qty;
    run(
      `UPDATE handling_units SET qty = ?, status = ?, location_id = ?, updated_at = ? WHERE id = ?`,
      [remaining, remaining === 0 ? "consumed" : "stored", remaining === 0 ? null : source.locationId, when, source.id],
    );
    adjustInventory(task.siteId, task.fromLocationId, task.skuId, -task.qty);
    const hu = insertHu(ctx, {
      kind: remaining === 0 && task.qty === source.qty ? source.kind : "tote",
      siteId: task.siteId,
      skuId: task.skuId,
      qty: task.qty,
      status: "picked",
      orderId: task.orderId,
    });
    run("UPDATE pick_tasks SET status = 'done', to_hu_id = ?, completed_at = ?, actor = ? WHERE id = ?", [
      hu.id,
      when,
      ctx.actor,
      task.id,
    ]);
    run("UPDATE order_lines SET picked_qty = picked_qty + ? WHERE id = ?", [task.qty, task.orderLineId]);
    const open = one("SELECT 1 FROM pick_tasks WHERE order_id = ? AND status = 'open'", [task.orderId]);
    if (!open) run("UPDATE orders SET status = 'picked' WHERE id = ? AND status = 'picking'", [task.orderId]);
    emit(ctx, {
      type: "pick.done",
      siteId: task.siteId,
      huId: hu.id,
      locationId: task.fromLocationId,
      entityId: task.orderId,
      message: `Picked ${task.qty} × ${task.skuCode} from ${task.fromLocationCode} into ${hu.code} for ${task.orderCode}`,
    });
    return { task: getPick(task.id), hu, order: getOrder(task.orderId) };
  });
}

function freeStaging(siteId: string): Row | undefined {
  return one(
    `SELECT l.*, (SELECT COUNT(*) FROM handling_units h WHERE h.location_id = l.id AND h.status IN ('staged','picked')) AS used
     FROM locations l WHERE l.site_id = ? AND l.kind = 'staging' AND l.active = 1
     ORDER BY used, l.code LIMIT 1`,
    [siteId],
  );
}

export function stageOrder(id: string, locationId: string | undefined, ctx: Ctx): Order {
  return tx(() => {
    const order = getOrder(id);
    if (order.status !== "picked") throw badRequest(`Order is ${order.status}; finish picking first`);
    const loc = locationId ? getLocation(locationId) : (() => {
      const r = freeStaging(order.siteId);
      if (!r) throw badRequest("This site has no staging area");
      return getLocation(r.id);
    })();
    if (loc.siteId !== order.siteId || loc.kind !== "staging") throw badRequest("Not a staging location at this site");
    const when = at(ctx);
    run(
      "UPDATE handling_units SET status = 'staged', location_id = ?, updated_at = ? WHERE order_id = ? AND status = 'picked'",
      [loc.id, when, order.id],
    );
    run("UPDATE orders SET status = 'staged' WHERE id = ?", [order.id]);
    emit(ctx, {
      type: "order.staged",
      siteId: order.siteId,
      locationId: loc.id,
      entityId: order.id,
      message: `Order ${order.code} staged at ${loc.code} (${order.huCount} HU)`,
    });
    return getOrder(order.id);
  });
}

// Shipments ------------------------------------------------------------------

function shipmentHus(s: Row): HandlingUnit[] {
  const orderIds = many("SELECT id FROM orders WHERE shipment_id = ?", [s.id]).map((o) => o.id as string);
  const fromOrders = orderIds.length
    ? many(
        `SELECT id FROM handling_units WHERE order_id IN (${placeholders(orderIds.length)}) AND status IN ('picked','staged','loaded','shipped')`,
        orderIds,
      )
    : [];
  const direct = many("SELECT id FROM handling_units WHERE shipment_id = ?", [s.id]);
  const ids = [...new Set([...fromOrders, ...direct].map((r) => r.id as string))];
  return ids.map(getHu);
}

function capacityOf(tripId: string | null): { kg: number | null; m3: number | null; vehicleId: string | null } {
  if (!tripId) return { kg: null, m3: null, vehicleId: null };
  const t = getTrip(tripId);
  const carrier = t.trailerId ?? t.vehicleId;
  if (!carrier) return { kg: null, m3: null, vehicleId: t.vehicleId };
  const v = getVehicle(carrier);
  return { kg: v.capacityKg, m3: v.capacityM3, vehicleId: t.vehicleId };
}

function toShipment(r: Row): Shipment {
  const hus = shipmentHus(r);
  const loaded = hus.filter((h) => h.status === "loaded" || h.status === "shipped");
  const cap = capacityOf(r.trip_id ?? null);
  const dock = cap.vehicleId
    ? one(
        `SELECT l.id, l.code FROM dock_assignments d JOIN gate_visits v ON v.id = d.visit_id JOIN locations l ON l.id = d.location_id
         WHERE v.vehicle_id = ? AND v.site_id = ? AND d.released_at IS NULL`,
        [cap.vehicleId, r.site_id],
      )
    : undefined;
  return {
    id: r.id,
    code: r.code,
    siteId: r.site_id,
    tripId: r.trip_id ?? null,
    tripCode: r.trip_id ? getTrip(r.trip_id).code : null,
    vehicleId: cap.vehicleId,
    status: r.status,
    dockLocationId: dock?.id ?? r.dock_location_id ?? null,
    dockCode: dock?.code ?? (r.dock_location_id ? getLocation(r.dock_location_id).code : null),
    createdAt: r.created_at,
    departedAt: r.departed_at ?? null,
    orderIds: many("SELECT id FROM orders WHERE shipment_id = ? ORDER BY code", [r.id]).map((o) => o.id),
    huTotal: hus.length,
    huLoaded: loaded.length,
    loadedWeightKg: Math.round(loaded.reduce((s, h) => s + h.weightKg, 0) * 10) / 10,
    loadedVolumeM3: Math.round(loaded.reduce((s, h) => s + h.volumeM3, 0) * 1000) / 1000,
    capacityKg: cap.kg,
    capacityM3: cap.m3,
  };
}

export function getShipment(id: string): Shipment {
  return toShipment(must(one("SELECT * FROM shipments WHERE id = ? OR code = ?", [id, id]), "Shipment"));
}

export function listShipments(siteId?: string, status?: string): Shipment[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (siteId) {
    where.push("site_id = ?");
    params.push(siteId);
  }
  const statuses = splitList(status);
  if (statuses.length) {
    where.push(`status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
  }
  return many(
    `SELECT * FROM shipments ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY status = 'departed', created_at DESC LIMIT 100`,
    params,
  ).map(toShipment);
}

function checkTripForShipment(siteId: string, tripId: string, customerIds: string[]) {
  const t = getTrip(tripId);
  if (t.originSiteId !== siteId) throw badRequest(`Trip ${t.code} does not leave from this site`);
  if (!["planned", "dispatched"].includes(t.status)) throw badRequest(`Trip ${t.code} is ${t.status}`);
  const reach = new Set([t.destinationSiteId, ...t.stops.map((s) => s.siteId)]);
  const off = customerIds.filter((c) => !reach.has(c));
  if (off.length) throw badRequest(`Trip ${t.code} does not visit ${off.map((c) => getSite(c).code).join(", ")}`);
}

export function createShipment(input: z.output<typeof ShipmentInputSchema>, ctx: Ctx): Shipment {
  return tx(() => {
    getSite(input.siteId);
    const orders = input.orderIds.map(getOrder);
    for (const o of orders) {
      if (o.siteId !== input.siteId) throw badRequest(`${o.code} ships from another site`);
      if (o.shipmentId) throw conflict(`${o.code} is already on a shipment`);
      if (!["picked", "staged"].includes(o.status)) throw badRequest(`${o.code} is ${o.status}; pick it first`);
    }
    if (input.tripId) checkTripForShipment(input.siteId, input.tripId, orders.map((o) => o.customerSiteId));
    const id = newId("shp");
    const code = nextCode("shipment", "SHP");
    run(`INSERT INTO shipments (id, code, site_id, trip_id, status, created_at) VALUES (?, ?, ?, ?, 'planning', ?)`, [
      id,
      code,
      input.siteId,
      input.tripId ?? null,
      at(ctx),
    ]);
    run(`UPDATE orders SET shipment_id = ? WHERE id IN (${placeholders(orders.length)})`, [id, ...orders.map((o) => o.id)]);
    emit(ctx, {
      type: "shipment.created",
      siteId: input.siteId,
      tripId: input.tripId ?? null,
      entityId: id,
      message: `Shipment ${code} built from ${orders.map((o) => o.code).join(", ")}`,
    });
    return getShipment(id);
  });
}

export function setShipmentTrip(id: string, tripId: string | null): Shipment {
  return tx(() => {
    const s = getShipment(id);
    if (s.status !== "planning") throw badRequest("Trip can only change before loading starts");
    if (tripId) checkTripForShipment(s.siteId, tripId, s.orderIds.map((o) => getOrder(o).customerSiteId));
    run("UPDATE shipments SET trip_id = ? WHERE id = ?", [tripId, s.id]);
    return getShipment(s.id);
  });
}

/** Loads staged units onto the shipment's truck, enforcing weight and volume limits. */
export function loadShipment(id: string, huIds: string[] | undefined, ctx: Ctx): Shipment {
  return tx(() => {
    const s = getShipment(id);
    if (s.status === "departed") throw badRequest("Shipment already departed");
    if (!s.tripId || !s.vehicleId) throw badRequest("Attach a trip with a vehicle before loading");
    if (!s.dockLocationId) throw badRequest(`Truck for ${s.tripCode} is not at a dock; assign one at the gate`);
    const trip = getTrip(s.tripId);
    const row = one("SELECT * FROM shipments WHERE id = ?", [s.id])!;
    const pool = shipmentHus(row);
    const candidates = huIds
      ? huIds.map((h) => {
          const hu = getHu(h);
          const belongs =
            pool.some((p) => p.id === hu.id) ||
            (hu.destinationSiteId === trip.destinationSiteId && hu.siteId === s.siteId && !hu.orderId);
          if (!belongs) throw badRequest(`${hu.code} is not part of ${s.code}`);
          return hu;
        })
      : pool.filter((h) => h.status === "staged");
    const toLoad = candidates.filter((h) => h.status === "staged");
    const notReady = candidates.filter((h) => h.status === "picked");
    if (!toLoad.length) {
      throw badRequest(notReady.length ? "Stage the picked units before loading" : "Nothing staged to load");
    }
    const addKg = toLoad.reduce((n, h) => n + h.weightKg, 0);
    const addM3 = toLoad.reduce((n, h) => n + h.volumeM3, 0);
    if (s.capacityKg !== null && s.loadedWeightKg + addKg > s.capacityKg) {
      throw conflict(
        `Over weight: ${Math.round(s.loadedWeightKg + addKg)} kg exceeds ${Math.round(s.capacityKg)} kg capacity`,
      );
    }
    if (s.capacityM3 !== null && s.loadedVolumeM3 + addM3 > s.capacityM3) {
      throw conflict(`Over volume: ${(s.loadedVolumeM3 + addM3).toFixed(1)} m³ exceeds ${s.capacityM3} m³ capacity`);
    }
    const when = at(ctx);
    for (const hu of toLoad) {
      run("UPDATE handling_units SET status = 'loaded', shipment_id = ?, location_id = ?, updated_at = ? WHERE id = ?", [
        s.id,
        s.dockLocationId,
        when,
        hu.id,
      ]);
      run(
        `INSERT INTO load_records (id, shipment_id, hu_id, loaded_at, weight_kg, volume_m3, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("lod"), s.id, hu.id, when, hu.weightKg, hu.volumeM3, ctx.actor],
      );
    }
    const after = shipmentHus(row);
    const allLoaded = after.every((h) => h.status === "loaded" || h.status === "shipped");
    run("UPDATE shipments SET status = ?, dock_location_id = ? WHERE id = ?", [
      allLoaded ? "loaded" : "loading",
      s.dockLocationId,
      s.id,
    ]);
    for (const orderId of s.orderIds) {
      const pending = one(
        "SELECT 1 FROM handling_units WHERE order_id = ? AND status IN ('picked','staged')",
        [orderId],
      );
      if (!pending) run("UPDATE orders SET status = 'loaded' WHERE id = ?", [orderId]);
    }
    emit(ctx, {
      type: "hu.loaded",
      siteId: s.siteId,
      tripId: s.tripId,
      vehicleId: s.vehicleId,
      locationId: s.dockLocationId,
      entityId: s.id,
      message: `${toLoad.length} HU loaded on ${s.code} at ${s.dockCode} (${Math.round(s.loadedWeightKg + addKg)} kg)`,
      payload: { huIds: toLoad.map((h) => h.id) },
    });
    return getShipment(s.id);
  });
}

/**
 * Closes the shipment and hands off to the trip: the trip is dispatched and
 * departs when the truck checks out at the gate (or immediately if the truck
 * is not inside a gated site).
 */
export function departShipment(id: string, ctx: Ctx): Shipment {
  return tx(() => {
    const s = getShipment(id);
    if (s.status === "departed") return s;
    if (s.huLoaded === 0) throw badRequest("Nothing loaded yet");
    const when = at(ctx);
    run("UPDATE handling_units SET status = 'shipped', location_id = NULL, updated_at = ? WHERE shipment_id = ? AND status = 'loaded'", [
      when,
      s.id,
    ]);
    run("UPDATE shipments SET status = 'departed', departed_at = ? WHERE id = ?", [when, s.id]);
    for (const orderId of s.orderIds) {
      const left = one("SELECT 1 FROM handling_units WHERE order_id = ? AND status IN ('picked','staged','loaded')", [orderId]);
      if (!left) run("UPDATE orders SET status = 'shipped' WHERE id = ?", [orderId]);
    }
    let note = "";
    if (s.tripId) {
      const trip = getTrip(s.tripId);
      const inside = s.vehicleId
        ? one("SELECT 1 FROM gate_visits WHERE vehicle_id = ? AND check_out_at IS NULL", [s.vehicleId])
        : undefined;
      if (trip.status === "planned" && trip.driverId) dispatchTrip(trip.id, ctx);
      if (!inside && trip.driverId) departTrip(trip.id, ctx);
      note = inside ? `; ${trip.code} departs at gate check-out` : `; ${trip.code} departed`;
    }
    emit(ctx, {
      type: "shipment.departed",
      siteId: s.siteId,
      tripId: s.tripId,
      vehicleId: s.vehicleId,
      entityId: s.id,
      message: `Shipment ${s.code} closed with ${s.huLoaded} HU${note}`,
    });
    return getShipment(s.id);
  });
}

export function listStagedCrossDock(siteId: string): HandlingUnit[] {
  return listHus({ siteId, status: "staged", limit: 300 }).filter((h) => !h.orderId && h.destinationSiteId);
}
