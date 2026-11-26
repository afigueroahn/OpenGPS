#!/usr/bin/env bash
# The platform's helper, the only service with access to Docker. It installs a
# new version when the platform's admin console asks. Restoring a backup the
# platform does by itself (ADR-0009).
#
# Files they talk through, in the backups folder, as "key=value" lines:
#   helper.alive           rewritten every 30 s: the console shows the button.
#                          update=yes when this helper can install versions
#   update.request         written by the platform: which version to install,
#                          and the backup made just before
#   update.running         the same request, while it is handled
#   update.result          written here: how it ended
#   restore.request        written here when an update cannot start: the
#                          backup to restore, as the console asks for it
#   restore.result         written by whoever restored: how it ended
#
# Installing a version (ADR-0004). A container cannot replace itself: this
# helper prepares the new version (its images and its compose file, which
# comes inside the new helper image) and hands over to a container of the new
# helper, outside the Compose project ("helper.sh apply"). That one swaps the
# compose file, which says the version (ADR-0008), brings everything up (this
# helper too, replaced), waits for the platform to answer with the new
# version, and otherwise goes back to the previous files. If even that does not
# start, it asks for the backup made before to be restored, with the same
# request the console leaves, and whoever restores in the version it went
# back to handles it. The folder with docker-compose.yml and .env is mounted
# at /data/install. Only the ways of installing with Docker Compose have this
# helper: with Dokploy and Coolify, updating is deploying again (ADR-0005).
#
# There are several ways of installing with Docker Compose (deploy/<way>), each
# with its own compose file, marked "x-opengps-deploy: <way>". The helper image
# carries the file of each way, in /opt/opengps/<way>/, and an update keeps the
# way the installation has. An installation without the mark, from before the
# ways existed (0.1.x), is not updated from here (ADR-0011).
set -uo pipefail

DIR=/data/backups

REQUEST="$DIR/restore.request"
RESULT="$DIR/restore.result"
ALIVE="$DIR/helper.alive"
UPDATE_REQUEST="$DIR/update.request"
UPDATE_RUNNING="$DIR/update.running"
UPDATE_RESULT="$DIR/update.result"
INSTALL=/data/install
# How long a new version has to answer before going back to the previous one.
UPDATE_WAIT_S="${UPDATE_WAIT_S:-300}"
# How long a restore asked for by an update may take, as long as a backup may.
RESTORE_WAIT_S="${RESTORE_WAIT_S:-7200}"
# The platform runs as user 1000: it reads what this helper writes.
OWNER=1000:1000

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(now) $*"; }

# This helper's Compose project: the other services are found by its labels.
# The container that applies an update is outside the project: it is told.
PROJECT="${HELPER_PROJECT:-$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$HOSTNAME" 2>/dev/null || true)}"
if [ -z "$PROJECT" ]; then
  log "cannot tell which Compose project this helper belongs to: is the Docker socket mounted?"
  exit 1
fi
container() { docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -1; }

# ─── Updates ───────────────────────────────────────────────────────────────

