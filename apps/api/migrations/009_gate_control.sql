-- Gate control upgrades: check-in/out proof photos and security inspection hold/pass status

ALTER TABLE gate_visits ADD COLUMN proof_photo_in TEXT;
ALTER TABLE gate_visits ADD COLUMN proof_photo_out TEXT;
ALTER TABLE gate_visits ADD COLUMN inspection_status TEXT NOT NULL DEFAULT 'passed';
