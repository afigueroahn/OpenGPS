-- The person's photo, shown in their own corner of the panel and the map.
-- It is small (the web app sends it already cut to a square): it lives in the
-- database, so backups carry it and it leaves with the person.
CREATE TABLE gps.user_photos (
  user_id    text PRIMARY KEY REFERENCES auth."user" (id) ON DELETE CASCADE,
  mime       text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data       bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- When the person last used the platform and how they last signed in
-- ('email' or the service: google, github, facebook, apple, custom), for the
-- platform's console.
ALTER TABLE gps.user_settings
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN sign_in_method text;

-- Those who already exist start with what is known of them: the last time one
-- of their open sessions was renewed, and the first way they had to come in.
INSERT INTO gps.user_settings (user_id, last_seen_at, sign_in_method)
SELECT u.id,
       (SELECT max(COALESCE(s."updatedAt", s."createdAt")) FROM auth.session s WHERE s."userId" = u.id),
       (SELECT CASE a."providerId" WHEN 'credential' THEN 'email' ELSE a."providerId" END
          FROM auth.account a WHERE a."userId" = u.id ORDER BY a."createdAt", a.id LIMIT 1)
  FROM auth."user" u
ON CONFLICT (user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, sign_in_method = EXCLUDED.sign_in_method;
