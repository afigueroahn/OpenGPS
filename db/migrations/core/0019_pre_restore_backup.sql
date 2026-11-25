-- A backup may be the one the platform makes by itself before restoring
-- another: with it the restore can be undone. Like on-demand backups, it is
-- not deleted automatically.
ALTER TABLE gps.backups DROP CONSTRAINT backups_kind_check;
ALTER TABLE gps.backups ADD CONSTRAINT backups_kind_check CHECK (kind IN ('scheduled', 'manual', 'imported', 'pre_restore'));
