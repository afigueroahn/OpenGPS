#!/usr/bin/env bash
# Installing a version from the console, end to end, with Docker (ADR-0004),
# for one way of installing (ADR-0005).
#
#   .github/scripts/update-e2e.sh [WAY] [INSTALL_DIR]
#
# WAY is a folder of deploy/ that the helper can update: docker-compose by
# default, caddy or cloudflare.
#
# Builds four versions of the images, 0.0.1, 0.0.2, a 0.0.3 whose platform
# cannot start, and a 0.0.4 that cannot start either and leaves the database
# so that 0.0.2 cannot start. Installs 0.0.1 as a server would, from that
# way's compose file in that version and generate-env.sh, then asks the helper
# for 0.0.2, which it must install keeping the way; for 0.0.3, which it must
# undo; and for 0.0.4, which it must undo by restoring the backup made before.
# With docker-compose it then restores backups as the console asks for them,
# which the platform does by itself (ADR-0009): one that cannot be read
# changes nothing, one the platform cannot start on is undone, and a good one
# brings back both databases and the files, restarting Traccar.
#
# INSTALL_DIR is the installation's folder, /opt/opengps by default: the one
# deploy/README.md uses, which is also where the helper image carries its
# compose files, and the helper must not mix them up. It must be writable; with
# Docker Desktop, pass a folder it shares.
#
# Run from the repository. KEEP=1 leaves the installation and the images.
set -euo pipefail

REG=ghcr.io/afigueroahn
WAY="${1:-docker-compose}"
PROJECT="opengps-e2e-$WAY"
INSTALL="${2:-/opt/opengps}"

