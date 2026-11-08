-- CoreLogistics Copilot: autonomous disruption tracking and resolution recommendations

CREATE TABLE copilot_recommendations (
  id                  TEXT PRIMARY KEY,
  disruption_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title               TEXT NOT NULL,
  root_cause          TEXT NOT NULL,
  impact_summary      TEXT NOT NULL,
  prescribed_actions  TEXT NOT NULL, -- JSON array of CopilotPrescribedAction
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'auto_applied')),
  site_id             TEXT REFERENCES sites(id) ON DELETE CASCADE,
  trip_id             TEXT REFERENCES trips(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  applied_at          TEXT
);

CREATE INDEX copilot_status ON copilot_recommendations (status, created_at);
CREATE INDEX copilot_site ON copilot_recommendations (site_id, status);

CREATE TABLE copilot_config (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL
);

INSERT OR IGNORE INTO copilot_config (key, value) VALUES ('auto_pilot', '0');
