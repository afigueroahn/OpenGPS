-- A backup may also be the one the platform makes by itself before installing
-- a new version from the console (ADR-0004): with it the update can be
-- undone. Like the one made before restoring, it is not deleted automatically.
ALTER TABLE gps.backups DROP CONSTRAINT backups_kind_check;
ALTER TABLE gps.backups ADD CONSTRAINT backups_kind_check CHECK (kind IN ('scheduled', 'manual', 'imported', 'pre_restore', 'pre_update'));