say() { echo "== $*"; }
fail() {
  echo "FAILED: $*" >&2
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Image}} {{.Status}}' >&2 || true
  docker logs "$(service helper)" 2>&1 | tail -40 >&2 || true
  exit 1
}
service() { docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -1; }
cleanup() {
  if [ "${KEEP:-}" != 1 ]; then
    (cd "$INSTALL" 2> /dev/null && docker compose down -v --remove-orphans > /dev/null 2>&1) || true
    docker rm -f "$PROJECT-updater" > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# The images of a version, built from this code.
build() { # version
  docker build -q --build-arg "APP_VERSION=$1" -t "$REG/opengps:$1" -f deploy/opengps.Dockerfile . > /dev/null
  docker build -q -t "$REG/opengps-postgres:$1" -f deploy/postgres.Dockerfile . > /dev/null
  docker build -q --build-arg "APP_VERSION=$1" -t "$REG/opengps-helper:$1" -f deploy/helper.Dockerfile . > /dev/null
}
# A setting of the installation, replaced or added.
setting() { # KEY=value
  local key="${1%%=*}"
  grep -v "^$key=" "$INSTALL/.env" > "$INSTALL/.env.tmp" || true
  echo "$1" >> "$INSTALL/.env.tmp"
  mv "$INSTALL/.env.tmp" "$INSTALL/.env"
}
# Until the platform answers with this version.
answers() { # version, seconds
  local i
  for ((i = 0; i < $2; i += 5)); do
    if docker exec "$(service opengps)" wget -qO- http://127.0.0.1:3000/api/health 2> /dev/null | grep -q "\"version\":\"$1\""; then return 0; fi
    sleep 5
  done
  return 1
}
uuid() { cat /proc/sys/kernel/random/uuid 2> /dev/null || uuidgen | tr '[:upper:]' '[:lower:]'; }
# Asks the helper for a version and waits for how it ended.
update() { # version [the request's lines about the backup made before]
  local id result i
  id="$(uuid)"
  docker exec "$(service helper)" sh -c "printf 'id=%s\nversion=%s\nrequested=%s\n%s\n' '$id' '$1' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" '${2:-}' > /data/backups/update.request"
  for ((i = 0; i < 900; i += 5)); do
    sleep 5
    result="$(docker exec "$(service helper)" cat /data/backups/update.result 2> /dev/null || true)"
    if grep -q "^id=$id$" <<< "$result"; then
      echo "$result"
      return 0
    fi
  done
  fail "no result for the update to $1"
}
# A backup of everything, with the same programs and names as the platform's,
# and the lines that tell an update about it, as the console writes them.
backup() { # stamp
  docker exec "$(service opengps)" sh -c "pg_dump --format=custom --file=/data/backups/gps_$1.dump \"\$DATABASE_URL\" &&
    pg_dump --format=custom --file=/data/backups/traccar_$1.dump \"\$TRACCAR_DATABASE_URL\" &&
    tar -czf /data/backups/files_$1.tar.gz -C /data/files ." || fail "could not make the backup"
  printf 'backup=%s\ngps=gps_%s.dump\ntraccar=traccar_%s.dump\nfiles=files_%s.tar.gz\n' "$(uuid)" "$1" "$1" "$1"
}
sql() { # database, statement
  docker exec "$(service postgres)" psql -U postgres -d "$1" -tAc "$2"
}
# What 0.0.4 leaves in the database: migrations 0.0.2 no longer recognizes.
broken_migrations() { sql opengps "SELECT count(*) FROM gps.schema_migrations WHERE checksum = 'broken'"; }
started() { docker inspect -f '{{.State.StartedAt}}' "$(service "$1")"; }
# Leaves a restore request, as the console does, and waits for how it ended.
restore() { # the backup's stamp
  local id result i
  id="$(uuid)"
  docker exec "$(service helper)" sh -c "cd /data/backups && printf 'id=%s\nbackup=\nrequested=%s\ngps=gps_%s.dump\ntraccar=traccar_%s.dump\nfiles=files_%s.tar.gz\n' '$id' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" '$1' '$1' '$1' > restore.tmp &&
    chown 1000:1000 restore.tmp && chmod 600 restore.tmp && mv restore.tmp restore.request"
  for ((i = 0; i < 600; i += 5)); do
    sleep 5
    result="$(docker exec "$(service helper)" cat /data/backups/restore.result 2> /dev/null || true)"
    if grep -q "^id=$id$" <<< "$result"; then
      echo "$result"
      return 0
    fi
  done
  fail "no result for the restore of $1"
}
# Which state the platform's database, Traccar's and the files are in.
state() {
  echo "$(sql opengps 'SELECT v FROM e2e_state') $(sql traccar 'SELECT v FROM e2e_state') $(docker exec "$(service opengps)" cat /data/files/e2e-state)"
}
# The way of installing the installation has now.
way_installed() { sed -n 's/^x-opengps-deploy:[[:space:]]*//p' "$INSTALL/docker-compose.yml"; }
# The installation runs this version: its compose file says it, and its .env no longer does (ADR-0008).
installed() { # version
  grep -q "image: $REG/opengps:$1$" "$INSTALL/docker-compose.yml" && ! grep -q '^OPENGPS_VERSION=' "$INSTALL/.env"
}
# With deploy/caddy, the web app answers through the proxy, on the server's
# port 80, by the name of PUBLIC_URL and by api. under it.
through_proxy() { # version
  local name
  if [ "$WAY" != caddy ]; then return 0; fi
  for name in localhost api.localhost; do
    if ! curl -fsS --retry 10 --retry-delay 3 --retry-all-errors -H "Host: $name" http://localhost/api/health | grep -q "\"version\":\"$1\""; then
      fail "the web app does not answer $1 through Caddy as $name"
    fi
  done
}

mkdir -p "$INSTALL"
[ -f "deploy/$WAY/docker-compose.yml" ] || fail "deploy/$WAY has no compose file"
say "building the images of 0.0.1, 0.0.2 and a broken 0.0.3 and 0.0.4"
build 0.0.1
build 0.0.2
printf 'FROM %s/opengps:0.0.2\nCMD ["sh", "-c", "echo this version cannot start; exit 1"]\n' "$REG" | docker build -q -t "$REG/opengps:0.0.3" - > /dev/null
# 0.0.4 changes the record of the migrations before failing: 0.0.2 refuses to start on that database.
docker build -q -t "$REG/opengps:0.0.4" - > /dev/null << EOF
FROM $REG/opengps:0.0.2
CMD ["sh", "-c", "psql \"\$DATABASE_URL\" -qc \"UPDATE gps.schema_migrations SET checksum = 'broken'\"; echo this version breaks the database; exit 1"]
EOF
for broken in 0.0.3 0.0.4; do
  docker tag "$REG/opengps-postgres:0.0.2" "$REG/opengps-postgres:$broken"
  docker build -q --build-arg "APP_VERSION=$broken" -t "$REG/opengps-helper:$broken" -f deploy/helper.Dockerfile . > /dev/null
done
say "installing 0.0.1 in $INSTALL, as deploy/$WAY"
# Its compose file in 0.0.1, as the helper of that version carries it.
docker run --rm "$REG/opengps-helper:0.0.1" cat "/opt/opengps/$WAY/docker-compose.yml" > "$INSTALL/docker-compose.yml"
cp deploy/generate-env.sh deploy/.env.example "$INSTALL/"
(cd "$INSTALL" && sh generate-env.sh http://localhost .env > /dev/null)
setting "COMPOSE_PROJECT_NAME=$PROJECT"
# Away from the port another installation on this machine may use.
setting "WEB_PORT=13000"
# Not a real tunnel: its service stays trying, and the platform does not depend on it.
if [ "$WAY" = cloudflare ]; then setting "CLOUDFLARE_TUNNEL_TOKEN=not-a-real-token"; fi
(cd "$INSTALL" && docker compose up -d --quiet-pull > /dev/null)
answers 0.0.1 300 || fail "0.0.1 did not start"
through_proxy 0.0.1
grep -q '^update=yes$' <(docker exec "$(service helper)" cat /data/backups/helper.alive) || fail "the helper does not offer updates"

say "asking for 0.0.2"
result="$(update 0.0.2)"
echo "$result"
grep -q '^status=ok$' <<< "$result" || fail "the update to 0.0.2 did not end well"
answers 0.0.2 30 || fail "the platform does not answer 0.0.2"
installed 0.0.2 || fail "the installation's files do not say 0.0.2"
[ "$(docker inspect -f '{{.Config.Image}}' "$(service helper)")" = "$REG/opengps-helper:0.0.2" ] || fail "the helper was not replaced"
[ "$(way_installed)" = "$WAY" ] || fail "the installation is no longer deploy/$WAY: $(way_installed)"
through_proxy 0.0.2

say "asking for 0.0.3, which cannot start"
result="$(update 0.0.3)"
echo "$result"
if ! { grep -q '^status=failed$' <<< "$result" && grep -q '^reason=rolled_back$' <<< "$result"; }; then fail "0.0.3 was not undone"; fi
answers 0.0.2 30 || fail "the platform is not back on 0.0.2"
installed 0.0.2 || fail "the installation's files are not back on 0.0.2"
[ "$(way_installed)" = "$WAY" ] || fail "going back changed the way of installing: $(way_installed)"

say "asking for 0.0.4, which leaves 0.0.2 unable to start: the backup made before is restored"
result="$(update 0.0.4 "$(backup 20260101_000000)")"
echo "$result"
if ! { grep -q '^status=failed$' <<< "$result" && grep -q '^reason=restored$' <<< "$result"; }; then fail "0.0.4 was not undone with the backup"; fi
grep -q '^status=ok$' <(docker exec "$(service helper)" cat /data/backups/restore.result) || fail "the restore did not end well"
answers 0.0.2 30 || fail "the platform is not back on 0.0.2"
installed 0.0.2 || fail "the installation's files are not back on 0.0.2"
[ "$(broken_migrations)" = 0 ] || fail "the database is not the one of the backup"

say "updates work for deploy/$WAY: 0.0.1 → 0.0.2 installed, 0.0.3 undone, 0.0.4 undone with the backup"
[ "$WAY" = docker-compose ] || exit 0

say "making the backups to restore"
for db in opengps traccar; do sql "$db" "CREATE TABLE e2e_state (v text); INSERT INTO e2e_state VALUES ('backup')" > /dev/null; done
docker exec "$(service opengps)" sh -c 'echo backup > /data/files/e2e-state'
backup 20260102_000000 > /dev/null
# One on whose database the platform cannot start: migrations it does not recognize.
sql opengps "UPDATE gps.schema_migrations SET checksum = 'x' || checksum" > /dev/null
backup 20260103_000000 > /dev/null
sql opengps "UPDATE gps.schema_migrations SET checksum = substr(checksum, 2)" > /dev/null
# And one that cannot be read.
docker exec "$(service opengps)" sh -c 'cd /data/backups && echo not a dump > gps_20260104_000000.dump && echo not a dump > traccar_20260104_000000.dump && cp files_20260102_000000.tar.gz files_20260104_000000.tar.gz'
# What changes afterwards.
for db in opengps traccar; do sql "$db" "UPDATE e2e_state SET v = 'after'" > /dev/null; done
docker exec "$(service opengps)" sh -c 'echo after > /data/files/e2e-state'
[ "$(state)" = "after after after" ] || fail "the state to restore over is not ready: $(state)"

say "restoring one that cannot be read: nothing changes, nothing stops"
was="$(started opengps)"
result="$(restore 20260104_000000)"
echo "$result"
grep -q '^reason=unreadable$' <<< "$result" || fail "an unreadable backup was not refused"
[ "$(state)" = "after after after" ] || fail "an unreadable backup changed something: $(state)"
[ "$(started opengps)" = "$was" ] || fail "an unreadable backup restarted the platform"

say "restoring one the platform cannot start on: it goes back to what there was"
result="$(restore 20260103_000000)"
echo "$result"
grep -q '^reason=start$' <<< "$result" || fail "a backup the platform cannot start on was not undone"
answers 0.0.2 180 || fail "the platform did not come back after undoing the restore"
[ "$(state)" = "after after after" ] || fail "undoing the restore did not leave what there was: $(state)"

say "restoring the good one: both databases and the files come back, and Traccar restarts"
was="$(started traccar)"
result="$(restore 20260102_000000)"
echo "$result"
grep -q '^status=ok$' <<< "$result" || fail "the backup was not restored"
answers 0.0.2 60 || fail "the platform does not answer after the restore"
[ "$(state)" = "backup backup backup" ] || fail "what came back is not the backup: $(state)"
[ "$(started traccar)" != "$was" ] || fail "Traccar was not restarted"
[ "$(sql postgres "SELECT count(*) FROM pg_database WHERE datname LIKE '%\_previous' OR datname LIKE '%\_new' OR datname LIKE '%\_failed'")" = 0 ] || fail "the restore left databases behind"

say "restores work: the platform restores by itself, without the helper"
