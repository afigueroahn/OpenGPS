#!/usr/bin/env bash
# Installing a version from the console, end to end, with Docker (ADR-0004).
# Builds three versions of the images: 0.0.1, 0.0.2, and a 0.0.3 whose
# platform cannot start. Installs 0.0.1 as a server would, from the compose
# file and generate-env.sh, then asks the helper for 0.0.2, which it must
# install, and for 0.0.3, which it must undo, going back to 0.0.2.
#
#   .github/scripts/update-e2e.sh [WORK_DIR]
#
# Run from the repository. KEEP=1 leaves the installation and the images.
set -euo pipefail

REG=ghcr.io/afigueroahn
PROJECT=opengps-e2e
WORK="${1:-$(mktemp -d)}"
INSTALL="$WORK/install"

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

say "building the images of 0.0.1, 0.0.2 and a broken 0.0.3"
for v in 0.0.1 0.0.2; do
  docker build -q --build-arg "APP_VERSION=$v" -t "$REG/opengps:$v" -f deploy/opengps.Dockerfile . > /dev/null
  docker build -q -t "$REG/opengps-postgres:$v" -f deploy/postgres.Dockerfile . > /dev/null
  docker build -q -t "$REG/opengps-helper:$v" -f deploy/helper.Dockerfile . > /dev/null
done
printf 'FROM %s/opengps:0.0.2\nCMD ["sh", "-c", "echo this version cannot start; exit 1"]\n' "$REG" | docker build -q -t "$REG/opengps:0.0.3" - > /dev/null
docker tag "$REG/opengps-postgres:0.0.2" "$REG/opengps-postgres:0.0.3"
docker tag "$REG/opengps-helper:0.0.2" "$REG/opengps-helper:0.0.3"

say "installing 0.0.1 in $INSTALL"
mkdir -p "$INSTALL"
cp deploy/docker-compose/docker-compose.yml deploy/generate-env.sh deploy/.env.example "$INSTALL/"
(cd "$INSTALL" && OPENGPS_VERSION=0.0.1 sh generate-env.sh http://localhost .env > /dev/null)
sed -i.bak "s/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=$PROJECT/" "$INSTALL/.env" && rm "$INSTALL/.env.bak"
(cd "$INSTALL" && docker compose up -d --quiet-pull > /dev/null)

# Until the platform answers with this version.
answers() { # version, seconds
  local i
  for ((i = 0; i < $2; i += 5)); do
    if docker exec "$(service opengps)" wget -qO- http://127.0.0.1:3000/api/health 2> /dev/null | grep -q "\"version\":\"$1\""; then return 0; fi
    sleep 5
  done
  return 1
}
answers 0.0.1 300 || fail "0.0.1 did not start"
grep -q '^update=yes$' <(docker exec "$(service helper)" cat /data/backups/helper.alive) || fail "the helper does not offer updates"

# Asks the helper for a version and waits for how it ended.
update() { # version
  local id result i
  id="$(cat /proc/sys/kernel/random/uuid 2> /dev/null || uuidgen | tr 'A-Z' 'a-z')"
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

say "asking for 0.0.2"
result="$(update 0.0.2)"
echo "$result"
grep -q '^status=ok$' <<< "$result" || fail "the update to 0.0.2 did not end well"
answers 0.0.2 30 || fail "the platform does not answer 0.0.2"
grep -q '^OPENGPS_VERSION=0.0.2$' "$INSTALL/.env" || fail ".env does not say 0.0.2"
[ "$(docker inspect -f '{{.Config.Image}}' "$(service helper)")" = "$REG/opengps-helper:0.0.2" ] || fail "the helper was not replaced"

say "asking for 0.0.3, which cannot start"
result="$(update 0.0.3)"
echo "$result"
grep -q '^status=failed$' <<< "$result" && grep -q '^reason=rolled_back$' <<< "$result" || fail "0.0.3 was not undone"
answers 0.0.2 30 || fail "the platform is not back on 0.0.2"
grep -q '^OPENGPS_VERSION=0.0.2$' "$INSTALL/.env" || fail ".env is not back on 0.0.2"

say "updates work: 0.0.1 → 0.0.2 installed, 0.0.3 undone"
