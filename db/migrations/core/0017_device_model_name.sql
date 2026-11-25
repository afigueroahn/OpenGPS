-- A device remembers the model chosen from its family's list when it was
-- added. NULL = only the family is known, as before.
ALTER TABLE gps.devices ADD COLUMN model_name text;
