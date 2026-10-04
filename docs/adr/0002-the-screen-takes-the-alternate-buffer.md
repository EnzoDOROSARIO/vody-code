# The screen takes the alternate buffer

The Composer has to stay on the last rows for the whole of a session, including while
a Turn is in flight. That only holds if the app owns the viewport. The screen renders
in the terminal's alternate buffer — the one vim and less take — and the Transcript is
a viewport the app scrolls. The terminal's own scrollback is not available, and it is
not how you read. On the way out the previous screen is restored, and the conversation
is gone.

## Considered options

**Stay on the main screen and fill the height.** Rejected. A Transcript that grows is
still the terminal's to scroll, and the box at the bottom scrolls away with it. Filling
the window makes the app look fullscreen. It does not pin the Composer.

**Print the Transcript back into the main screen on exit.** Rejected. Nothing writes
the conversation down, and the session was never resumable. Printing it on the way out
is a second product: what to include, how wide, and whether an exit that crashed still
manages it. Pi can do this. We do not.

**Scroll with keys as well as the wheel.** Rejected. The wheel is the scroll, including
while the Composer is Locked. Page Up, Page Down, Home, End and the arrows do not move
the Transcript. A reader who adds them has undone this.

## Consequences

**Leaving looks like the conversation was deleted.** It was never kept. Restoring the
previous screen is the exit, not a failure to save.

**A terminal that sends no wheel events cannot move the Transcript.** There is no key
to fall back on. That is the cost of the wheel being the only scroll.

**Mouse tracking is on, so the wheel can be read.** Click-drag selection is no longer
the terminal's, except where a terminal still offers it with a modifier. We do not
draw a selection of our own.

**Ctrl+C leaves.** It does not cancel the Turn and hand back a scrollback you can
read. The alternate buffer is discarded with the process.
