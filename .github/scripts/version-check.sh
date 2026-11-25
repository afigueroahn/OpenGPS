#!/usr/bin/env bash
# The compose files of deploy/ run the platform's images in the version of
# the root package.json, the last one released (ADR-0008): a release PR raises
# both. The CI checks it on every change, and a release before it builds
# anything. Each runs the platform and the database, and the ways with Docker
# Compose the helper too.
#
#   .github/scripts/version-check.sh
#
# Run from the repository.
set -euo pipefail

version="$(node -p 'require("./package.json").version')"
failed=0
for compose in deploy/*/docker-compose.yml; do
  ours="$(grep -c 'image: ghcr.io/afigueroahn/' "$compose" || true)"
  if [ "$ours" -lt 2 ] || [ "$(grep -cx " *image: ghcr.io/afigueroahn/[a-z-]*:$version" "$compose" || true)" != "$ours" ]; then
    echo "$compose does not run the platform's images in $version, the version of package.json" >&2
    failed=1
  fi
done
if [ "$failed" != 0 ]; then exit 1; fi
echo "The compose files of deploy/ run $version, the version of package.json"
