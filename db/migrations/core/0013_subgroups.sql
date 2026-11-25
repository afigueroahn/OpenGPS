-- Groups within groups. A group can hang from another; what applies to a
-- group (a person's permission, an alert, a geofence) also applies
-- to those that hang from it. The tree is built from the fleet module.
ALTER TABLE gps.vehicle_groups ADD COLUMN parent_id uuid REFERENCES gps.vehicle_groups (id) ON DELETE SET NULL;
CREATE INDEX vehicle_groups_parent ON gps.vehicle_groups (parent_id) WHERE parent_id IS NOT NULL;

-- A list of groups, plus all those that hang from them. Null stays
-- null: it means "all groups".
CREATE FUNCTION gps.groups_with_children(scope uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN scope IS NULL THEN NULL ELSE COALESCE((
    WITH RECURSIVE tree AS (
      SELECT id FROM gps.vehicle_groups WHERE id = ANY(scope)
      UNION
      SELECT g.id FROM gps.vehicle_groups g JOIN tree t ON g.parent_id = t.id
    )
    SELECT array_agg(id) FROM tree
  ), '{}'::uuid[]) END
$$;
