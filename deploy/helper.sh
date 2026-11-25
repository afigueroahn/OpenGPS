#!/usr/bin/env bash
# The platform's helper, the only service with access to Docker. It restores
# a backup, or installs a new version, when the platform's admin console asks.
#
# The platform cannot restore by itself: it would have to drop the database it
# lives on and stop the device gateway. It leaves the request in the backups
# folder, and this helper, the only service with access to Docker, carries it
# out. It first restores the databases and the files aside and checks them,
# without stopping anything. Only then does it stop the platform and the
# gateway, swap the databases and the files, and bring them back up. If the
# platform does not start, it goes back to what there was.
#
# Files they talk through, in the backups folder, as "key=value" lines:
#   helper.alive           rewritten every 30 s: the console shows the buttons.
#                          update=yes when this helper can install versions
#   restore.request        written by the platform: which backup to restore
#   restore.running        the same request, while it is handled
#   restore.result         written here: how it ended (reason: a code the
#                          platform turns into words)
#   update.request         written by the platform: which version to install,
#                          and the backup made just before
#   update.running         the same request, while it is handled
#   update.result          written here: how it ended
#
# Installing a version (ADR-0004). A container cannot replace itself: this
# helper prepares the new version (its images and its compose file, which
# comes inside the new helper image) and hands over to a container of the new
# helper, outside the Compose project ("helper.sh apply"). That one swaps the
# compose file and OPENGPS_VERSION in .env, brings everything up (this helper
# too, replaced), waits for the platform to answer with the new version, and
# otherwise goes back to the previous files, and to the backup if even that
# does not start. Only with Docker Compose: the folder with docker-compose.yml
# and .env is mounted at /data/install. Dokploy and Coolify do not mount it.
#
# There are several ways of installing with Docker Compose (deploy/<way>), each
# with its own compose file, marked "x-opengps-deploy: <way>". The helper image
# carries the file of each way, in /opt/opengps/<way>/, and an update keeps the
# way the installation has.
set -uo pipefail

DIR=/data/backups
FILES=/data/files
PGUSER="${POSTGRES_USER:-postgres}"
MAIN="${POSTGRES_DB:-opengps}"
GATEWAY=traccar
WAIT_S=300

REQUEST="$DIR/restore.request"
RUNNING="$DIR/restore.running"
RESULT="$DIR/restore.result"
ALIVE="$DIR/helper.alive"
UPDATE_REQUEST="$DIR/update.request"
UPDATE_RUNNING="$DIR/update.running"
UPDATE_RESULT="$DIR/update.result"
INSTALL=/data/install
# How long a new version has to answer before going back to the previous one.
UPDATE_WAIT_S="${UPDATE_WAIT_S:-300}"
# The backup's files are unpacked here first; what there was waits here until the end.
FILES_NEW="$FILES/.restore-new"
FILES_OLD="$FILES/.restore-previous"
# The platform runs as user 1000: it reads what this helper writes.
OWNER=1000:1000

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(now) $*"; }

if ! [[ "$PGUSER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$MAIN" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  log "POSTGRES_USER and POSTGRES_DB may hold only letters, numbers and _"
  exit 1
fi

# This helper's Compose project: the other services are found by its labels.
# The container that applies an update is outside the project: it is told.
PROJECT="${HELPER_PROJECT:-$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$HOSTNAME" 2>/dev/null || true)}"
if [ -z "$PROJECT" ]; then
  log "cannot tell which Compose project this helper belongs to: is the Docker socket mounted?"
  exit 1
fi
container() { docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -1; }

# ─── Databases ───────────────────────────────────────────────────────────────

