-- The address service now starts with OpenStreetMap's public one instead of
-- being off. Until now an empty address was both "never set" and "off", and
-- saving the general settings stored it empty without anyone choosing it:
-- those installations take the new starting value. From here on, an empty
-- address saved in the console means off and stays off.
UPDATE gps.platform_settings
   SET value = value - 'geocoderUrl'
 WHERE section = 'general'
   AND value ->> 'geocoderUrl' = '';
