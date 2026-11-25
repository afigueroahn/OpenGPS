#!/usr/bin/env bash
# Decides whether this commit publishes a release (ADR-0003) and writes its
# notes. A release is due when the root package.json has a version X.Y.Z
# that has no tag vX.Y.Z yet and CHANGELOG.md has its section, "## [X.Y.Z]".
#
#   release-plan.sh NOTES_FILE
#
# Prints "version=…" and "release=true|false" for $GITHUB_OUTPUT, and on
# stderr why there is no release.
set -euo pipefail

notes="${1:?usage: release-plan.sh NOTES_FILE}"
version="$(node -p 'require("./package.json").version')"
echo "version=$version"

skip() {
  echo "release=false"
  echo "No release: $1" >&2
  exit 0
}

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || skip "the version $version is not X.Y.Z"
# 0: the tag exists; 2: it does not; anything else: the remote could not be read.
tagged=0
git ls-remote --exit-code --tags origin "refs/tags/v$version" > /dev/null 2>&1 || tagged=$?
case "$tagged" in
  0) skip "v$version is already published" ;;
  2) ;;
  *) echo "Cannot tell whether v$version is published: git ls-remote failed ($tagged)" >&2; exit 1 ;;
esac

# The section of this version, up to the next one, without blank lines at either end.
awk -v heading="## [$version]" '
  index($0, heading) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}' > "$notes"
[ -s "$notes" ] || skip "CHANGELOG.md has no section for $version"

echo "release=true"
echo "Release v$version, with these notes:" >&2
cat "$notes" >&2
