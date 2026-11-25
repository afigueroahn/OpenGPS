#!/usr/bin/env bash
# The variables of an installation, checked both ways: every variable a compose
# file of deploy/ reads is explained in deploy/.env.example, and every variable
# explained there is read by a compose file.
#
#   .github/scripts/env-check.sh
#
# Run from the repository. What Coolify gives on its own (SERVICE_*) is written
# by nobody, so .env.example does not have it.
set -euo pipefail

EXAMPLE=deploy/.env.example

# The variables a compose file reads: ${NAME}, ${NAME:-default} and the like.
# Not $${NAME}, which Compose passes on as it is.
read_by() { # compose file
  grep -oE '(^|[^$])\$\{[A-Z][A-Z0-9_]*' "$1" | sed -E 's/.*\{//' | sort -u
}
# The variables .env.example explains: "NAME=value", or "# NAME=value" for one
# that is left out unless somebody wants it.
explained="$(sed -nE 's/^(# )?([A-Z][A-Z0-9_]*)=.*/\2/p' "$EXAMPLE" | sort)"

failed=0
complain() {
  echo "$*" >&2
  failed=1
}

repeated="$(uniq -d <<< "$explained")"
if [ -n "$repeated" ]; then complain "$EXAMPLE explains more than once: $(tr '\n' ' ' <<< "$repeated")"; fi

read_by_any=""
for compose in deploy/*/docker-compose.yml; do
  names="$(read_by "$compose")"
  read_by_any+="$names"$'\n'
  while IFS= read -r name; do
    case "$name" in
      "" | SERVICE_*) continue ;;
    esac
    if ! grep -qx "$name" <<< "$explained"; then complain "$compose reads $name, which $EXAMPLE does not explain"; fi
  done <<< "$names"
done
while IFS= read -r name; do
  if [ -n "$name" ] && ! grep -qx "$name" <<< "$read_by_any"; then complain "$EXAMPLE explains $name, which no compose file reads"; fi
done <<< "$explained"

if [ "$failed" != 0 ]; then exit 1; fi
echo "$EXAMPLE and the compose files of deploy/ agree: $(grep -c . <<< "$explained") variables"
