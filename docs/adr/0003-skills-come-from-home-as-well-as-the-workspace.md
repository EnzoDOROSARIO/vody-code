# Skills come from home as well as the Workspace

The workspace's instructions are read from the Workspace alone: walking up to the
repository root, or out to the home directory, would hand the agent instructions written
for somewhere else and leave it unable to say which of them it was following. Skills are
read from two places all the same — the Workspace's `.agents/skills/` and the home
directory's `~/.agents/skills/` — because that reason does not reach them. A Skill names
itself in the Catalog and is loaded on purpose, by name, so the agent can always say
which one it is following and where it came from. And the Skills a person keeps are
theirs, not any project's: confining them to the Workspace would mean copying each one
into every repository it is wanted in.

## Considered options

**The Workspace alone, as instructions are.** Rejected: it keeps one rule for everything
read at startup, but it strands the Skills a person writes for their own way of working,
and the rule it would be keeping exists for a worry Skills do not raise.

**Also `.claude/skills/`, as `CLAUDE.md` is also read.** Rejected: that folder is commonly
symlinks into `.agents/skills/`, so it would mostly be the same Skills read twice, and a
second spelling of the same place adds collisions without adding Skills.

## Consequences

**The Workspace's Skill wins.** Two places can hold a Skill of the same name, and the model
must never be left to guess which `tdd` was meant. The Workspace's was written for this
project, so it is the one in the Catalog; the home one does not exist for the agent while
it works there. Nothing on the screen says that one was hidden.

**A broken personal Skill stops every session.** A SKILL.md that cannot be read, will not
parse, or does not name and describe itself as its folder does stops the session, as
unreadable instructions do — and a broken Skill in the home directory is in every
Workspace's Catalog. The message names the file; the fix is one edit. Starting without it
would be a Skill silently missing, which neither the model nor whoever asked would know.

**Skills carry no authority.** A Workspace Skill is written by whoever wrote the
repository. What a Skill says is never a Request, so every act it leads to is judged
against what was typed alone — ADR 0001, unchanged.
