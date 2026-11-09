-- One confirmation request is stored with the stock change it produced.
-- The same request id and input returns that result. A different input is rejected.

CREATE TABLE stock_confirmations (
  request_id   TEXT PRIMARY KEY,
  task_kind    TEXT NOT NULL CHECK (task_kind IN ('pick', 'putaway')),
  task_id      TEXT NOT NULL,
  input_hash   TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX stock_confirmations_task ON stock_confirmations (task_kind, task_id);
