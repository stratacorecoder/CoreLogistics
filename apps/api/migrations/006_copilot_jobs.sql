-- Durable copilot job queue, event cursor, and recommendation history.
-- `resolved` cannot be added to the status CHECK with ALTER, so the table is rebuilt.
-- The preserve check fails the migration when a rebuilt row is missing.

CREATE TABLE copilot_recommendations_v2 (
  id                  TEXT PRIMARY KEY,
  disruption_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title               TEXT NOT NULL,
  root_cause          TEXT NOT NULL,
  impact_summary      TEXT NOT NULL,
  prescribed_actions  TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'auto_applied', 'resolved')),
  lifecycle           TEXT NOT NULL DEFAULT 'actionable' CHECK (lifecycle IN ('actionable', 'human_review', 'applied', 'auto_applied', 'dismissed', 'superseded', 'resolved')),
  resolution          TEXT,
  execution_error     TEXT,
  site_id             TEXT REFERENCES sites(id) ON DELETE CASCADE,
  trip_id             TEXT REFERENCES trips(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  applied_at          TEXT,
  revision            INTEGER NOT NULL DEFAULT 1,
  preconditions       TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO copilot_recommendations_v2 (
  id, disruption_event_id, severity, title, root_cause, impact_summary, prescribed_actions,
  status, lifecycle, resolution, execution_error, site_id, trip_id, created_at, applied_at, revision, preconditions
)
SELECT
  id, disruption_event_id, severity, title, root_cause, impact_summary, prescribed_actions,
  status,
  CASE status
    WHEN 'applied' THEN 'applied'
    WHEN 'auto_applied' THEN 'auto_applied'
    WHEN 'dismissed' THEN 'dismissed'
    ELSE 'actionable'
  END,
  NULL,
  NULL,
  site_id, trip_id, created_at, applied_at, revision, preconditions
FROM copilot_recommendations;

CREATE TABLE copilot_recommendations_preserve_check (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  old_n INTEGER NOT NULL,
  new_n INTEGER NOT NULL,
  matched_n INTEGER NOT NULL,
  CHECK (old_n = new_n AND old_n = matched_n)
);

INSERT INTO copilot_recommendations_preserve_check (id, old_n, new_n, matched_n)
SELECT
  1,
  (SELECT COUNT(*) FROM copilot_recommendations),
  (SELECT COUNT(*) FROM copilot_recommendations_v2),
  (
    SELECT COUNT(*)
    FROM copilot_recommendations o
    JOIN copilot_recommendations_v2 n ON n.id = o.id
    WHERE o.disruption_event_id IS n.disruption_event_id
      AND o.severity = n.severity
      AND o.title = n.title
      AND o.root_cause = n.root_cause
      AND o.impact_summary = n.impact_summary
      AND o.prescribed_actions = n.prescribed_actions
      AND o.status = n.status
      AND o.site_id IS n.site_id
      AND o.trip_id IS n.trip_id
      AND o.created_at = n.created_at
      AND o.applied_at IS n.applied_at
      AND o.revision = n.revision
      AND o.preconditions = n.preconditions
  );

DROP TABLE copilot_recommendations;
ALTER TABLE copilot_recommendations_v2 RENAME TO copilot_recommendations;
DROP TABLE copilot_recommendations_preserve_check;

CREATE INDEX copilot_status ON copilot_recommendations (status, created_at);
CREATE INDEX copilot_site ON copilot_recommendations (site_id, status);

CREATE TABLE copilot_recommendation_revisions (
  recommendation_id   TEXT NOT NULL REFERENCES copilot_recommendations(id) ON DELETE CASCADE,
  revision            INTEGER NOT NULL,
  disruption_event_id INTEGER,
  severity            TEXT NOT NULL,
  lifecycle           TEXT NOT NULL,
  root_cause          TEXT NOT NULL,
  impact_summary      TEXT NOT NULL,
  prescribed_actions  TEXT NOT NULL,
  preconditions       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (recommendation_id, revision)
);

CREATE TABLE copilot_recommendation_events (
  recommendation_id TEXT NOT NULL REFERENCES copilot_recommendations(id) ON DELETE CASCADE,
  event_id          INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (recommendation_id, event_id)
);

CREATE TABLE copilot_jobs (
  id                TEXT PRIMARY KEY,
  event_id          INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'retry', 'failed', 'done')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,
  processing_error  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX copilot_jobs_due ON copilot_jobs (status, next_attempt_at);

CREATE TABLE copilot_cursor (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  event_id        INTEGER NOT NULL,
  initialized_at  TEXT NOT NULL,
  heartbeat_at    TEXT,
  sweep_at        TEXT
);
