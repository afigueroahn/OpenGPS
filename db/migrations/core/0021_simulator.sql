-- Device simulator of the admin console: simulated GPS devices that connect
-- to the gateway like real ones, to test the platform without hardware. They
-- belong to the platform, not to an account: only its owner runs them.

-- A route simulated vehicles travel.
CREATE TABLE gps.sim_routes (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- The points the person marked to build it: [{ lon, lat, label }].
  waypoints   jsonb NOT NULL DEFAULT '[]',
  -- Traced along streets by the routing service; otherwise, straight lines.
  snapped     boolean NOT NULL DEFAULT false,
  -- Points [lon, lat] of the path.
  line        jsonb NOT NULL,
  -- Driving seconds accumulated up to each point, from the routing service;
  -- NULL = the vehicle goes at its cruising speed.
  secs        jsonb,
  length_m    integer NOT NULL CHECK (length_m > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);

-- One or several simulated devices of a brand traveling a route.
CREATE TABLE gps.simulations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- The device family: it sets the protocol and the port.
  model_id     text NOT NULL REFERENCES gps.device_models (id),
  -- The identifiers the devices introduce themselves with. Each one has to be
  -- added to the platform by hand, like a real GPS.
  identifiers  text[] NOT NULL CHECK (cardinality(identifiers) BETWEEN 1 AND 5000),
  -- Where they connect: the gateway from inside, the address real devices
  -- use, or another server and port.
  target       text NOT NULL DEFAULT 'internal' CHECK (target IN ('internal', 'public', 'custom')),
  host         text,
  port         integer CHECK (port BETWEEN 1 AND 65535),
  CHECK (target <> 'custom' OR (host IS NOT NULL AND port IS NOT NULL)),
  -- Seconds between two reports.
  interval_s   integer NOT NULL DEFAULT 5 CHECK (interval_s BETWEEN 1 AND 3600),
  route_id     uuid NOT NULL REFERENCES gps.sim_routes (id) ON DELETE RESTRICT,
  -- How the vehicle travels the route: speed, what it does at the end, events.
  scenario     jsonb NOT NULL DEFAULT '{}',
  -- Several devices: spread evenly along the route, or one after another.
  spread       text NOT NULL DEFAULT 'even' CHECK (spread IN ('even', 'convoy')),
  gap_s        integer NOT NULL DEFAULT 30 CHECK (gap_s BETWEEN 0 AND 3600),
  -- Whether it should be running: what was running resumes when the server restarts.
  desired      text NOT NULL DEFAULT 'stopped' CHECK (desired IN ('running', 'stopped')),
  -- Seconds of trip traveled, to resume where it was.
  trip_s       double precision NOT NULL DEFAULT 0,
  -- What each device keeps between restarts, by identifier: the engine cut it
  -- was ordered, the report rate it was given.
  state        jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text
);
CREATE INDEX simulations_running ON gps.simulations (desired) WHERE desired = 'running';
CREATE INDEX simulations_route ON gps.simulations (route_id);

-- Example circuits to start with: a loop through a city, drawn by hand.
INSERT INTO gps.sim_routes (name, line, length_m) VALUES
  ('Lima', '[[-77.0428,-12.0464],[-77.0365,-12.0553],[-77.0346,-12.0692],[-77.0339,-12.0841],[-77.0365,-12.0977],[-77.0295,-12.1108],[-77.0301,-12.1211],[-77.0438,-12.1197],[-77.0502,-12.1012],[-77.0497,-12.0838],[-77.0471,-12.0651],[-77.0428,-12.0464]]', 18585),
  ('Bogotá', '[[-74.0758,4.5981],[-74.0705,4.6126],[-74.0649,4.6282],[-74.0628,4.6486],[-74.0571,4.6672],[-74.0483,4.6764],[-74.0502,4.6601],[-74.0667,4.6388],[-74.0789,4.6165],[-74.0758,4.5981]]', 19130),
  ('Ciudad de México', '[[-99.1332,19.4326],[-99.1677,19.4269],[-99.1811,19.4204],[-99.1716,19.4116],[-99.1552,19.4031],[-99.1382,19.4094],[-99.1299,19.4212],[-99.1332,19.4326]]', 13416),
  ('Tegucigalpa', '[[-87.2047,14.1058],[-87.2045,14.0975],[-87.201,14.0838],[-87.211,14.0705],[-87.2172,14.0608],[-87.189,14.069],[-87.182,14.084],[-87.162,14.085],[-87.188,14.1006],[-87.2047,14.1058]]', 17947),
  ('San Salvador', '[[-89.1914,13.6989],[-89.2046,13.7013],[-89.2243,13.7034],[-89.2365,13.6929],[-89.2362,13.6806],[-89.2168,13.6772],[-89.1984,13.6868],[-89.1914,13.6989]]', 12650);
