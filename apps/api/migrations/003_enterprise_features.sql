-- CoreLogistics enterprise enhancements: lot/expiry tracking, e-POD, dock appointments

-- Handling units: Lot, batch and expiration tracking (OpenBoxes / GreaterWMS)
ALTER TABLE handling_units ADD COLUMN lot_number TEXT;
ALTER TABLE handling_units ADD COLUMN expiry_date TEXT;
CREATE INDEX hu_expiry ON handling_units (site_id, sku_id, status, expiry_date);

-- Trips: Electronic Proof of Delivery (e-POD) (Fleetbase / ERPNext)
ALTER TABLE trips ADD COLUMN pod_recipient TEXT;
ALTER TABLE trips ADD COLUMN pod_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE trips ADD COLUMN pod_signature TEXT;
ALTER TABLE trips ADD COLUMN pod_at TEXT;

-- Dock appointment scheduling (OpenWMS)
CREATE TABLE dock_appointments (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  trip_id      TEXT REFERENCES trips(id) ON DELETE SET NULL,
  plate        TEXT NOT NULL,
  carrier      TEXT NOT NULL DEFAULT '',
  purpose      TEXT NOT NULL CHECK (purpose IN ('unload', 'load')),
  location_id  TEXT REFERENCES locations(id) ON DELETE SET NULL,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'checked_in', 'completed', 'cancelled')),
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE INDEX dock_appointments_site_window ON dock_appointments (site_id, status, window_start);
