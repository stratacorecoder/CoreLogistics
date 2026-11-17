import {
  ON_TIME_TOLERANCE_MINUTES,
  ZONES,
  type AnalyticsSummary,
  type FefoRiskItem,
  type Zone,
} from "@corelogistics/contracts";
import { many, one } from "../../db.js";
import { listTrips } from "../trips/service.js";

const MIN = 60_000;

function localDay(iso: string | number | Date): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

function avg(values: number[]): number | null {
  return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;
}

function pct(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 1000) / 10 : null;
}

export function summary(siteId: string | undefined, days: number): AnalyticsSummary {
  const now = Date.now();
  const fromMs = now - days * 24 * 3600_000;
  const from = new Date(fromMs).toISOString();
  const to = new Date(now).toISOString();
  const periodMinutes = (now - fromMs) / MIN;
  const site = (col: string) => (siteId ? ` AND ${col} = ?` : "");
  const sp = siteId ? [siteId] : [];

  // Fleet
  const vehicles = many<{ status: string }>("SELECT status FROM vehicles");
  const byStatus: Record<string, number> = {};
  for (const v of vehicles) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;

  // Trips
  const active = listTrips({ active: "true", siteId, limit: 500 });
  const tripSite = siteId ? " AND (origin_site_id = ? OR destination_site_id = ?)" : "";
  const tsp = siteId ? [siteId, siteId] : [];
  const departed = many(
    `SELECT planned_departure, actual_departure FROM trips WHERE actual_departure >= ?${tripSite}`,
    [from, ...tsp],
  );
  const arrived = many(
    `SELECT planned_arrival, actual_arrival FROM trips WHERE actual_arrival >= ?${tripSite}`,
    [from, ...tsp],
  );
  const onTime = (rows: Record<string, string>[], plan: string, actual: string) =>
    rows.filter((r) => Date.parse(r[actual]!) - Date.parse(r[plan]!) <= ON_TIME_TOLERANCE_MINUTES * MIN).length;
  const completedInPeriod = Number(
    one(`SELECT COUNT(*) AS n FROM trips WHERE status = 'completed' AND completed_at >= ?${tripSite}`, [from, ...tsp])!.n,
  );

  // Yard
  const open = many(`SELECT status, check_in_at FROM gate_visits WHERE check_out_at IS NULL${site("site_id")}`, sp);
  const closed = many(
    `SELECT check_in_at, check_out_at FROM gate_visits WHERE check_out_at >= ?${site("site_id")}`,
    [from, ...sp],
  );
  const visitsInPeriod = Number(
    one(`SELECT COUNT(*) AS n FROM gate_visits WHERE check_in_at >= ?${site("site_id")}`, [from, ...sp])!.n,
  );

  // Docks
  const doors = many(
    `SELECT id, code, site_id FROM locations WHERE kind = 'dock_door' AND active = 1${site("site_id")} ORDER BY site_id, code`,
    sp,
  );
  const assignments = many<{ location_id: string; assigned_at: string; released_at: string | null }>(
    `SELECT d.location_id, d.assigned_at, d.released_at FROM dock_assignments d
     JOIN locations l ON l.id = d.location_id
     WHERE (d.released_at IS NULL OR d.released_at >= ?)${site("l.site_id")}`,
    [from, ...sp],
  );
  const docks = doors.map((d) => {
    const mine = assignments.filter((a) => a.location_id === d.id);
    const activeAssignment = mine
      .filter((a) => !a.released_at)
      .sort((a, b) => Date.parse(a.assigned_at) - Date.parse(b.assigned_at))[0];
    const busy = mine.reduce((sum, a) => {
      const start = Math.max(Date.parse(a.assigned_at), fromMs);
      const end = a.released_at ? Date.parse(a.released_at) : now;
      return sum + Math.max(0, end - start) / MIN;
    }, 0);
    return {
      locationId: d.id,
      code: d.code,
      siteId: d.site_id,
      assignments: mine.length,
      busyMinutes: Math.round(busy),
      utilizationPct: Math.round((busy / periodMinutes) * 1000) / 10,
      activeSince: activeAssignment?.assigned_at ?? null,
    };
  });
  const turnaround = assignments
    .filter((a): a is { location_id: string; assigned_at: string; released_at: string } => Boolean(a.released_at))
    .map((a) => (Date.parse(a.released_at) - Date.parse(a.assigned_at)) / MIN);

  // Storage capacity
  const bins = many(
    `SELECT l.zone, l.capacity,
       (SELECT COUNT(*) FROM handling_units h WHERE h.location_id = l.id AND h.status = 'stored') AS used
     FROM locations l WHERE l.kind = 'bin' AND l.active = 1 AND l.zone IS NOT NULL${site("l.site_id")}`,
    sp,
  );
  const capacityByZone = ZONES.map((zone: Zone) => {
    const z = bins.filter((b) => b.zone === zone);
    const capacity = z.reduce((s, b) => s + Number(b.capacity), 0);
    const used = z.reduce((s, b) => s + Number(b.used), 0);
    return { zone, capacity, used, pct: pct(used, capacity) ?? 0 };
  }).filter((z) => z.capacity > 0);

  // Throughput per local day
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(localDay(now - i * 24 * 3600_000));
  const bucket = new Map(dayKeys.map((d) => [d, { date: d, received: 0, shipped: 0, gateIn: 0, gateOut: 0 }]));
  const add = (rows: { t: string }[], key: "received" | "shipped" | "gateIn" | "gateOut") => {
    for (const r of rows) {
      const b = bucket.get(localDay(r.t));
      if (b) b[key] += 1;
    }
  };
  add(many(`SELECT created_at AS t FROM handling_units WHERE receipt_id IS NOT NULL AND created_at >= ?${site("site_id")}`, [from, ...sp]), "received");
  add(
    many(
      `SELECT lr.loaded_at AS t FROM load_records lr JOIN shipments s ON s.id = lr.shipment_id WHERE lr.loaded_at >= ?${site("s.site_id")}`,
      [from, ...sp],
    ),
    "shipped",
  );
  add(many(`SELECT check_in_at AS t FROM gate_visits WHERE check_in_at >= ?${site("site_id")}`, [from, ...sp]), "gateIn");
  add(many(`SELECT check_out_at AS t FROM gate_visits WHERE check_out_at >= ?${site("site_id")}`, [from, ...sp]), "gateOut");

  const count = (sql: string, params: unknown[] = []) => Number(one(sql, params)!.n);

  // Financial & FEFO Risk Intelligence
  const delayPenaltyExposure = active
    .filter((t) => t.delayed)
    .reduce((sum, t) => sum + Math.min(35_000, Math.round(Math.max(15, t.delayMinutes) * 45)), 0);

  const yardDetentionExposure = open.reduce((sum, v) => {
    const dwellMin = (now - Date.parse(v.check_in_at)) / MIN;
    if (dwellMin <= 120) return sum;
    return sum + Math.min(20_000, Math.round((dwellMin - 120) * 25));
  }, 0);

  const maintCents = Number(
    one<{ c: number | null }>(
      `SELECT COALESCE(SUM(cost_cents), 0) AS c FROM maintenance_records WHERE closed_at IS NULL OR opened_at >= ?`,
      [from],
    )?.c ?? 0,
  );
  const maintenanceCost = Math.round(maintCents / 100);

  const expiryRows = many<{
    id: string;
    code: string;
    sku_code: string;
    sku_name: string;
    unit_weight_kg: number;
    lot_number: string | null;
    expiry_date: string;
    qty: number;
    location_code: string | null;
    status: string;
    site_id: string;
  }>(
    `SELECT h.id, h.code, s.code AS sku_code, s.name AS sku_name, s.unit_weight_kg,
            h.lot_number, h.expiry_date, h.qty, l.code AS location_code, h.status, h.site_id
     FROM handling_units h
     JOIN skus s ON s.id = h.sku_id
     LEFT JOIN locations l ON l.id = h.location_id
     WHERE h.status IN ('received', 'sorted', 'stored', 'picked', 'staged')
       AND h.expiry_date IS NOT NULL${site("h.site_id")}
     ORDER BY h.expiry_date ASC
     LIMIT 100`,
    sp,
  );

  let expiringSoonCount = 0;
  let expiredCount = 0;
  let expiringUnitsQty = 0;
  let atRiskInventoryValue = 0;
  const fefoWatchlist: FefoRiskItem[] = [];

  for (const r of expiryRows) {
    const expMs = Date.parse(r.expiry_date);
    if (!Number.isFinite(expMs)) continue;
    const daysRemaining = Math.ceil((expMs - now) / (24 * 3600_000));
    if (daysRemaining <= 0) expiredCount += 1;
    else if (daysRemaining <= 14) expiringSoonCount += 1;

    if (daysRemaining <= 14) {
      expiringUnitsQty += Number(r.qty);
      const unitValue = Math.max(120, Math.round(Number(r.unit_weight_kg || 1) * 180));
      atRiskInventoryValue += Number(r.qty) * unitValue;
    }
    if (fefoWatchlist.length < 8) {
      fefoWatchlist.push({
        id: r.id,
        huCode: r.code,
        skuCode: r.sku_code,
        skuName: r.sku_name,
        lotNumber: r.lot_number ?? null,
        expiryDate: r.expiry_date,
        daysRemaining,
        qty: Number(r.qty),
        locationCode: r.location_code ?? null,
        status: r.status,
        siteId: r.site_id,
      });
    }
  }

  return {
    from,
    to,
    siteId: siteId ?? null,
    fleet: { total: vehicles.length, byStatus },
    trips: {
      active: active.length,
      delayed: active.filter((t) => t.delayed).length,
      completedInPeriod,
      onTimeDeparturePct: pct(onTime(departed, "planned_departure", "actual_departure"), departed.length),
      onTimeArrivalPct: pct(onTime(arrived, "planned_arrival", "actual_arrival"), arrived.length),
    },
    yard: {
      inYard: open.filter((v) => v.status === "in_yard").length,
      atDock: open.filter((v) => v.status === "at_dock").length,
      visitsInPeriod,
      avgDwellMinutes: avg(closed.map((v) => (Date.parse(v.check_out_at) - Date.parse(v.check_in_at)) / MIN)),
      maxCurrentDwellMinutes: open.length
        ? Math.round(Math.max(...open.map((v) => (now - Date.parse(v.check_in_at)) / MIN)))
        : null,
    },
    dockUtilizationPct: avg(docks.map((d) => d.utilizationPct)),
    docks,
    turnaroundMinutes: avg(turnaround),
    capacityByZone,
    throughput: [...bucket.values()],
    openWork: {
      receipts: count(`SELECT COUNT(*) AS n FROM inbound_receipts WHERE status = 'open'${site("site_id")}`, sp),
      putaway: count(`SELECT COUNT(*) AS n FROM putaway_tasks WHERE status = 'open'${site("site_id")}`, sp),
      picks: count(`SELECT COUNT(*) AS n FROM pick_tasks WHERE status = 'open'${site("site_id")}`, sp),
      orders: count(`SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('shipped','cancelled')${site("site_id")}`, sp),
      shipments: count(`SELECT COUNT(*) AS n FROM shipments WHERE status != 'departed'${site("site_id")}`, sp),
    },
    risk: {
      currency: "PHP",
      delayPenaltyExposure,
      yardDetentionExposure,
      maintenanceCost,
      expiringSoonCount,
      expiredCount,
      expiringUnitsQty,
      atRiskInventoryValue,
      fefoWatchlist,
    },
  };
}
