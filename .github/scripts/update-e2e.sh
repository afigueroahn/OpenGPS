#!/usr/bin/env bash
# Installing a version from the console, end to end, with Docker (ADR-0004),
# for one way of installing (ADR-0005).
#
#   .github/scripts/update-e2e.sh [WAY] [WORK_DIR]
#
# WAY is a folder of deploy/ that the helper can update (docker-compose by
# default, caddy, cloudflare), or "legacy":
#
# - A way: builds three versions of the images, 0.0.1, 0.0.2 and a 0.0.3 whose
#   platform cannot start. Installs 0.0.1 as a server would, from that way's
#   compose file and generate-env.sh, then asks the helper for 0.0.2, which it
#   must install keeping the way, and for 0.0.3, which it must undo.
# - legacy: installs the published 0.1.2, from before the ways existed, with
#   its Cloudflare Tunnel profile, and asks its helper for 0.0.2: the
#   installation must end as deploy/cloudflare, with its tunnel.
#
# Run from the repository. KEEP=1 leaves the installation and the images.
set -euo pipefail

REG=ghcr.io/afigueroahn
WAY="${1:-docker-compose}"
PROJECT="opengps-e2e-$WAY"
WORK="${2:-$(mktemp -d)}"
INSTALL="$WORK/install"
LEGACY=0.1.2

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
  docker build -q -t "$REG/opengps-helper:$1" -f deploy/helper.Dockerfile . > /dev/null
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
# Asks the helper for a version and waits for how it ended.
update() { # version
  local id result i
  id="$(cat /proc/sys/kernel/random/uuid 2> /dev/null || uuidgen | tr '[:upper:]' '[:lower:]')"
  docker exec "$(service helper)" sh -c "printf 'id=%s\nversion=%s\nrequested=%s\n' '$id' '$1' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > /data/backups/update.request"
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
# The way of installing the installation has now.
way_installed() { sed -n 's/^x-opengps-deploy:[[:space:]]*//p' "$INSTALL/docker-compose.yml"; }
# With deploy/caddy, the web app answers through the proxy, on the server's port 80.
through_proxy() { # version
  if [ "$WAY" = caddy ] && ! curl -fsS --retry 10 --retry-delay 3 --retry-all-errors http://localhost/api/health | grep -q "\"version\":\"$1\""; then
    fail "the web app does not answer $1 through Caddy"
  fi
}

mkdir -p "$INSTALL"
if [ "$WAY" = legacy ]; then
  say "building the images of 0.0.2"
  build 0.0.2
  say "installing the published $LEGACY in $INSTALL, with its tunnel profile"
  for f in docker-compose.yml generate-env.sh env.example; do
    curl -fsSL -o "$INSTALL/$f" "https://github.com/afigueroahn/OpenGPS/releases/download/v$LEGACY/$f"
  done
  (cd "$INSTALL" && sh generate-env.sh https://example.com .env > /dev/null)
  setting "COMPOSE_PROJECT_NAME=$PROJECT"
  setting "COMPOSE_PROFILES=tunnel"
  # Not a real tunnel: its service stays trying, and the platform does not depend on it.
  setting "CLOUDFLARE_TUNNEL_TOKEN=not-a-real-token"
  FIRST="$LEGACY"
else
  [ -f "deploy/$WAY/docker-compose.yml" ] || fail "deploy/$WAY has no compose file"
  say "building the images of 0.0.1, 0.0.2 and a broken 0.0.3"
  build 0.0.1
  build 0.0.2
  printf 'FROM %s/opengps:0.0.2\nCMD ["sh", "-c", "echo this version cannot start; exit 1"]\n' "$REG" | docker build -q -t "$REG/opengps:0.0.3" - > /dev/null
  docker tag "$REG/opengps-postgres:0.0.2" "$REG/opengps-postgres:0.0.3"
  docker tag "$REG/opengps-helper:0.0.2" "$REG/opengps-helper:0.0.3"
  say "installing 0.0.1 in $INSTALL, as deploy/$WAY"
  cp "deploy/$WAY/docker-compose.yml" deploy/generate-env.sh deploy/.env.example "$INSTALL/"
  (cd "$INSTALL" && OPENGPS_VERSION=0.0.1 sh generate-env.sh http://localhost .env > /dev/null)
  setting "COMPOSE_PROJECT_NAME=$PROJECT"
  # Away from the port another installation on this machine may use.
  setting "WEB_PORT=13000"
  if [ "$WAY" = cloudflare ]; then setting "CLOUDFLARE_TUNNEL_TOKEN=not-a-real-token"; fi
  FIRST=0.0.1
fi
(cd "$INSTALL" && docker compose up -d --quiet-pull > /dev/null)
answers "$FIRST" 300 || fail "$FIRST did not start"
through_proxy "$FIRST"
grep -q '^update=yes$' <(docker exec "$(service helper)" cat /data/backups/helper.alive) || fail "the helper does not offer updates"

say "asking for 0.0.2"
result="$(update 0.0.2)"
echo "$result"
grep -q '^status=ok$' <<< "$result" || fail "the update to 0.0.2 did not end well"
answers 0.0.2 30 || fail "the platform does not answer 0.0.2"
grep -q '^OPENGPS_VERSION=0.0.2$' "$INSTALL/.env" || fail ".env does not say 0.0.2"
[ "$(docker inspect -f '{{.Config.Image}}' "$(service helper)")" = "$REG/opengps-helper:0.0.2" ] || fail "the helper was not replaced"

if [ "$WAY" = legacy ]; then
  [ "$(way_installed)" = cloudflare ] || fail "the installation did not end as deploy/cloudflare: $(way_installed)"
  [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=tunnel")" ] || fail "the tunnel is gone"
  if grep -q '^COMPOSE_PROFILES=' "$INSTALL/.env"; then fail ".env still has COMPOSE_PROFILES"; fi
  grep -q '^CLOUDFLARE_TUNNEL_TOKEN=not-a-real-token$' "$INSTALL/.env" || fail ".env lost the tunnel's token"
  say "updates work: the published $LEGACY → 0.0.2, now deploy/cloudflare with its tunnel"
  exit 0
fi

[ "$(way_installed)" = "$WAY" ] || fail "the installation is no longer deploy/$WAY: $(way_installed)"
through_proxy 0.0.2

say "asking for 0.0.3, which cannot start"
result="$(update 0.0.3)"
echo "$result"
if ! { grep -q '^status=failed$' <<< "$result" && grep -q '^reason=rolled_back$' <<< "$result"; }; then fail "0.0.3 was not undone"; fi
answers 0.0.2 30 || fail "the platform is not back on 0.0.2"
grep -q '^OPENGPS_VERSION=0.0.2$' "$INSTALL/.env" || fail ".env is not back on 0.0.2"
[ "$(way_installed)" = "$WAY" ] || fail "going back changed the way of installing: $(way_installed)"

say "updates work for deploy/$WAY: 0.0.1 → 0.0.2 installed, 0.0.3 undone"
