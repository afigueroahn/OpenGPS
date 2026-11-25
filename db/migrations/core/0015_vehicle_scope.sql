-- Options by single vehicle. A member's access and a geofence could only be
-- narrowed to groups; both can now also name vehicles one by one.

-- vehicle_scope: vehicles the person sees besides those of their groups. It
-- only counts when group_scope is not NULL (NULL = they see everything).
ALTER TABLE gps.member_access ADD COLUMN vehicle_scope uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE gps.invitation_access ADD COLUMN vehicle_scope uuid[] NOT NULL DEFAULT '{}';

-- vehicle_ids: the geofence applies only to these vehicles. NULL = it goes by
-- group_ids, as before.
ALTER TABLE gps.geofences ADD COLUMN vehicle_ids uuid[];
