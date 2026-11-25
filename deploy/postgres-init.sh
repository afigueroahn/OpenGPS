#!/bin/bash
# Creates the device gateway's database the first time Postgres starts. The
# platform's (opengps by default) is created by the image itself, from
# POSTGRES_DB. Both belong to the only user, POSTGRES_USER (postgres by
# default): the platform, the gateway and the backups use it with
# POSTGRES_PASSWORD.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres -c "CREATE DATABASE traccar"
