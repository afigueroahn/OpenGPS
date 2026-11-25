#!/bin/sh
# Writes the variables of a new OpenGPS installation, from .env.example (or
# env.example, as a release attaches it) next to this script, with its address
# filled in and its secrets generated here (openssl rand).
#
#   sh generate-env.sh https://example.com .env   writes the file
#   sh generate-env.sh https://example.com        prints them, to paste in Dokploy
#
# The address can also be given as the domain alone (example.com): it is
# taken as https. It never overwrites a file that exists. The version is not
# among the variables: the compose file says it (ADR-0008).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ADDRESS="${1:?Usage: sh generate-env.sh <https://domain> [file]}"
OUT="${2:-}"

TEMPLATE="$HERE/.env.example"
[ -f "$TEMPLATE" ] || TEMPLATE="$HERE/env.example"
[ -f "$TEMPLATE" ] || { echo "Neither .env.example nor env.example is next to generate-env.sh" >&2; exit 1; }

case "$ADDRESS" in
  http://* | https://*) ;;
  *) ADDRESS="https://$ADDRESS" ;;
esac
ADDRESS="${ADDRESS%/}"
command -v openssl >/dev/null 2>&1 || { echo "openssl is needed to generate the secrets" >&2; exit 1; }
if [ -n "$OUT" ] && [ -e "$OUT" ]; then
  echo "$OUT already exists: it is left as it is." >&2
  exit 1
fi

fill() {
  sed \
    -e "s|^PUBLIC_URL=.*|PUBLIC_URL=$ADDRESS|" \
    -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -hex 32)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" \
    "$TEMPLATE"
}

if [ -n "$OUT" ]; then
  (umask 077 && fill > "$OUT")
  echo "Written $OUT."
else
  # Only the variables, without the explanations: what Dokploy's Environment tab takes.
  fill | grep -E '^[A-Z_]+='
fi
