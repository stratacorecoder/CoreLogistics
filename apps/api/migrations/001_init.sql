-- CoreLogistics schema v1. Plain SQLite so any runtime (Node, Python) can apply it.
-- Timestamps are ISO-8601 UTC strings. Booleans are 0/1 integers.

CREATE TABLE sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Sites and layout -----------------------------------------------------------

CREATE TABLE sites (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('depot', 'warehouse', 'customer', 'supplier')),
  address    TEXT NOT NULL DEFAULT '',
  lat        REAL NOT NULL DEFAULT 0,
  lng        REAL NOT NULL DEFAULT 0,
  geofence_m REAL NOT NULL DEFAULT 300
);

CREATE TABLE site_layouts (
  site_id    TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  rows       INTEGER NOT NULL,
  cols       INTEGER NOT NULL,
  cells      TEXT NOT NULL, -- JSON array of LayoutCell
  updated_at TEXT NOT NULL
);

CREATE TABLE zones (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE locations (
  id       TEXT PRIMARY KEY,
  site_id  TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('gate', 'dock_door', 'yard_slot', 'staging', 'sort_lane', 'aisle', 'rack', 'bin')),
  code     TEXT NOT NULL,
  x        INTEGER NOT NULL,
  y        INTEGER NOT NULL,
  level    INTEGER NOT NULL DEFAULT 0,
  zone     TEXT REFERENCES zones(code),
  capacity INTEGER NOT NULL DEFAULT 1,
  active   INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX locations_site_cell ON locations (site_id, x, y, level);
CREATE INDEX locations_site_kind ON locations (site_id, kind, active);

-- Fleet ----------------------------------------------------------------------

CREATE TABLE vehicles (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  plate           TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('truck', 'trailer', 'van')),
  model           TEXT NOT NULL DEFAULT '',
  capacity_kg     REAL NOT NULL DEFAULT 0,
  capacity_m3     REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'available',
  home_site_id    TEXT REFERENCES sites(id),
  current_site_id TEXT REFERENCES sites(id),
  odometer_km     REAL NOT NULL DEFAULT 0,
  rfid_tag        TEXT UNIQUE,
  last_lat        REAL,
  last_lng        REAL,
  last_seen_at    TEXT
);

CREATE TABLE drivers (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  license_class  TEXT NOT NULL DEFAULT 'C',
  license_expiry TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'available',
  home_site_id   TEXT REFERENCES sites(id)
);

CREATE TABLE maintenance_records (
  id          TEXT PRIMARY KEY,
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  description TEXT NOT NULL,
  opened_at   TEXT NOT NULL,
  closed_at   TEXT,
  cost_cents  INTEGER NOT NULL DEFAULT 0,
  odometer_km REAL
);
CREATE INDEX maintenance_vehicle ON maintenance_records (vehicle_id, closed_at);

-- Trips ----------------------------------------------------------------------

CREATE TABLE trips (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  kind                TEXT NOT NULL CHECK (kind IN ('inbound', 'outbound', 'transfer')),
  status              TEXT NOT NULL DEFAULT 'planned',
  origin_site_id      TEXT NOT NULL REFERENCES sites(id),
  destination_site_id TEXT NOT NULL REFERENCES sites(id),
  vehicle_id          TEXT REFERENCES vehicles(id),
  trailer_id          TEXT REFERENCES vehicles(id),
  driver_id           TEXT REFERENCES drivers(id),
  planned_departure   TEXT NOT NULL,
  planned_arrival     TEXT NOT NULL,
  actual_departure    TEXT,
  actual_arrival      TEXT,
  completed_at        TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL
);
CREATE INDEX trips_status ON trips (status);
CREATE INDEX trips_vehicle ON trips (vehicle_id, status);
CREATE INDEX trips_driver ON trips (driver_id, status);

CREATE TABLE trip_stops (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  site_id     TEXT NOT NULL REFERENCES sites(id),
  planned_at  TEXT,
  arrived_at  TEXT,
  departed_at TEXT
);
CREATE INDEX trip_stops_trip ON trip_stops (trip_id, seq);

-- Gate and yard --------------------------------------------------------------

CREATE TABLE gate_visits (
  id               TEXT PRIMARY KEY,
  site_id          TEXT NOT NULL REFERENCES sites(id),
  vehicle_id       TEXT NOT NULL REFERENCES vehicles(id),
  trip_id          TEXT REFERENCES trips(id),
  plate            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('in_yard', 'at_dock', 'departed')),
  check_in_at      TEXT NOT NULL,
  check_out_at     TEXT,
  yard_location_id TEXT REFERENCES locations(id),
  seal_in          TEXT NOT NULL DEFAULT '',
  seal_out         TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  source_in        TEXT NOT NULL DEFAULT 'manual',
  source_out       TEXT
);
CREATE INDEX gate_visits_site_open ON gate_visits (site_id, check_out_at);
CREATE INDEX gate_visits_vehicle ON gate_visits (vehicle_id, check_out_at);

