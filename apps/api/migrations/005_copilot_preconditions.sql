-- Recommendation revision and the preconditions that were true when it was issued.
-- Apply and dismiss must present the revision the operator reviewed.

ALTER TABLE copilot_recommendations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE copilot_recommendations ADD COLUMN preconditions TEXT NOT NULL DEFAULT '{}';
