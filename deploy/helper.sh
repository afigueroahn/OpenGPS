#!/usr/bin/env bash
# The platform's helper, the only service with access to Docker. It restores
# a backup when the platform's admin console asks for it.
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
#   helper.alive           touched every 30 s: the console shows the button
#   restore.request        written by the platform: which backup to restore
#   restore.running        the same request, while it is handled
#   restore.result         written here: how it ended (reason: a code the
#                          platform turns into words)
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
PROJECT="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$HOSTNAME" 2>/dev/null || true)"
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

# ─── The loop ────────────────────────────────────────────────────────────────

trap 'exit 0' TERM INT
mkdir -p "$DIR"
# Sign of life for the console, also while a restore is under way.
(while true; do
  touch "$ALIVE" && chown "$OWNER" "$ALIVE"
  sleep 30
done) &
log "restore helper ready (project $PROJECT)"
while true; do
  if [ -f "$RUNNING" ]; then
    handle_cut
  elif [ -f "$REQUEST" ] && [ ! -L "$REQUEST" ]; then
    mv "$REQUEST" "$RUNNING"
    handle_request
  fi
  sleep 10 &
  wait $!
done