CREATE TABLE dock_assignments (
  id          TEXT PRIMARY KEY,
  visit_id    TEXT NOT NULL REFERENCES gate_visits(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id),
  purpose     TEXT NOT NULL CHECK (purpose IN ('unload', 'load')),
  assigned_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX dock_assignments_open ON dock_assignments (location_id, released_at);

-- Warehouse ------------------------------------------------------------------

CREATE TABLE skus (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL,
  zone           TEXT NOT NULL REFERENCES zones(code),
  unit_weight_kg REAL NOT NULL DEFAULT 0,
  unit_volume_m3 REAL NOT NULL DEFAULT 0
);

CREATE TABLE inventory (
  site_id     TEXT NOT NULL REFERENCES sites(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  sku_id      TEXT NOT NULL REFERENCES skus(id),
  qty         INTEGER NOT NULL,
  PRIMARY KEY (location_id, sku_id)
);
CREATE INDEX inventory_site_sku ON inventory (site_id, sku_id);

CREATE TABLE inbound_receipts (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  site_id    TEXT NOT NULL REFERENCES sites(id),
  trip_id    TEXT REFERENCES trips(id),
  visit_id   TEXT REFERENCES gate_visits(id),
  supplier   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  closed_at  TEXT
);

CREATE TABLE receipt_lines (
  id           TEXT PRIMARY KEY,
  receipt_id   TEXT NOT NULL REFERENCES inbound_receipts(id) ON DELETE CASCADE,
  sku_id       TEXT NOT NULL REFERENCES skus(id),
  expected_qty INTEGER NOT NULL DEFAULT 0,
  received_qty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX receipt_lines_receipt ON receipt_lines (receipt_id);

CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  site_id          TEXT NOT NULL REFERENCES sites(id),
  customer_site_id TEXT NOT NULL REFERENCES sites(id),
  status           TEXT NOT NULL DEFAULT 'open',
  due_at           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  shipment_id      TEXT
);
CREATE INDEX orders_site_status ON orders (site_id, status);

CREATE TABLE order_lines (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id     TEXT NOT NULL REFERENCES skus(id),
  qty        INTEGER NOT NULL,
  picked_qty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX order_lines_order ON order_lines (order_id);

CREATE TABLE shipments (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  site_id          TEXT NOT NULL REFERENCES sites(id),
  trip_id          TEXT REFERENCES trips(id),
  status           TEXT NOT NULL DEFAULT 'planning',
  dock_location_id TEXT REFERENCES locations(id),
  created_at       TEXT NOT NULL,
  departed_at      TEXT
);

CREATE TABLE handling_units (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  kind                TEXT NOT NULL CHECK (kind IN ('pallet', 'parcel', 'tote')),
  site_id             TEXT NOT NULL REFERENCES sites(id),
  sku_id              TEXT NOT NULL REFERENCES skus(id),
  qty                 INTEGER NOT NULL,
  status              TEXT NOT NULL,
  location_id         TEXT REFERENCES locations(id),
  sort_lane_id        TEXT REFERENCES locations(id),
  destination_site_id TEXT REFERENCES sites(id),
  receipt_id          TEXT REFERENCES inbound_receipts(id),
  order_id            TEXT REFERENCES orders(id),
  shipment_id         TEXT REFERENCES shipments(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX hu_site_status ON handling_units (site_id, status);
CREATE INDEX hu_location ON handling_units (location_id, status);
CREATE INDEX hu_order ON handling_units (order_id);

CREATE TABLE sort_rules (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  priority     INTEGER NOT NULL DEFAULT 100,
  match_kind   TEXT NOT NULL CHECK (match_kind IN ('destination', 'sku', 'category', 'zone')),
  match_value  TEXT NOT NULL,
  sort_lane_id TEXT NOT NULL REFERENCES locations(id),
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE putaway_tasks (
  id                    TEXT PRIMARY KEY,
  site_id               TEXT NOT NULL REFERENCES sites(id),
  hu_id                 TEXT NOT NULL REFERENCES handling_units(id),
  from_location_id      TEXT REFERENCES locations(id),
  suggested_location_id TEXT REFERENCES locations(id),
  confirmed_location_id TEXT REFERENCES locations(id),
  status                TEXT NOT NULL DEFAULT 'open',
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  actor                 TEXT
);
CREATE INDEX putaway_site_status ON putaway_tasks (site_id, status);

CREATE TABLE pick_tasks (
  id               TEXT PRIMARY KEY,
  site_id          TEXT NOT NULL REFERENCES sites(id),
  order_id         TEXT NOT NULL REFERENCES orders(id),
  order_line_id    TEXT NOT NULL REFERENCES order_lines(id),
  sku_id           TEXT NOT NULL REFERENCES skus(id),
  from_location_id TEXT NOT NULL REFERENCES locations(id),
  from_hu_id       TEXT NOT NULL REFERENCES handling_units(id),
  qty              INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  to_hu_id         TEXT REFERENCES handling_units(id),
  created_at       TEXT NOT NULL,
  completed_at     TEXT,
  actor            TEXT
);
CREATE INDEX pick_site_status ON pick_tasks (site_id, status);

CREATE TABLE load_records (
  id          TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  hu_id       TEXT NOT NULL REFERENCES handling_units(id),
  loaded_at   TEXT NOT NULL,
  weight_kg   REAL NOT NULL,
  volume_m3   REAL NOT NULL,
  actor       TEXT
);

-- Events and integrations ----------------------------------------------------

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  source      TEXT NOT NULL,
  actor       TEXT,
  site_id     TEXT,
  vehicle_id  TEXT,
  trip_id     TEXT,
  driver_id   TEXT,
  location_id TEXT,
  hu_id       TEXT,
  entity_id   TEXT,
  message     TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX events_site ON events (site_id, id);
CREATE INDEX events_vehicle ON events (vehicle_id, id);
CREATE INDEX events_trip ON events (trip_id, id);
CREATE INDEX events_type ON events (type, occurred_at);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('camera', 'rfid', 'gps')),
  site_id      TEXT REFERENCES sites(id),
  location_id  TEXT REFERENCES locations(id),
  vehicle_id   TEXT REFERENCES vehicles(id),
  api_key_hash TEXT NOT NULL UNIQUE,
  active       INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);
