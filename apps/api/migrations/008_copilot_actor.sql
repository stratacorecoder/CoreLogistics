-- Who closed a recommendation. Null means the row was closed by the system, or it is still open.
ALTER TABLE copilot_recommendations ADD COLUMN actor TEXT;