psql_db() { # database, psql arguments...
  local db="$1"
  shift
  docker exec "$(container postgres)" psql -U "$PGUSER" -d "$db" -v ON_ERROR_STOP=1 -qAt "$@"
}
exists_db() { [ "$(psql_db postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$1'")" = "1" ]; }

# Restores a file into a new database. TimescaleDB needs to be told before and after.
restore_into() { # file, database
  local file="$1" db="$2"
  psql_db postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\"" >/dev/null &&
    psql_db "$db" -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()" >/dev/null &&
    docker exec -i "$(container postgres)" pg_restore -U "$PGUSER" -d "$db" --no-owner --no-privileges --exit-on-error < "$file" &&
    psql_db "$db" -c "SELECT timescaledb_post_restore()" >/dev/null
}

counts() { # platform database, gateway database
  echo "users=$(psql_db "$1" -c 'SELECT count(*) FROM auth."user"')" \
    "vehicles=$(psql_db "$1" -c 'SELECT count(*) FROM gps.vehicles')" \
    "devices=$(psql_db "$2" -c 'SELECT count(*) FROM tc_devices')"
}
history_ok() { [ "$(psql_db "$1" -c "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = 'positions'")" = "1" ]; }

# Renames a database. Nobody may be connected: connections are closed and
# whoever is left is cut off. TimescaleDB stops its own jobs on a rename, but
# one that starts at that very instant keeps the database busy for a few
# seconds: that is why it retries, then cutting off the jobs too.
rename_db() { # from, to, open (yes|no)
  local from="$1" to="$2" open="$3" try renamed=no err="" who="AND backend_type = 'client backend'"
  psql_db postgres -c "ALTER DATABASE \"$from\" WITH ALLOW_CONNECTIONS false" >/dev/null || return 1
  for try in 1 2 3 4 5 6; do
    psql_db postgres -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$from' AND pid <> pg_backend_pid() $who" >/dev/null || return 1
    if err="$(psql_db postgres -c "ALTER DATABASE \"$from\" RENAME TO \"$to\"" 2>&1 >/dev/null)"; then
      renamed=yes
      break
    fi
    log "database $from is still busy: retry $try"
    who=""
    sleep 2
  done
  [ "$renamed" = yes ] || { log "$err"; return 1; }
  if [ "$open" = yes ]; then psql_db postgres -c "ALTER DATABASE \"$to\" WITH ALLOW_CONNECTIONS true" >/dev/null || return 1; fi
}

drop_db() { psql_db postgres -c "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)" >/dev/null || true; }

# The restored databases in place of the ones in use, which are set aside with "_previous".
swap_in() {
  rename_db "$MAIN" "${MAIN}_previous" no && rename_db "$GATEWAY" "${GATEWAY}_previous" no &&
    rename_db "${MAIN}_new" "$MAIN" yes && rename_db "${GATEWAY}_new" "$GATEWAY" yes
}

# Leaves the databases in use as they were before the swap, wherever it stopped.
revert_dbs() {
  local db
  for db in "$MAIN" "$GATEWAY"; do
    if exists_db "${db}_previous"; then
      if exists_db "$db"; then rename_db "$db" "${db}_failed" no || true; fi
      rename_db "${db}_previous" "$db" yes || true
    fi
    # A rename that never happened leaves the database closed: it is opened.
    if exists_db "$db"; then psql_db postgres -c "ALTER DATABASE \"$db\" WITH ALLOW_CONNECTIONS true" >/dev/null || true; fi
  done
  for db in "${MAIN}_failed" "${GATEWAY}_failed" "${MAIN}_new" "${GATEWAY}_new"; do drop_db "$db"; done
}

# ─── Users' files ────────────────────────────────────────────────────────────

stage_files() { # archive
  rm -rf "$FILES_NEW" && mkdir -p "$FILES_NEW" && tar -xzf "$1" -C "$FILES_NEW"
}
# What is in the folder goes aside and the backup's takes its place.
swap_files() {
  [ -d "$FILES_NEW" ] || return 0
  rm -rf "$FILES_OLD" && mkdir -p "$FILES_OLD" || return 1
  find "$FILES" -mindepth 1 -maxdepth 1 ! -name .restore-new ! -name .restore-previous -exec mv {} "$FILES_OLD"/ \; &&
    find "$FILES_NEW" -mindepth 1 -maxdepth 1 -exec mv {} "$FILES"/ \; &&
    rmdir "$FILES_NEW" && chown -R "$OWNER" "$FILES"
}
revert_files() {
  if [ -d "$FILES_OLD" ]; then
    find "$FILES" -mindepth 1 -maxdepth 1 ! -name .restore-new ! -name .restore-previous -exec rm -rf {} +
    find "$FILES_OLD" -mindepth 1 -maxdepth 1 -exec mv {} "$FILES"/ \;
    rmdir "$FILES_OLD"
  fi
  rm -rf "$FILES_NEW"
}

