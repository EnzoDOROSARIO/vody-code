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
something the agent did, or the loop's own report: a Reminder, an Impasse or a
Breakdown. An Activity is a report, never a rendering: what it looks like is the
screen's business.
_Avoid_: Event, message, update

**Workspace**:
Where the agent is working: the directory commands run in and relative paths resolve
against. Not a security boundary — see Perimeter.
_Avoid_: Working directory, project root, cwd

### The plan

**Plan**:
The Steps the agent has set itself for the work in hand, as it last wrote them. There
is one for the whole conversation, and it outlives the Turn that wrote it.
_Avoid_: Todo list, task list, checklist, plan mode

**Step**:
One piece of the work in the Plan, and how far along it is: pending, in progress, or
completed. A Step dropped from the work is not completed; it is left out of the Plan.
_Avoid_: Todo, task, item

**Reminder**:
The Plan as it stands, said to the model by the loop rather than by you, when the model
wrote the Plan earlier in this Turn and has gone on working without writing it again
while Steps remain to finish. There is at most one for each write. It is never a
Request.
_Avoid_: Nag, nudge, prompt

### Skills

**Skill**:
A folder of instructions for one kind of work, named and described by the SKILL.md at
its top, kept in the Workspace or in your home directory. When both hold a Skill of the
same name, the Workspace's is the one the agent knows; the other does not exist for it.
What a Skill says is never a Request — see ADR 0001.
_Avoid_: Plugin, command, recipe, playbook

**Catalog**:
Every Skill the agent may load, read once at startup: its name, description, body and
folder, told to the model as the session begins and unchanged until it ends. A Skill its
author kept for you alone to call is never in it.
_Avoid_: Index, registry, skill list, manifest

### The screen

**Composer**:
The framed one-line box pinned to the bottom of the screen, holding the draft of the next Request.
_Avoid_: Prompt, input, editor, text box

**Draft**:
Text in the Composer that has not been submitted. It is not a Request, and it is not part of the conversation.
_Avoid_: Buffer, input, prompt

**Locked**:
The Composer for the whole of a Turn: still there, but not a place the draft can change.
_Avoid_: Disabled, busy, readonly

**Transcript**:
The screen's record of the conversation: each Request as typed, and each Activity the screen shows, in the order reported.
_Avoid_: Log, history, chat

**Following**:
The Transcript pinned to its latest line.
_Avoid_: Tail, auto-scroll, stick

**Held**:
The Transcript scrolled off its latest line, so the lines in view stay put.
_Avoid_: Detached, frozen, stuck

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
A place where an act is examined before it happens. There are two: writing a file
outside the Perimeter, and running a shell command.
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
