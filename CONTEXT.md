# vody-code

A coding agent: a terminal conversation with a model that can read, search, edit and
run things on your machine. This glossary fixes the words that mean something
particular here, so the code and the conversation about it stay in step.

## Language

### The conversation

**Turn**:
Everything that follows one thing you typed, up to the agent's final answer, or up to
an Impasse if the Gates end it first, or a Breakdown if the model does. A turn may
reach for tools many times before it ends.
_Avoid_: Round, exchange, iteration

**Impasse**:
How a Turn ends when the Gates have refused so many acts, with none allowed in between,
that the loop stops sending the model back to try again. The Turn ends with no answer,
and the Impasse is its last Activity.
_Avoid_: Gate closed, stall, abort, giving up

**Breakdown**:
How a Turn ends when the model itself fails: the call to the provider broke, so there
is no answer and nothing to send back to. The Turn ends with no answer, and the
Breakdown is its last Activity, carrying the reason the call broke.
_Avoid_: Crash, error, failure, outage

**Request**:
What you typed to start the current Turn, exactly as you typed it. Every Turn has one;
outside any Turn there is none. Never the conversation around it, and never the
model's account of it — see ADR 0001.
_Avoid_: Question, prompt, input, message

**Activity**:
One thing that happened on the way to the end of a Turn, reported as it happens:
something the agent did, or the loop's own report of an Impasse or a Breakdown. An
Activity is a report, never a rendering: what it looks like is the screen's business.
_Avoid_: Event, message, update

**Workspace**:
Where the agent is working: the directory commands run in and relative paths resolve
against. Not a security boundary — see Perimeter.
_Avoid_: Working directory, project root, cwd

### Permission

**Perimeter**:
The git working tree the agent is allowed to change freely, excluding the repository's
own `.git` directory. Where there is no repository there is no Perimeter, and nothing
is inside.
_Avoid_: Sandbox, boundary, project root, workspace

**Containment**:
Whether a path lies inside the Perimeter, answered of the real path rather than the
written one, so a symbolic link cannot carry a change out of the tree.
_Avoid_: Path check, boundary check, escape check

**Gate**:
A place where an act is examined before it happens. There are two: writing outside the
Perimeter, and running a shell command.
_Avoid_: Check, guard, rule, policy

**Judge**:
The decision model a Gate consults. It answers fixed questions about an act with
probabilities; it never returns a Verdict, and it is never asked anything that can be
established without it.
_Avoid_: Classifier, validator, reviewer, model

**Verdict**:
What a Gate concludes about one act: allowed, or refused. Derived from the Judge's
answers, never stated by the Judge.
_Avoid_: Decision, result, judgement, permission
