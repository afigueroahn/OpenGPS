-- A simulated device has just a server and a port, written by hand as on a
-- real GPS: the choice between the gateway from inside, the public address
-- and another server is gone. One saved before this, without a server of its
-- own, goes to the address real devices are given, and to its brand's port.
ALTER TABLE gps.simulations DROP COLUMN target;
