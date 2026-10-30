import { ZONE_META, ZONES, type LayoutCell, type SiteLayout, type Zone } from "@corelogistics/contracts";
import { one, run, tx } from "./db.js";
import { upsertUser } from "./modules/auth/service.js";
import { systemCtx, type Ctx } from "./events.js";
import { createVehicle, createDriver, openMaintenance, closeMaintenance, updateDriver } from "./modules/fleet/service.js";
import { assignDock, checkIn, checkOut, releaseDock } from "./modules/gate/service.js";
import { createDevice } from "./modules/ingest/service.js";
import {
  confirmPick,
  createOrder,
  createShipment,
  departShipment,
  loadShipment,
  releaseOrder,
  stageOrder,
} from "./modules/outbound/service.js";
import { createSite, findLocationByCode, saveLayout } from "./modules/sites/service.js";
import { arriveTrip, completeTrip, createTrip, departTrip, dispatchTrip } from "./modules/trips/service.js";
import {
  closeReceipt,
  confirmPutaway,
  createReceipt,
  createRule,
  createSku,
  listInventory,
  listReceipts,
  receive,
  sortHu,
} from "./modules/warehouse/service.js";

/** Fixed demo keys so the ingest endpoint can be tried straight away (see README). */
export const DEMO_DEVICE_KEYS = {
  whGateCam: "demo-wh-gate-cam",
  depotGateCam: "demo-depot-gate-cam",
  whDockRfid: "demo-wh-dock1-rfid",
  whBinRfid: "demo-wh-bin-rfid",
  gpsT01: "demo-gps-t01",
  gpsT02: "demo-gps-t02",
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (t: number) => new Date(t).toISOString();

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function layoutBuilder(cols: number, rows: number) {
  const map = new Map<string, LayoutCell>();
  const put = (x: number, y: number, kind: LayoutCell["kind"], extra: Partial<LayoutCell> = {}) =>
    map.set(`${x}:${y}`, { x, y, kind, ...extra });
  const build = (): SiteLayout => ({ cols, rows, cells: [...map.values()] });
  return { put, build };
}

function warehouseLayout(): SiteLayout {
  const { put, build } = layoutBuilder(24, 16);
  for (let y = 0; y < 16; y++) {
    put(0, y, y === 7 ? "gate" : "road", y === 7 ? { label: "GATE" } : {});
    put(1, y, "road");
    put(4, y, "road");
    put(5, y, "road");
    if (y >= 1 && y <= 10) {
      put(2, y, "yard_slot");
      put(3, y, "yard_slot");
    } else {
      put(2, y, "road");
      put(3, y, "road");
    }
    put(6, y, y >= 2 && y <= 7 ? "dock_door" : "wall");
    put(23, y, "wall");
  }
  for (let x = 7; x < 23; x++) {
    put(x, 0, "wall");
    put(x, 15, "wall");
  }
  const laneZones: Zone[] = ["A", "B", "C", "H"];
  for (let y = 1; y <= 14; y++) {
    if (y >= 2 && y <= 5) put(7, y, "sort_lane", { zone: laneZones[y - 2] });
    else if (y >= 6 && y <= 8) put(7, y, "staging");
    else put(7, y, "aisle");
    put(8, y, "aisle");
  }
  const rackZone: Record<number, Zone> = { 2: "A", 3: "A", 5: "A", 6: "A", 8: "B", 9: "B", 11: "C", 12: "H" };
  for (let y = 1; y <= 14; y++) {
    for (let x = 9; x <= 22; x++) {
      if (x >= 21 && y >= 13) put(x, y, "office", x === 21 && y === 13 ? { label: "OFFICE" } : {});
      else if (rackZone[y] && x <= 20) put(x, y, "rack", { zone: rackZone[y], levels: 3 });
      else put(x, y, "aisle");
    }
  }
  return build();
}

function depotLayout(): SiteLayout {
  const { put, build } = layoutBuilder(16, 10);
  for (let y = 0; y < 10; y++) {
    put(0, y, y === 4 ? "gate" : "road", y === 4 ? { label: "GATE-N" } : {});
    put(1, y, "road");
    put(15, y, "wall");
  }
  for (let x = 2; x <= 13; x++) {
    put(x, 0, "road");
    put(x, 1, "yard_slot", { label: `P${String(x - 1).padStart(2, "0")}` });
    put(x, 8, "yard_slot", { label: `P${String(x + 11).padStart(2, "0")}` });
    put(x, 9, "road");
    for (let y = 2; y <= 7; y++) put(x, y, "road");
  }
  put(13, 4, "staging", { label: "XD-STG" });
  put(14, 4, "dock_door", { label: "DD1" });
  put(14, 5, "dock_door", { label: "DD2" });
  put(14, 1, "office", { label: "OFFICE" });
  put(14, 2, "office");
  put(14, 7, "office", { label: "WORKSHOP" });
  put(14, 8, "office");
  return build();
}

const SKUS: Array<[string, string, string, Zone, number, number]> = [
  ["BEV-COLA-24", "Cola 24×330ml case", "Beverages", "A", 8.6, 0.012],
  ["BEV-WATER-12", "Still water 12×1.5L", "Beverages", "A", 18.5, 0.025],
  ["BEV-JUICE-12", "Orange juice 12×1L", "Beverages", "A", 12.8, 0.016],
  ["BEV-COFFEE-6", "Ground coffee 6×500g", "Beverages", "A", 3.2, 0.006],
  ["SNK-CHIPS-30", "Potato chips 30-pack", "Snacks", "A", 2.4, 0.04],
  ["SNK-BISC-24", "Biscuits 24-pack", "Snacks", "A", 5.1, 0.018],
  ["SNK-NUTS-20", "Mixed nuts 20×200g", "Snacks", "A", 4.3, 0.008],
  ["HH-DET-4", "Laundry detergent 4×3kg", "Household", "A", 12.4, 0.014],
  ["HH-TISSUE-48", "Toilet tissue 48 rolls", "Household", "A", 4.8, 0.09],
  ["HH-DISH-12", "Dish soap 12×750ml", "Household", "A", 9.6, 0.011],
  ["PC-SHAMP-12", "Shampoo 12×400ml", "Personal care", "A", 5.4, 0.007],
  ["PC-SOAP-48", "Bar soap 48-pack", "Personal care", "A", 6.2, 0.006],
  ["PC-TOOTH-36", "Toothpaste 36-pack", "Personal care", "A", 4.1, 0.005],
  ["GR-RICE-25", "Jasmine rice 25kg sack", "Grocery", "A", 25.2, 0.032],
  ["GR-OIL-12", "Cooking oil 12×1L", "Grocery", "A", 11.6, 0.014],
  ["GR-NOODLE-48", "Instant noodles 48-pack", "Grocery", "A", 3.9, 0.03],
  ["GR-CANNED-24", "Canned tuna 24-pack", "Grocery", "A", 4.6, 0.005],
  ["GR-SUGAR-20", "Sugar 20×1kg", "Grocery", "A", 20.3, 0.019],
  ["APL-FRIDGE", "Refrigerator 300L", "Appliances", "B", 62, 0.9],
  ["APL-WASHER", "Washing machine 8kg", "Appliances", "B", 68, 0.55],
  ["APL-TV-55", "55\" television", "Appliances", "B", 18, 0.21],
  ["FUR-SOFA-3", "3-seat sofa", "Furniture", "B", 48, 1.6],
  ["FUR-DESK", "Office desk flat-pack", "Furniture", "B", 32, 0.18],
  ["FRZ-CHICK-10", "Frozen chicken 10kg box", "Frozen", "C", 10.4, 0.016],
  ["FRZ-FISH-10", "Frozen fish fillet 10kg", "Frozen", "C", 10.3, 0.015],
  ["DRY-MILK-24", "Fresh milk 24×1L", "Dairy", "C", 25.4, 0.028],
  ["DRY-CHEESE-12", "Cheddar 12×500g", "Dairy", "C", 6.3, 0.007],
  ["HZ-BLEACH-12", "Bleach 12×1L", "Chemicals", "H", 13.1, 0.014],
  ["HZ-AEROSOL-24", "Aerosol spray 24-pack", "Chemicals", "H", 7.2, 0.012],
  ["HZ-LIBATT-50", "Lithium batteries 50-pack", "Batteries", "H", 2.6, 0.004],
];

const STAFF = ["Ana Reyes", "Ben Cruz", "Carla Santos", "Dan Lim", "Eli Tan"];

export function seedIfEmpty(): boolean {
  if (one("SELECT 1 FROM sites LIMIT 1")) return false;
  tx(() => seed());
  return true;
}

/** Issued demo logins. Username is lowercase first name. Drivers share the password `drive`. */
export const DEMO_ACCOUNTS = [
  { username: "ava", password: "planner", name: "Ava Chen", role: "tower" as const },
  { username: "rico", password: "yard", name: "Rico Santos", role: "gate" as const },
  { username: "mina", password: "floor", name: "Mina Cruz", role: "warehouse" as const },
  { username: "jose", password: "drive", name: "Jose Mendoza", role: "driver" as const },
  { username: "maria", password: "drive", name: "Maria Garcia", role: "driver" as const },
  { username: "ramon", password: "drive", name: "Ramon Bautista", role: "driver" as const },
  { username: "liza", password: "drive", name: "Liza Villanueva", role: "driver" as const },
  { username: "mark", password: "drive", name: "Mark Aquino", role: "driver" as const },
  { username: "grace", password: "drive", name: "Grace Dela Cruz", role: "driver" as const },
  { username: "paolo", password: "drive", name: "Paolo Ramos", role: "driver" as const },
  { username: "nina", password: "drive", name: "Nina Flores", role: "driver" as const },
];

export function ensureDemoUsers(): void {
  tx(() => {
    for (const a of DEMO_ACCOUNTS) {
      const driver = a.role === "driver" ? one<{ id: string }>("SELECT id FROM drivers WHERE name = ?", [a.name]) : undefined;
      upsertUser({ ...a, driverId: driver?.id ?? null });
    }
  });
}

function seed() {
  const rand = rng(20261027);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const at = (t: number, actor: string | null = pick(STAFF)): Ctx => ({ source: "manual", actor, occurredAt: iso(t) });
  const now = Date.now();
  const sys = systemCtx;

  for (const code of ZONES) {
    const m = ZONE_META[code];
    run("INSERT INTO zones (code, label, color, description) VALUES (?, ?, ?, ?)", [code, m.label, m.color, m.description]);
  }

  // Sites
  const site = (code: string, name: string, kind: "depot" | "warehouse" | "customer" | "supplier", address: string, lat: number, lng: number, geofenceM = 400) =>
    createSite({ code, name, kind, address, lat, lng, geofenceM }, sys);
  const depot = site("DEP-N", "Northgate Depot", "depot", "MacArthur Hwy, Valenzuela", 14.7004, 120.983, 500);
  const wh = site("WH-C", "Central Distribution Center", "warehouse", "Light Industry Park, Calamba", 14.2117, 121.1653, 600);
  const cQC = site("CUS-QC", "QC Superstore", "customer", "Commonwealth Ave, Quezon City", 14.676, 121.0437);
  const cMKT = site("CUS-MKT", "Makati Retail Hub", "customer", "Ayala Ave, Makati", 14.5547, 121.0244);
  const cPAM = site("CUS-PAM", "Pampanga Grocers", "customer", "San Fernando, Pampanga", 15.0286, 120.6898);
  const cBAT = site("CUS-BAT", "Batangas Port Mart", "customer", "Batangas City Port", 13.7565, 121.0583);
  const sMFG = site("SUP-MFG", "Cavite Manufacturing Co.", "supplier", "PEZA Rosario, Cavite", 14.4167, 120.85);
  const sCOLD = site("SUP-COLD", "Bulacan Cold Foods", "supplier", "Marilao, Bulacan", 14.758, 120.948);
  const sCHEM = site("SUP-CHEM", "Laguna ChemWorks", "supplier", "Sta. Rosa, Laguna", 14.3122, 121.1114);
  const customers = [cQC, cMKT, cPAM, cBAT];
  const suppliers = [sMFG, sCOLD, sCHEM];

  saveLayout(wh.id, warehouseLayout(), sys);
  saveLayout(depot.id, depotLayout(), sys);
  const loc = (siteId: string, code: string) => findLocationByCode(siteId, code)!;

  // Fleet
  const models = ["Isuzu FVR 10-wheeler", "Hino 500 FG", "Fuso Fighter", "Isuzu Giga", "Hino 700"];
  const trucks = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return createVehicle(
      {
        code: `T${String(n).padStart(2, "0")}`,
        plate: `N${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(66 + ((i * 3) % 24))} ${4100 + n * 37}`,
        kind: n >= 9 ? "van" : "truck",
        model: n >= 9 ? "Toyota Hiace cargo" : models[i % models.length]!,
        capacityKg: n >= 9 ? 1200 : 9000 + (n % 3) * 3000,
        capacityM3: n >= 9 ? 8 : 38 + (n % 3) * 8,
        homeSiteId: depot.id,
        odometerKm: 40000 + n * 12873,
        rfidTag: n <= 4 ? `E200-TRK-${String(n).padStart(4, "0")}` : null,
      },
      sys,
    );
  });
  const trailers = Array.from({ length: 6 }, (_, i) =>
    createVehicle(
      {
        code: `TR${String(i + 1).padStart(2, "0")}`,
        plate: `TRL ${7200 + i * 11}`,
        kind: "trailer",
        model: i < 2 ? "Reefer trailer 40ft" : "Curtainsider 40ft",
        capacityKg: 24000,
        capacityM3: 76,
        homeSiteId: depot.id,
        odometerKm: 0,
      },
      sys,
    ),
  );
  const driverNames = [
    "Jose Mendoza",
    "Maria Garcia",
    "Ramon Bautista",
    "Liza Villanueva",
    "Mark Aquino",
    "Grace Dela Cruz",
    "Paolo Ramos",
    "Nina Flores",
  ];
  const drivers = driverNames.map((name, i) =>
    createDriver(
      {
        code: `D${String(i + 1).padStart(2, "0")}`,
        name,
        phone: `+63 917 555 ${String(1200 + i * 47).padStart(4, "0")}`,
        licenseClass: i < 6 ? "CE" : "C",
        licenseExpiry: `202${7 + (i % 3)}-0${1 + (i % 9)}-15`,
        homeSiteId: depot.id,
      },
      sys,
    ),
  );

  const skus = SKUS.map(([code, name, category, zone, w, v]) =>
    createSku({ code, name, category, zone, unitWeightKg: w, unitVolumeM3: v }),
  );
  const skuByCode = new Map(skus.map((s) => [s.code, s]));
  const zoneSkus = (z: Zone) => skus.filter((s) => s.zone === z);

  // Sort rules
  const lane = (code: string) => loc(wh.id, code).id;
  createRule({ siteId: wh.id, priority: 5, matchKind: "destination", matchValue: "CUS-PAM", sortLaneId: lane("L01"), active: true });
  createRule({ siteId: wh.id, priority: 10, matchKind: "zone", matchValue: "C", sortLaneId: lane("L03"), active: true });
  createRule({ siteId: wh.id, priority: 10, matchKind: "zone", matchValue: "H", sortLaneId: lane("L04"), active: true });
  createRule({ siteId: wh.id, priority: 20, matchKind: "category", matchValue: "Appliances", sortLaneId: lane("L02"), active: true });
  createRule({ siteId: wh.id, priority: 20, matchKind: "category", matchValue: "Furniture", sortLaneId: lane("L02"), active: true });

  // Devices with fixed demo keys
  createDevice({ code: "CAM-WH-GATE", name: "WH-C gate ANPR camera", kind: "camera", locationId: loc(wh.id, "GATE").id }, sys, DEMO_DEVICE_KEYS.whGateCam);
  createDevice({ code: "CAM-DEP-GATE", name: "Depot gate ANPR camera", kind: "camera", locationId: loc(depot.id, "GATE-N").id }, sys, DEMO_DEVICE_KEYS.depotGateCam);
  createDevice({ code: "RFID-WH-D01", name: "Dock D01 portal reader", kind: "rfid", locationId: loc(wh.id, "D01").id }, sys, DEMO_DEVICE_KEYS.whDockRfid);
  createDevice({ code: "RFID-WH-R01-1", name: "Bin R01-1 shelf reader", kind: "rfid", locationId: loc(wh.id, "R01-1").id }, sys, DEMO_DEVICE_KEYS.whBinRfid);
  createDevice({ code: "GPS-T01", name: "T01 telematics", kind: "gps", vehicleId: trucks[0]!.id }, sys, DEMO_DEVICE_KEYS.gpsT01);
  createDevice({ code: "GPS-T02", name: "T02 telematics", kind: "gps", vehicleId: trucks[1]!.id }, sys, DEMO_DEVICE_KEYS.gpsT02);

  const travelMin = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const km = Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 107) * 1.3;
    return Math.max(35, Math.round((km / 38) * 60));
  };

  // History: inbound flows put stock away, outbound flows ship it ------------
  let truckTurn = 0;
  let driverTurn = 0;
  const nextTruck = () => trucks[truckTurn++ % 8]!;
  const nextDriver = () => drivers[driverTurn++ % 7]!;

  function inbound(arrival: number, supplier = pick(suppliers)) {
    const truck = nextTruck();
    const driver = nextDriver();
    const travel = travelMin(supplier, wh);
    const plannedArr = arrival;
    const plannedDep = plannedArr - travel * MIN;
    const late = rand() < 0.25 ? between(20, 55) : between(-8, 10);
    const trip = createTrip(
      {
        kind: "inbound",
        originSiteId: supplier.id,
        destinationSiteId: wh.id,
        vehicleId: truck.id,
        driverId: driver.id,
        plannedDeparture: iso(plannedDep),
        plannedArrival: iso(plannedArr),
        notes: "",
        stops: [],
      },
      at(plannedDep - 20 * HOUR, "Planner"),
    );
    dispatchTrip(trip.id, at(plannedDep - 60 * MIN, "Planner"));
    departTrip(trip.id, { source: "manual", actor: driver.name, occurredAt: iso(plannedDep + late * MIN) });
    let t = plannedArr + (late + between(-5, 8)) * MIN;
    const visit = checkIn({ siteId: wh.id, vehicleId: truck.id, sealNo: `SL${between(100000, 999999)}`, notes: "" }, at(t, "Gate"));
    t += between(8, 35) * MIN;
    assignDock(visit.id, {}, at(t, "Gate"));
    const receipt = listReceipts(wh.id, "open").find((r) => r.visitId === visit.id)!;
    const pool = supplier === sCOLD ? zoneSkus("C") : supplier === sCHEM ? [...zoneSkus("H"), ...zoneSkus("A").slice(7, 10)] : [...zoneSkus("A"), ...zoneSkus("B")];
    const n = between(3, 6);
    for (let i = 0; i < n; i++) {
      t += between(3, 7) * MIN;
      const sku = pick(pool);
      const qty = sku.zone === "B" ? between(4, 10) : between(30, 60);
      const hu = receive(receipt.id, { skuId: sku.id, qty, kind: "pallet" }, at(t));
      t += between(1, 4) * MIN;
      const sorted = sortHu(hu.id, at(t));
      t += between(4, 12) * MIN;
      if (sorted.putaway?.suggestedLocationId) confirmPutaway(sorted.putaway.id, undefined, at(t));
    }
    closeReceipt(receipt.id, at(t + 2 * MIN));
    t += between(5, 15) * MIN;
    releaseDock(visit.id, at(t, "Gate"));
    t += between(4, 20) * MIN;
    checkOut({ visitId: visit.id, sealNo: "", notes: "" }, at(t, "Gate"));
    return t;
  }

  function outbound(start: number, customer = pick(customers)) {
    const stock = new Map<string, number>();
    for (const row of listInventory(wh.id)) stock.set(row.skuId, (stock.get(row.skuId) ?? 0) + row.qty);
    const avail = [...stock.entries()].filter(([, q]) => q >= 8);
    if (avail.length < 2) return start;
    const lines = Array.from({ length: Math.min(avail.length, between(2, 4)) }, () => pick(avail))
      .filter((v, i, a) => a.findIndex((x) => x[0] === v[0]) === i)
      .map(([skuId, q]) => ({ skuId, qty: Math.max(2, Math.min(q, between(4, 24))) }));
    let t = start - 4 * HOUR;
    const order = createOrder({ siteId: wh.id, customerSiteId: customer.id, dueAt: iso(start + 6 * HOUR), lines }, at(t, "Sales desk"));
    t += between(20, 60) * MIN;
    const released = releaseOrder(order.id, at(t));
    for (const task of released.tasks) {
      t += between(3, 9) * MIN;
      confirmPick(task.id, at(t));
    }
    if (!released.tasks.length) return start;
    t += between(5, 15) * MIN;
    stageOrder(order.id, undefined, at(t));

    const truck = nextTruck();
    const driver = nextDriver();
    const travel = travelMin(wh, customer);
    const plannedDep = start + 60 * MIN;
    const trip = createTrip(
      {
        kind: "outbound",
        originSiteId: wh.id,
        destinationSiteId: customer.id,
        vehicleId: truck.id,
        driverId: driver.id,
        plannedDeparture: iso(plannedDep),
        plannedArrival: iso(plannedDep + travel * MIN),
        notes: "",
        stops: [],
      },
      at(start - 20 * HOUR, "Planner"),
    );
    dispatchTrip(trip.id, at(start - 2 * HOUR, "Planner"));
    t = start + between(-10, 15) * MIN;
    const visit = checkIn({ siteId: wh.id, vehicleId: truck.id, sealNo: "", notes: "" }, at(t, "Gate"));
    t += between(5, 20) * MIN;
    assignDock(visit.id, {}, at(t, "Gate"));
    const shipment = createShipment({ siteId: wh.id, tripId: trip.id, orderIds: [order.id] }, at(t + MIN));
    t += between(15, 35) * MIN;
    loadShipment(shipment.id, undefined, at(t));
    t += between(3, 10) * MIN;
    departShipment(shipment.id, at(t));
    t += between(5, 25) * MIN + (rand() < 0.2 ? between(20, 50) * MIN : 0);
    checkOut({ visitId: visit.id, sealNo: `SL${between(100000, 999999)}`, notes: "" }, at(t, "Gate"));
    t += (travel + between(-5, 25)) * MIN;
    arriveTrip(trip.id, { source: "manual", actor: driver.name, occurredAt: iso(t) });
    completeTrip(trip.id, { source: "manual", actor: driver.name, occurredAt: iso(t + between(20, 45) * MIN) });
    return t;
  }

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  for (let d = 7; d >= 1; d--) {
    const day = today - d * 24 * HOUR;
    inbound(day + 6 * HOUR + between(0, 30) * MIN, sMFG);
    inbound(day + 8 * HOUR + between(0, 30) * MIN, sCOLD);
    inbound(day + 10 * HOUR + between(0, 30) * MIN);
    if (d % 2 === 0) inbound(day + 11 * HOUR + 30 * MIN, sCHEM);
    outbound(day + 13 * HOUR + between(0, 20) * MIN);
    outbound(day + 15 * HOUR + between(0, 20) * MIN);
    if (d % 3 !== 0) outbound(day + 17 * HOUR);
  }
  // Earlier today, only if those hours have passed
  if (now - today > 9 * HOUR) inbound(today + 6 * HOUR, sMFG);

  // Maintenance history and a truck in the workshop
  const T = (n: number) => trucks[n - 1]!;
  for (const [n, kind, desc, daysAgo, cost] of [
    [3, "service", "60,000 km service", 6, 1850000],
    [6, "repair", "Replace brake pads", 4, 920000],
    [2, "inspection", "LTO annual inspection", 2, 150000],
  ] as const) {
    const opened = openMaintenance({ vehicleId: T(n).id, kind, description: desc }, at(now - daysAgo * 24 * HOUR, "Workshop"));
    closeMaintenance(opened.id, cost, at(now - daysAgo * 24 * HOUR + 5 * HOUR, "Workshop"));
  }

  // Live state ----------------------------------------------------------------
  const live = (offsetMin: number, actor: string | null = pick(STAFF)) => at(now + offsetMin * MIN, actor);
  const [d1, d2, d3, d4, d5, d6, d7, d8] = drivers as [typeof drivers[0], typeof drivers[0], typeof drivers[0], typeof drivers[0], typeof drivers[0], typeof drivers[0], typeof drivers[0], typeof drivers[0]];

  // T01: cold-chain inbound, on time, tracked by GPS
  const tripCold = createTrip(
    {
      kind: "inbound",
      originSiteId: sCOLD.id,
      destinationSiteId: wh.id,
      vehicleId: T(1).id,
      trailerId: trailers[0]!.id,
      driverId: d1.id,
      plannedDeparture: iso(now - 70 * MIN),
      plannedArrival: iso(now + 45 * MIN),
      notes: "Reefer at -18°C. Dock at a C-zone door if possible.",
      stops: [],
    },
    live(-20 * 60, "Planner"),
  );
  dispatchTrip(tripCold.id, live(-120, "Planner"));
  departTrip(tripCold.id, { source: "manual", actor: d1.name, occurredAt: iso(now - 66 * MIN) });
  run("UPDATE vehicles SET last_lat = ?, last_lng = ?, last_seen_at = ? WHERE id = ?", [14.47, 121.05, iso(now - 2 * MIN), T(1).id]);

  // T02: chemicals inbound, running late
  const tripChem = createTrip(
    {
      kind: "inbound",
      originSiteId: sCHEM.id,
      destinationSiteId: wh.id,
      vehicleId: T(2).id,
      driverId: d2.id,
      plannedDeparture: iso(now - 150 * MIN),
      plannedArrival: iso(now - 30 * MIN),
      notes: "Hazmat placards required",
      stops: [],
    },
    live(-22 * 60, "Planner"),
  );
  dispatchTrip(tripChem.id, live(-180, "Planner"));
  departTrip(tripChem.id, { source: "manual", actor: d2.name, occurredAt: iso(now - 95 * MIN) });

  // T03: at dock D02 unloading, receipt with expected lines, work in progress
  const tripMfg = createTrip(
    {
      kind: "inbound",
      originSiteId: sMFG.id,
      destinationSiteId: wh.id,
      vehicleId: T(3).id,
      driverId: d3.id,
      plannedDeparture: iso(now - 150 * MIN),
      plannedArrival: iso(now - 55 * MIN),
      notes: "",
      stops: [],
    },
    live(-26 * 60, "Planner"),
  );
  dispatchTrip(tripMfg.id, live(-200, "Planner"));
  departTrip(tripMfg.id, { source: "manual", actor: d3.name, occurredAt: iso(now - 148 * MIN) });
  const rcv = createReceipt(
    {
      siteId: wh.id,
      tripId: tripMfg.id,
      supplier: sMFG.name,
      lines: [
        { skuId: skuByCode.get("BEV-COLA-24")!.id, expectedQty: 120 },
        { skuId: skuByCode.get("SNK-CHIPS-30")!.id, expectedQty: 80 },
        { skuId: skuByCode.get("APL-TV-55")!.id, expectedQty: 12 },
        { skuId: skuByCode.get("HH-DET-4")!.id, expectedQty: 60 },
      ],
    },
    live(-26 * 60, "Planner"),
  );
  const v3 = checkIn({ siteId: wh.id, vehicleId: T(3).id, sealNo: "SL448120", notes: "" }, live(-50, "Gate"));
  assignDock(v3.id, { locationId: loc(wh.id, "D02").id }, live(-38, "Gate"));
  const hu1 = receive(rcv.id, { skuId: skuByCode.get("BEV-COLA-24")!.id, qty: 60, kind: "pallet" }, live(-30));
  const s1 = sortHu(hu1.id, live(-28));
  if (s1.putaway?.suggestedLocationId) confirmPutaway(s1.putaway.id, undefined, live(-20));
  const hu2 = receive(rcv.id, { skuId: skuByCode.get("BEV-COLA-24")!.id, qty: 60, kind: "pallet" }, live(-18));
  sortHu(hu2.id, live(-15));
  receive(rcv.id, { skuId: skuByCode.get("APL-TV-55")!.id, qty: 6, kind: "pallet" }, live(-12));
  receive(rcv.id, { skuId: skuByCode.get("SNK-CHIPS-30")!.id, qty: 40, kind: "pallet", destinationSiteId: cPAM.id }, live(-8));

  // T04: arrived from supplier, waiting in the yard for a door
  const tripMfg2 = createTrip(
    {
      kind: "inbound",
      originSiteId: sMFG.id,
      destinationSiteId: wh.id,
      vehicleId: T(4).id,
      driverId: d4.id,
      plannedDeparture: iso(now - 110 * MIN),
      plannedArrival: iso(now - 20 * MIN),
      notes: "",
      stops: [],
    },
    live(-24 * 60, "Planner"),
  );
  dispatchTrip(tripMfg2.id, live(-150, "Planner"));
  departTrip(tripMfg2.id, { source: "manual", actor: d4.name, occurredAt: iso(now - 105 * MIN) });
  checkIn({ siteId: wh.id, vehicleId: T(4).id, sealNo: "SL448377", notes: "" }, live(-22, "Gate"));

  // T05: collecting an outbound shipment that is staged and ready to load
  const stockFor = (codes: string[]) =>
    codes
      .map((c) => skuByCode.get(c)!)
      .filter((s) => listInventory(wh.id, s.id).reduce((n, r) => n + r.qty, 0) >= 10);
  const qcLines = stockFor(["BEV-COLA-24", "GR-RICE-25", "HH-TISSUE-48", "SNK-BISC-24", "GR-OIL-12", "PC-SOAP-48"])
    .slice(0, 3)
    .map((s) => ({ skuId: s.id, qty: between(6, 10) }));
  const orderQC = createOrder({ siteId: wh.id, customerSiteId: cQC.id, dueAt: iso(now + 5 * HOUR), lines: qcLines }, live(-5 * 60, "Sales desk"));
  const relQC = releaseOrder(orderQC.id, live(-150));
  relQC.tasks.forEach((task, i) => confirmPick(task.id, live(-140 + i * 6)));
  if (relQC.tasks.length) stageOrder(orderQC.id, undefined, live(-95));
  const tripQC = createTrip(
    {
      kind: "outbound",
      originSiteId: wh.id,
      destinationSiteId: cQC.id,
      vehicleId: T(5).id,
      driverId: d5.id,
      plannedDeparture: iso(now + 45 * MIN),
      plannedArrival: iso(now + 45 * MIN + travelMin(wh, cQC) * MIN),
      notes: "Deliver to receiving bay 3",
      stops: [],
    },
    live(-20 * 60, "Planner"),
  );
  dispatchTrip(tripQC.id, live(-90, "Planner"));
  checkIn({ siteId: wh.id, vehicleId: T(5).id, sealNo: "", notes: "" }, live(-14, "Gate"));
  if (relQC.tasks.length) createShipment({ siteId: wh.id, tripId: tripQC.id, orderIds: [orderQC.id] }, live(-10));

  // Orders in various states
  const mktLines = stockFor(["GR-NOODLE-48", "PC-SHAMP-12", "BEV-JUICE-12", "GR-CANNED-24", "BEV-WATER-12"])
    .slice(0, 3)
    .map((s) => ({ skuId: s.id, qty: between(5, 12) }));
  if (mktLines.length) {
    const orderMKT = createOrder({ siteId: wh.id, customerSiteId: cMKT.id, dueAt: iso(now + 8 * HOUR), lines: mktLines }, live(-3 * 60, "Sales desk"));
    const rel = releaseOrder(orderMKT.id, live(-40));
    if (rel.tasks[0]) confirmPick(rel.tasks[0].id, live(-30));
  }
  const pamLines = stockFor(["BEV-COLA-24", "SNK-NUTS-20", "GR-SUGAR-20", "HH-DISH-12"]).slice(0, 2);
  if (pamLines.length) {
    createOrder({ siteId: wh.id, customerSiteId: cPAM.id, dueAt: iso(today + 34 * HOUR), lines: pamLines.map((s) => ({ skuId: s.id, qty: between(8, 16) })) }, live(-60, "Sales desk"));
  }
  const batLines = stockFor(["FRZ-CHICK-10", "DRY-MILK-24", "FRZ-FISH-10", "GR-RICE-25"]).slice(0, 2);
  if (batLines.length) {
    createOrder({ siteId: wh.id, customerSiteId: cBAT.id, dueAt: iso(today + 36 * HOUR), lines: batLines.map((s) => ({ skuId: s.id, qty: between(4, 10) })) }, live(-35, "Sales desk"));
  }

  // Depot: trucks parked, a transfer about to leave, a truck in the workshop
  checkIn({ siteId: depot.id, vehicleId: T(7).id, sealNo: "", notes: "" }, live(-9 * 60, "Gate"));
  checkIn({ siteId: depot.id, vehicleId: T(8).id, sealNo: "", notes: "" }, live(-8 * 60, "Gate"));
  checkIn({ siteId: depot.id, vehicleId: T(10).id, sealNo: "", notes: "Van needs tyre check" }, live(-26 * 60, "Gate"));
  for (const tr of trailers.slice(1, 5)) checkIn({ siteId: depot.id, vehicleId: tr.id, sealNo: "", notes: "" }, live(-30 * 60, "Gate"));
  openMaintenance({ vehicleId: T(10).id, kind: "repair", description: "Rear tyre replacement and alignment" }, live(-25 * 60, "Workshop"));

  const tripTransfer = createTrip(
    {
      kind: "transfer",
      originSiteId: depot.id,
      destinationSiteId: wh.id,
      vehicleId: T(7).id,
      trailerId: trailers[2]!.id,
      driverId: d7.id,
      plannedDeparture: iso(now + 100 * MIN),
      plannedArrival: iso(now + 100 * MIN + travelMin(depot, wh) * MIN),
      notes: "Empty trailer repositioning",
      stops: [],
    },
    live(-6 * 60, "Planner"),
  );
  dispatchTrip(tripTransfer.id, live(-30, "Planner"));

  // Tomorrow's plan: one unassigned, one with a truck but no driver, one with a stop
  createTrip(
    {
      kind: "outbound",
      originSiteId: wh.id,
      destinationSiteId: cPAM.id,
      plannedDeparture: iso(today + 30 * HOUR),
      plannedArrival: iso(today + 33 * HOUR),
      notes: "Combine PAM order and cross-dock freight",
      stops: [],
    },
    live(-45, "Planner"),
  );
  createTrip(
    {
      kind: "outbound",
      originSiteId: wh.id,
      destinationSiteId: cBAT.id,
      vehicleId: T(6).id,
      plannedDeparture: iso(today + 31 * HOUR),
      plannedArrival: iso(today + 33 * HOUR + 30 * MIN),
      notes: "Cold chain: needs reefer trailer",
      stops: [],
    },
    live(-40, "Planner"),
  );
  createTrip(
    {
      kind: "outbound",
      originSiteId: wh.id,
      destinationSiteId: cQC.id,
      vehicleId: T(9).id,
      driverId: d6.id,
      plannedDeparture: iso(today + 32 * HOUR),
      plannedArrival: iso(today + 35 * HOUR),
      notes: "Milk run",
      stops: [{ siteId: cMKT.id, plannedAt: iso(today + 33 * HOUR + 30 * MIN) }],
    },
    live(-30, "Planner"),
  );

  updateDriver(d8.id, { status: "off_duty" }, live(-12 * 60, "Planner"));
}
