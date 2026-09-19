# agent

The whole secret of a coding agent, in one loop:

```
send the conversation -> model answers
  -> it called a tool?  run it, append the result, send again
  -> it called nothing? that is the answer
```

One tool (`bash`) and that loop are enough to make a model act on the world. Everything a
larger agent adds — permissions, hooks, richer tools, lifecycle — is built around this loop,
not inside it.

Here the loop is `src/index.ts`. Effect AI's `Chat` keeps the conversation history and runs
the tool handlers, so the loop itself is the `while` that decides whether to go around again.

## Run it

The model is Codex, reached with your ChatGPT subscription. Sign in once with the Codex CLI,
which owns the credentials and refreshes them — this repo only reads them:

```sh
codex login
bun run agent   # from the repo root
```

Ask it something, press Enter, and watch the `$ ` lines: those are the commands the model
chose to run. Ctrl+C quits.

Try:

1. `Create a file called hello.ts that prints "Hello, World!"`
2. `List all TypeScript files in this directory`
3. `What is the current git branch?`

Watch for when the model calls a tool — the loop goes around — and when it doesn't, which is
where the loop stops.

> The agent runs shell commands the model wrote, with no permission prompt and no sandbox.
> Run it somewhere you don't mind it touching.

## Where Codex fits

`src/codex.ts` reads the token the Codex CLI stored and puts the model behind Effect AI's
`LanguageModel`, so the loop above never learns that its model is authenticated by a
subscription. Inference posts to the ChatGPT Codex Responses endpoint, which OpenAI does not
document — the file says why, and why there is no supported alternative.

Adapted from [learn-claude-code s01](https://github.com/shareAI-lab/learn-claude-code/blob/main/s01_agent_loop/README.md),
with Effect AI in place of a direct SDK call.
