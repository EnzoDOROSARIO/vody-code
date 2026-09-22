# vody-code

A coding agent: a terminal conversation with a model that can read, search, edit and
run things on your machine. This glossary fixes the words that mean something
particular here, so the code and the conversation about it stay in step.

## Language

### The conversation

**Turn**:
Everything that follows one thing you typed, up to the agent's final answer. A turn
may reach for tools many times before it ends.
_Avoid_: Round, exchange, iteration

**Request**:
What you typed to start the current Turn, exactly as you typed it. Every Turn has one;
outside any Turn there is none. Never the conversation around it, and never the
model's account of it — see ADR 0001.
_Avoid_: Question, prompt, input, message

**Activity**:
One thing the agent did on the way to an answer, reported as it happens. An Activity
is a report, never a rendering: what it looks like is the screen's business.
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