# ─── The platform ────────────────────────────────────────────────────────────

healthy() { [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null)" = healthy ]; }
stop_platform() { docker stop "$(container opengps)" "$(container traccar)" >/dev/null; }
# Starts the gateway and the platform and waits until both answer.
start_platform() {
  local gateway platform waited
  gateway="$(container traccar)"
  platform="$(container opengps)"
  docker start "$gateway" "$platform" >/dev/null || return 1
  for ((waited = 0; waited < WAIT_S; waited += 5)); do
    if healthy "$gateway" && healthy "$platform"; then return 0; fi
    sleep 5
  done
  return 1
}

# ─── The request ─────────────────────────────────────────────────────────────

field() { grep -m1 "^$1=" "$RUNNING" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true; }
report() { # status (ok|failed), reason code
  local tmp="$RESULT.tmp"
  printf 'id=%s\nbackup=%s\nrequested=%s\nstarted=%s\nfinished=%s\nstatus=%s\nreason=%s\n' \
    "$(field id)" "$(field backup)" "$(field requested)" "${started:-$(now)}" "$(now)" "$1" "$2" > "$tmp"
  chown "$OWNER" "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$RESULT"
  rm -f "$RUNNING"
  log "restore ended: $1 $2"
}

# Replaces what is in use with a backup. Says why it could not, as a code, in REASON.
replace() { # platform dump, gateway dump, files archive (may be empty)
  local main_file="$1" gateway_file="$2" files_file="$3"
  log "restoring aside, without stopping anything"
  drop_db "${MAIN}_previous"
  drop_db "${GATEWAY}_previous"
  if ! { restore_into "$main_file" "${MAIN}_new" && restore_into "$gateway_file" "${GATEWAY}_new"; }; then
    REASON=unreadable
    revert_dbs
    return 1
  fi
  if ! history_ok "${MAIN}_new"; then
    REASON=incomplete
    revert_dbs
    return 1
  fi
  log "in the backup: $(counts "${MAIN}_new" "${GATEWAY}_new")"
  if [ -n "$files_file" ] && ! stage_files "$files_file"; then
    REASON=files
    revert_dbs
    revert_files
    return 1
  fi

  log "stopping the platform and swapping"
  stop_platform
  if ! { swap_in && swap_files; }; then
    REASON=swap
    revert_dbs
    revert_files
    start_platform || true
    return 1
  fi

  log "bringing the platform up"
  if ! start_platform; then
    REASON=start
    stop_platform || true
    revert_dbs
    revert_files
    start_platform || true
    return 1
  fi
  drop_db "${MAIN}_previous"
  drop_db "${GATEWAY}_previous"
  rm -rf "$FILES_OLD"
  log "in use: $(counts "$MAIN" "$GATEWAY")"
}

# A request left halfway: this helper was stopped while it was being handled.
# Whatever it reached is undone and the platform is brought up with what it had.
handle_cut() {
  log "a restore was left halfway; the platform goes back to what it had"
  started="$(now)"
  stop_platform || true
  revert_dbs
  revert_files
  if exists_db "$MAIN" && exists_db "$GATEWAY" && start_platform; then report failed cut; else report failed broken; fi
}

handle_request() {
  started="$(now)"
  local id main_file gateway_file files_file
  id="$(field id)"
  main_file="$(field gps)"
  gateway_file="$(field traccar)"
  files_file="$(field files)"
  log "restore request for backup $id"
  # The platform writes the request, but it is not trusted unseen: only backup
  # file names are accepted, of regular files that are in the backups folder.
  valid() { [[ "$1" =~ $2 ]] && [ -f "$DIR/$1" ] && [ ! -L "$DIR/$1" ] && [ -s "$DIR/$1" ]; }
  if ! [[ "$id" =~ ^[0-9a-f-]{36}$ ]] ||
    ! valid "$main_file" '^gps_[0-9]{8}_[0-9]{6}\.dump$' ||
    ! valid "$gateway_file" '^traccar_[0-9]{8}_[0-9]{6}\.dump$' ||
    { [ -n "$files_file" ] && ! valid "$files_file" '^files_[0-9]{8}_[0-9]{6}\.tar\.gz$'; }; then
    report failed invalid
    return
  fi
  REASON=""
  if replace "$DIR/$main_file" "$DIR/$gateway_file" "${files_file:+$DIR/$files_file}"; then report ok ""; else report failed "${REASON:-unknown}"; fi
}

# ─── Updates ─────────────────────────────────────────────────────────────────

# Where something mounted in this container comes from: a volume's name or a host folder.
mount_of() { # destination
  docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$1\"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}" "$HOSTNAME" 2>/dev/null
}
# The installation's folder on the host, as Docker Compose resolves its paths.
HOST_INSTALL="${HOST_INSTALL:-}"
if [ -z "$HOST_INSTALL" ] && [ -d "$INSTALL" ]; then HOST_INSTALL="$(mount_of "$INSTALL")"; fi
# This helper can install versions when it sees the installation's files and has Docker Compose.
UPDATE_OK=no
if [ -n "$HOST_INSTALL" ] && [ -f "$INSTALL/docker-compose.yml" ] && [ -w "$INSTALL/.env" ] && docker compose version > /dev/null 2>&1; then UPDATE_OK=yes; fi

ufield() { grep -m1 "^$1=" "$UPDATE_RUNNING" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true; }
installed_version() { grep -m1 '^OPENGPS_VERSION=' "$1/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true; }
report_update() { # status (ok|failed), reason code, detail
  local tmp="$UPDATE_RESULT.tmp"
  printf 'id=%s\nversion=%s\nfrom=%s\nrequested=%s\nstarted=%s\nfinished=%s\nstatus=%s\nreason=%s\ndetail=%s\n' \
    "$(ufield id)" "$(ufield version)" "$(ufield from)" "$(ufield requested)" "${started:-$(now)}" "$(now)" "$1" "$2" "${3:-}" | tr -d '\r' > "$tmp"
  chown "$OWNER" "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$UPDATE_RESULT"
  rm -f "$UPDATE_RUNNING"
  log "update ended: $1 $2 ${3:-}"
}

# Docker Compose on a folder with docker-compose.yml and .env, in this helper's project.
compose_in() { # folder, arguments...
  local folder="$1"
  shift
  docker compose --project-name "$PROJECT" --project-directory "$folder" -f "$folder/docker-compose.yml" --env-file "$folder/.env" "$@"
}
have_image() { docker image inspect "$1" > /dev/null 2>&1; }
# The image of this helper in another version: same name, other tag.
helper_image() { # version
  local image
  image="$(docker inspect -f '{{.Config.Image}}' "$HOSTNAME")"
  echo "${image%:*}:$1"
}
updater() { docker ps -q --filter "name=^$PROJECT-updater$"; }

# Which way of installing a compose file is: its "x-opengps-deploy" mark.
variant_of() { sed -n 's/^x-opengps-deploy:[[:space:]]*//p' "$1" 2> /dev/null | tr -d '"\r ' | head -1; }

# Leaves in <base>/.update what the installation in <base> gets with a
# version: the compose file of its way of installing, from <root>/<way>/, and
# its .env with that version. An installation from before the ways existed
# (0.1.x) has no mark: with the tunnel's profile it is deploy/cloudflare, and
# otherwise deploy/docker-compose with the web app's port only for the server
# itself, since those installations did not publish it.
stage_update() { # base, root, version
  local base="$1" root="$2" version="$3" stage="$1/.update" variant legacy=no
  variant="$(variant_of "$base/docker-compose.yml")"
  if [ -z "$variant" ]; then
    legacy=yes
    if grep -Eq '^COMPOSE_PROFILES=.*tunnel' "$base/.env"; then variant=cloudflare; else variant=docker-compose; fi
  fi
  if ! [[ "$variant" =~ ^[a-z-]+$ ]] || [ ! -f "$root/$variant/docker-compose.yml" ]; then return 1; fi
  if ! { rm -rf "$stage" && mkdir -p "$stage" && cp "$root/$variant/docker-compose.yml" "$stage/docker-compose.yml"; }; then return 1; fi
  {
    if [ "$legacy" = yes ]; then
      grep -v -e '^OPENGPS_VERSION=' -e '^COMPOSE_PROFILES=' "$base/.env"
      if [ "$variant" = docker-compose ] && ! grep -q '^WEB_BIND=' "$base/.env"; then echo 'WEB_BIND=127.0.0.1'; fi
    else
      grep -v '^OPENGPS_VERSION=' "$base/.env"
    fi
    printf 'OPENGPS_VERSION=%s\n' "$version"
  } > "$stage/.env"
}

# Until the platform answers with this version and the gateway is up. A
# platform that cannot start fails quickly; one that starts slowly has up to
# UPDATE_WAIT_S.
wait_version() { # version
  local want="$1" waited platform state
  for ((waited = 0; waited < UPDATE_WAIT_S; waited += 5)); do
    platform="$(container opengps)"
    state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$platform" 2>/dev/null)"
    case "$state" in
      "running healthy")
        if docker exec "$platform" wget -qO- http://127.0.0.1:3000/api/health 2> /dev/null | grep -q "\"version\":\"$want\"" && healthy "$(container traccar)"; then return 0; fi
        ;;
      restarting* | exited* | dead* | "running unhealthy")
        if [ "$waited" -ge 20 ]; then return 1; fi
        ;;
    esac
    sleep 5
  done
  return 1
}