healthy() { [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null)" = healthy ]; }

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
# The version an installation runs: the one of the platform's image in its
# compose file or, from before the version was written there, OPENGPS_VERSION
# in its .env.
installed_version() { # folder
  local version
  version="$(sed -nE 's#^[[:space:]]*image:[[:space:]]*[^[:space:]]+/opengps:([0-9]+\.[0-9]+\.[0-9]+)[[:space:]]*$#\1#p' "$1/docker-compose.yml" 2>/dev/null | head -1)"
  if [ -z "$version" ]; then version="$(grep -m1 '^OPENGPS_VERSION=' "$1/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r')"; fi
  echo "$version"
}
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
# The image of this helper, and the same one in another version: same name, other tag.
own_image() { docker inspect -f '{{.Config.Image}}' "$HOSTNAME"; }
helper_image() { # version
  local image
  image="$(own_image)"
  echo "${image%:*}:$1"
}
# The compose files a helper image carries, in /opt/opengps, copied to a new
# folder whose path it prints. Copied out of the image, never read from this
# container's /opt/opengps: the container that applies a version has the
# installation's folder mounted at its path on the host, and that folder may
# be /opt/opengps, which covers the image's.
version_files() { # image
  local dir cid=""
  dir="$(mktemp -d)" || return 1
  if cid="$(docker create "$1")" && docker cp "$cid:/opt/opengps/." "$dir" > /dev/null; then
    docker rm "$cid" > /dev/null
    echo "$dir"
    return 0
  fi
  if [ -n "$cid" ]; then docker rm "$cid" > /dev/null; fi
  rm -rf "$dir"
  return 1
}
updater() { docker ps -q --filter "name=^$PROJECT-updater$"; }

# Which way of installing a compose file is: its "x-opengps-deploy" mark.
variant_of() { sed -n 's/^x-opengps-deploy:[[:space:]]*//p' "$1" 2> /dev/null | tr -d '"\r ' | head -1; }

# Leaves in <base>/.update what the installation in <base> gets with another
# version: the compose file of its way of installing, from <root>/<way>/, which
# says that version, and its .env without OPENGPS_VERSION, which is no longer
# read (ADR-0008). Without the mark of a way there is nothing to leave: it
# fails.
stage_update() { # base, root
  local base="$1" root="$2" stage="$1/.update" variant
  variant="$(variant_of "$base/docker-compose.yml")"
  if ! [[ "$variant" =~ ^[a-z-]+$ ]] || [ ! -f "$root/$variant/docker-compose.yml" ]; then return 1; fi
  if ! { rm -rf "$stage" && mkdir -p "$stage" && cp "$root/$variant/docker-compose.yml" "$stage/docker-compose.yml"; }; then return 1; fi
  grep -v '^OPENGPS_VERSION=' "$base/.env" > "$stage/.env"
  [ -s "$stage/.env" ]
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
  local id version helper files err
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
  if ! files="$(version_files "$helper")"; then
    report_update failed files
    return
  fi
  if ! stage_update "$INSTALL" "$files"; then
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
    -v /var/run/docker.sock:/var/run/docker.sock -v "$HOST_INSTALL:$HOST_INSTALL" \
    -v "$(mount_of /data/backups):/data/backups" \
    "$helper" /usr/local/bin/helper.sh apply > /dev/null; then
    report_update failed start
  fi
}

# Asks for a backup to be restored, with the same request the console leaves,
# and waits until it ends. The platform of the version that is up restores it,
# or, in a version from before ADR-0009, its helper. True if it ended well.
ask_restore() { # backup id, platform dump, gateway dump, files archive (may be empty)
  local requested at waited result
  requested="$(now)"
  # When the backup was made, from its files' names: the console shows it.
  at="$(sed -nE 's/^gps_([0-9]{4})([0-9]{2})([0-9]{2})_([0-9]{2})([0-9]{2})([0-9]{2})\.dump$/\1-\2-\3T\4:\5:\6.000Z/p' <<< "$2")"
  if ! { printf 'id=%s\nbackup=%s\nrequested=%s\ngps=%s\ntraccar=%s\nfiles=%s\n' "$1" "$at" "$requested" "$2" "$3" "$4" > "$REQUEST.tmp" &&
    chown "$OWNER" "$REQUEST.tmp" && chmod 600 "$REQUEST.tmp" && mv "$REQUEST.tmp" "$REQUEST"; }; then
    return 1
  fi
  for ((waited = 0; waited < RESTORE_WAIT_S; waited += 5)); do
    result="$(cat "$RESULT" 2> /dev/null || true)"
    if grep -qx "id=$1" <<< "$result" && grep -qx "requested=$requested" <<< "$result"; then
      grep -qx 'status=ok' <<< "$result"
      return
    fi
    sleep 5
  done
  return 1
}

# In the container of the new version: swaps the files, brings everything up
# and waits; if the new version does not answer, the previous files, and if
# even that does not start, the backup made just before. What it installs it
# takes from this image, not from what the helper of the previous version
# prepared.
apply_update() {
  started="$(now)"
  local folder="$HOST_INSTALL" version from files backup main_file gateway_file files_file err
  version="$(ufield version)"
  from="$(ufield from)"
  if ! files="$(version_files "$(own_image)")"; then
    report_update failed files
    return
  fi
  if ! stage_update "$folder" "$files"; then
    rm -rf "$files"
    report_update failed files
    return
  fi
  rm -rf "$files"
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
  backup="$(ufield backup)"
  main_file="$(ufield gps)"
  gateway_file="$(ufield traccar)"
  files_file="$(ufield files)"
  if [ -n "$backup" ] && [ -n "$main_file" ] && [ -n "$gateway_file" ] && [ -f "$DIR/$main_file" ] && [ -f "$DIR/$gateway_file" ]; then
    log "version $from does not start either; asking for the backup made before"
    if ask_restore "$backup" "$main_file" "$gateway_file" "$files_file" && wait_version "$from"; then
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
# Sign of life for the console, and what this helper can do.
(while true; do
  printf 'update=%s\n' "$UPDATE_OK" > "$ALIVE.tmp" && chown "$OWNER" "$ALIVE.tmp" && mv "$ALIVE.tmp" "$ALIVE"
  sleep 30
done) &
log "helper ready (project $PROJECT, updates: $UPDATE_OK)"
while true; do
  if [ -f "$UPDATE_RUNNING" ]; then
    # While the container of the new version works, it is left alone.
    [ -n "$(updater)" ] || handle_update_cut
  elif [ -f "$UPDATE_REQUEST" ] && [ ! -L "$UPDATE_REQUEST" ]; then
    mv "$UPDATE_REQUEST" "$UPDATE_RUNNING"
    handle_update_request
  fi
  sleep 10 &
  wait $!
done
