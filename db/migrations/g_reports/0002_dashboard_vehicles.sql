-- A dashboard could show every vehicle or those of one group; it can now also
-- show vehicles chosen one by one. NULL = it goes by group_id, as before.
ALTER TABLE gps.dashboards ADD COLUMN vehicle_ids uuid[];