# The request, prepared here: the new images downloaded and the new compose
# file checked against .env. Then a container of the new helper applies it.
handle_update_request() {
  started="$(now)"
  local id version helper files cid err
  id="$(ufield id)"
  version="$(ufield version)"
  log "update request to $version"
  if ! [[ "$id" =~ ^[0-9a-f-]{36}$ && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    report_update failed invalid
    return
  fi
  if [ "$UPDATE_OK" != yes ]; then
    report_update failed unsupported
    return
  fi
  printf 'from=%s\n' "$(installed_version "$INSTALL")" >> "$UPDATE_RUNNING"
  helper="$(helper_image "$version")"
  if ! have_image "$helper" && ! docker pull -q "$helper" > /dev/null; then
    report_update failed pull "$helper"
    return
  fi
  # The new version's compose files travel inside its helper image.
  files="$(mktemp -d)"
  if ! cid="$(docker create "$helper")" || ! docker cp "$cid:/opt/opengps/." "$files" > /dev/null; then
    [ -n "${cid:-}" ] && docker rm "$cid" > /dev/null
    rm -rf "$files"
    report_update failed files
    return
  fi
  docker rm "$cid" > /dev/null
  if ! stage_update "$INSTALL" "$files" "$version"; then
    rm -rf "$files"
    report_update failed files
    return
  fi
  rm -rf "$files"
  if ! err="$(compose_in "$INSTALL/.update" config --quiet 2>&1)"; then
    report_update failed env "$(echo "$err" | tail -1)"
    return
  fi
  if ! compose_in "$INSTALL/.update" pull --policy missing --quiet; then
    report_update failed pull
    return
  fi
  log "version $version ready; a container of it installs it"
  if ! docker run -d --rm --name "$PROJECT-updater" \
    -e HELPER_PROJECT="$PROJECT" -e HOST_INSTALL="$HOST_INSTALL" -e UPDATE_WAIT_S="$UPDATE_WAIT_S" \
    -e POSTGRES_USER="$PGUSER" -e POSTGRES_DB="$MAIN" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$HOST_INSTALL:$HOST_INSTALL" \
    -v "$(mount_of /data/backups):/data/backups" -v "$(mount_of /data/files):/data/files" \
    "$helper" /usr/local/bin/helper.sh apply > /dev/null; then
    report_update failed start
  fi
}

# In the container of the new version: swaps the files, brings everything up
# and waits; if the new version does not answer, the previous files, and if
# even that does not start, the backup made just before. What it installs it
# takes from this image, whoever prepared the request: a helper from before
# the ways of installing existed leaves here the only file it knew.
apply_update() {
  started="$(now)"
  local folder="$HOST_INSTALL" version from main_file gateway_file files_file err
  version="$(ufield version)"
  from="$(ufield from)"
  if ! stage_update "$folder" /opt/opengps "$version"; then
    report_update failed files
    return
  fi
  if ! err="$(compose_in "$folder/.update" config --quiet 2>&1)"; then
    rm -rf "$folder/.update"
    report_update failed env "$(echo "$err" | tail -1)"
    return
  fi
  if ! { cp "$folder/docker-compose.yml" "$folder/docker-compose.yml.previous" && cp "$folder/.env" "$folder/.env.previous" &&
    cat "$folder/.update/docker-compose.yml" > "$folder/docker-compose.yml" && cat "$folder/.update/.env" > "$folder/.env" &&
    rm -rf "$folder/.update"; }; then
    report_update failed files
    return
  fi
  log "installing $version over $from"
  if compose_in "$folder" up -d --remove-orphans && wait_version "$version"; then
    report_update ok ""
    return
  fi
  log "version $version did not answer; going back to $from"
  cat "$folder/docker-compose.yml.previous" > "$folder/docker-compose.yml" && cat "$folder/.env.previous" > "$folder/.env"
  if compose_in "$folder" up -d --remove-orphans && wait_version "$from"; then
    report_update failed rolled_back
    return
  fi
  main_file="$(ufield gps)"
  gateway_file="$(ufield traccar)"
  files_file="$(ufield files)"
  if [ -n "$main_file" ] && [ -n "$gateway_file" ] && [ -f "$DIR/$main_file" ] && [ -f "$DIR/$gateway_file" ]; then
    log "version $from does not start either; restoring the backup made before"
    REASON=""
    if replace "$DIR/$main_file" "$DIR/$gateway_file" "${files_file:+$DIR/$files_file}"; then
      report_update failed restored
      return
    fi
  fi
  report_update failed broken
}

# A request left halfway: the container applying it stopped. If the new
# version answers, it was done; otherwise the previous files come back.
handle_update_cut() {
  started="$(now)"
  local version
  version="$(ufield version)"
  if UPDATE_WAIT_S=30 wait_version "$version"; then
    report_update ok ""
  elif [ -f "$INSTALL/docker-compose.yml.previous" ] && [ -f "$INSTALL/.env.previous" ]; then
    cat "$INSTALL/docker-compose.yml.previous" > "$INSTALL/docker-compose.yml" && cat "$INSTALL/.env.previous" > "$INSTALL/.env"
    report_update failed cut
    log "the previous files are back; docker compose up -d in the installation's folder brings that version up"
  else
    report_update failed cut
  fi
}

# ─── The loop ────────────────────────────────────────────────────────────────

trap 'exit 0' TERM INT
mkdir -p "$DIR"
# The container of a new version, applying it, does that and leaves.
if [ "${1:-}" = apply ]; then
  apply_update
  exit 0
fi
# Sign of life for the console, also while a restore is under way, and what this helper can do.
(while true; do
  printf 'restore=yes\nupdate=%s\n' "$UPDATE_OK" > "$ALIVE.tmp" && chown "$OWNER" "$ALIVE.tmp" && mv "$ALIVE.tmp" "$ALIVE"
  sleep 30
done) &
log "helper ready (project $PROJECT, updates: $UPDATE_OK)"
while true; do
  if [ -f "$RUNNING" ]; then
    handle_cut
  elif [ -f "$REQUEST" ] && [ ! -L "$REQUEST" ]; then
    mv "$REQUEST" "$RUNNING"
    handle_request
  elif [ -f "$UPDATE_RUNNING" ]; then
    # While the container of the new version works, it is left alone.
    [ -n "$(updater)" ] || handle_update_cut
  elif [ -f "$UPDATE_REQUEST" ] && [ ! -L "$UPDATE_REQUEST" ]; then
    mv "$UPDATE_REQUEST" "$UPDATE_RUNNING"
    handle_update_request
  fi
  sleep 10 &
  wait $!
done
