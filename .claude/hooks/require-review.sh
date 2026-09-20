#!/usr/bin/env bash
# PreToolUse on Bash: holds a `git commit` until this exact tree has been reviewed.
#
# The command is matched here rather than through the hook's `if` filter, because a
# commit usually arrives as `cd <somewhere> && git commit …`, and a prefix rule on
# `git commit` never sees past the `cd`.
#
# Matching is per command position, not per substring: the line is cut at every
# separator and each piece has to *begin* with git — optionally behind environment
# assignments, and past global flags — before `commit` counts as the subcommand.
# Searching the whole string instead would gate any command that merely mentions the
# phrase, which is most of the ones written about this hook.
#
# The escape hatch is held to the same standard, and for the stronger reason that it
# fails open: a substring test would let `git commit -m 'document SKIP_REVIEW=1'`
# straight through, and a commit message about this hook is one of the likeliest
# commands there is. It has to *lead* the segment that runs git, which is also what the
# denial below tells the reader to type.
set -uo pipefail

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0

readonly ENV='([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'

# A global flag is either `--name=value`, which is one word, or a flag whose argument
# may be a separate word: `-C <path>`, and `-c <key>=<value>`, which is how a commit
# arrives whenever the caller is overriding config for it. Enumerating the flags that
# take an argument is what the previous spelling got wrong, so the argument is optional
# here and the `commit` that follows is what decides the match.
readonly COMMIT="^${ENV}"\
'git([[:space:]]+(--[A-Za-z0-9-]+=[^[:space:]]*|-[A-Za-z-]+([[:space:]]+[^-][^[:space:]]*)?))*'\
'[[:space:]]+commit([[:space:]]|$)'

readonly SKIP="^${ENV}SKIP_REVIEW=1[[:space:]]"

committing=no

while IFS= read -r segment; do
  if printf '%s' "$segment" | grep -Eq "$SKIP"; then
    exit 0
  fi

  if printf '%s' "$segment" | grep -Eq "$COMMIT"; then
    committing=yes
    break
  fi
done <<EOF
$(printf '%s' "$command" | tr ';&|(){}' '\n\n\n\n\n\n\n' | sed 's/^[[:space:]]*//')
EOF

[ "$committing" = yes ] || exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 0

# Every path that differs from HEAD right now, against every path the last review
# covered. `comm -23` keeps the lines on the left that are absent on the right: a path
# nobody has reviewed, or one whose content has moved since they did.
#
# Only the left side is questioned, which is what lets one review cover several commits.
# Committing part of the tree drops those paths out of `git status` and so out of the
# left side; the lines it leaves behind still match the record, and the next commit goes
# through. A record holding paths that are no longer here is not stale, it is spent.
#
# A clean tree therefore has nothing to answer for, and an amend or an empty commit goes
# through on its own merits: there is no unreviewed work in a commit that carries none.
unreviewed=$(
  LC_ALL=C comm -23 \
    <("$here/review-manifest.sh" 2>/dev/null | LC_ALL=C sort) \
    <(LC_ALL=C sort "$root/.claude/review-state" 2>/dev/null)
)

[ -n "$unreviewed" ] || exit 0

listed=$(printf '%s\n' "$unreviewed" | cut -f2- | sed 's/^/    /')

reason="Work in this tree has not been reviewed, so the commit is on hold.

Not covered by the last review:

${listed}

Run the review first:

    Workflow({ name: \"review-changes\" })

It reads the uncommitted files through four lenses, attacks each finding before
trusting it, applies the ones that survive, drives every CRAP score to 10 or
below, and records what it read. Then commit again.

The findings do not have to come back empty — the gate asks only that a review
has run against what is about to be committed. A review covers the files it saw,
so committing them in several goes is fine; editing one afterwards puts it back
on the list above.

To commit without a review, lead the command with SKIP_REVIEW=1."

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
