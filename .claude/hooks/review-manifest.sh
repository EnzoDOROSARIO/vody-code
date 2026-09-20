#!/usr/bin/env bash
# Prints what a review covers: one line per path that differs from HEAD, as
#
#     <sha256 of its content><tab><path>
#
# A line per path rather than one hash over the lot, so that committing part of a
# reviewed tree leaves the rest still covered. Committing only ever takes lines away —
# the paths it commits stop differing from HEAD and drop out of `git status` — and the
# hook asks whether every line still here was in the record, never whether the two are
# equal. One hash could not answer that: it moves when anything leaves.
#
# Deliberately blind to the index. `git add` moves a path between git's staged and
# unstaged columns without changing a byte of it, and a review that ran before staging
# is still a review of the same work — so paths are collected from status but their
# content is hashed from disk, which staging leaves alone.
#
# Deliberately blind to HEAD as well. The question this answers is whether the work
# about to be committed is the work that was reviewed, and which commit it happens to
# sit on is not part of that work.
#
# Ignored files never appear, so the record this feeds and the coverage report the
# review generates cannot invalidate the manifest they are part of.
#
# A path deleted from the working tree is recorded as `absent`, which is a state a
# review can cover like any other: bringing the file back changes the line, and the
# hook holds the commit until someone has read what came back.
set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

cd "$root" || exit 0

git -c core.quotepath=false status --porcelain=v1 --untracked-files=all |
  sed -e 's/^...//' -e 's/.* -> //' |
  LC_ALL=C sort -u |
  while IFS= read -r path; do
    if [ -f "$path" ]; then
      printf '%s\t%s\n' "$(shasum -a 256 -- "$path" 2>/dev/null | cut -d' ' -f1)" "$path"
    else
      printf 'absent\t%s\n' "$path"
    fi
  done
