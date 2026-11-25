# Postgres with TimescaleDB, with the script that creates the device gateway's
# database on its first start built in. Built at deploy time instead of
# mounting the script from the repository: Dokploy clones the code again on
# every deploy, and a mounted file would point at an old copy.
FROM timescale/timescaledb:2.32.1-pg18
COPY deploy/postgres-init.sh /docker-entrypoint-initdb.d/010-traccar.sh
