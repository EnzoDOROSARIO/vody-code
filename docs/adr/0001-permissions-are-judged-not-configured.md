# Permissions are judged, not configured

The agent can write anywhere and run any shell command, so something has to stand
between it and the machine. Rather than a list of allowed and denied patterns that a
user maintains, every write outside the Perimeter and every shell command is put to a
decision model — the Judge — which answers fixed questions about the act, and a Verdict
is derived from its answers. There are no modes, no configuration, no override and no
human confirmation: the system either allows the act or refuses it.

## Considered options

**A deny list, as most agents have.** Rejected because it is an arms race that cannot
be won by string matching: `r''m -rf /`, `$IFS`, a base64'd `eval`, or three lines of
Python all walk past any pattern set, while the list simultaneously refuses routine
work that happens to contain a dangerous-looking word. Its real value is determinism
and saved round trips, neither of which we need once the Judge is a startup
requirement.

**Asking the human, as the reference designs do.** Deferred rather than rejected. The
Verdict type has room for a third `ask` arm, but the band where it pays off is the
uncertain middle, and calibrating that middle is the hard part. Building the
bidirectional channel it needs — a suspended turn, a pending-approval state, input
accepted while the agent is busy — before the judgement is any good would mean
debugging both at once.

**Judging each clause of a compound command separately.** Rejected: splitting destroys
the context that makes `rm -rf node_modules && bun install` obviously routine, and
doing it correctly needs a shell parser, since quotes, subshells and heredocs have no
operator to split on.

## Consequences

**A refusal is final.** No mode to rerun under, no flag, no confirmation prompt. A
badly calibrated threshold is not an annoyance the user can work around; it is the
agent declining to do its job. This is why a refusal names the axes that tripped it
and their probabilities — it is the only diagnostic surface the system has.

**No Judge, no agent.** Credentials are required for the layer to build, and a Judge
that times out or is rejected refuses the act rather than waving it through. A gate
that opens when the network dies is not a gate; the price is that a missing key stops
the agent doing anything gated.

**Latency on every shell command.** A network round trip sits on the critical path of
every command the agent runs, and nothing is cached, so a command run twice is judged
twice.

**The Judge must never be asked what we can compute.** Anything with a locally
available answer — whether a file exists, whether a path is inside the Perimeter,
whether it sits in another repository — is supplied to the Judge as fact. Asking it
instead attaches a probability to something that had a correct answer.

**The Judge sees the human's request, never the conversation.** The request is the only
input authored by a person. Feeding the Judge the conversation would let text the agent
read from a file argue its own case, which would make the second opinion the same
opinion twice.
