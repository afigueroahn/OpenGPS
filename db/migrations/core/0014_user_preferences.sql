-- What each person prefers in the web app and the mobile apps: color mode
-- and language. NULL = follow the device (mode) or the platform's default
-- (language).
ALTER TABLE gps.user_settings
  ADD COLUMN theme text CHECK (theme IN ('light', 'dark')),
  ADD COLUMN language text CHECK (language ~ '^[a-z]{2}$');
