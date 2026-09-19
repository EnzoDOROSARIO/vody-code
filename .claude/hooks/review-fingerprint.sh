#!/usr/bin/env bash
# Prints one hash standing for everything in this tree that is not yet committed:
# the commit it differs from, which paths differ, and what each of those now holds.
#
# Deliberately blind to the index. `git add` moves a path between git's staged and
# unstaged columns without changing a byte of it, and a review that ran before
# staging is still a review of the same work — so paths are collected from status
# but their content is hashed from disk, which staging leaves alone.
#
# Ignored files never appear, so the marker this feeds and the coverage report the
# review generates cannot invalidate the fingerprint they are part of.
set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  printf 'not-a-git-repository\n'
  exit 0
}

cd "$root" || exit 0

{
  git rev-parse HEAD 2>/dev/null || printf 'no-head\n'

  git -c core.quotepath=false status --porcelain=v1 --untracked-files=all |
    sed -e 's/^...//' -e 's/.* -> //' |
    LC_ALL=C sort -u |
    while IFS= read -r path; do
      printf '%s\n' "$path"

      if [ -f "$path" ]; then
        shasum -a 256 -- "$path" 2>/dev/null | cut -d' ' -f1
      else
        printf 'absent\n'
      fi
    done
} | shasum -a 256 | cut -d' ' -f1
