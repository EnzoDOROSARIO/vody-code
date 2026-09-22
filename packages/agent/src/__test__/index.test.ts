import { expect, test } from 'bun:test'
import type { Response } from 'effect/unstable/ai'

import { asked } from './testing.ts'

import type { Activity } from '#activity.ts'
import type { Script } from './testing.ts'

const answered: Array<Response.StreamPartEncoded> = [
  { type: 'text-delta', id: 'text-1', delta: 'it printed ' },
  { type: 'text-delta', id: 'text-1', delta: 'hi' },
]

// A model that thinks aloud, reaches for a tool it has spelled correctly, and answers
// on the turn after.
const answering: Script = (turn) =>
  turn === 0
    ? [
        { type: 'text-delta', id: 'text-0', delta: 'let me look' },
        { type: 'tool-call', id: 'call-1', name: 'bash', params: { command: 'echo hi' } },
      ]
    : answered

// The same model with a `bash` call that carries no command, so the `ToolCall` union
// cannot decode it and the agent reports nothing for the call itself.
const misdialling: Script = (turn) =>
  turn === 0 ? [{ type: 'tool-call', id: 'call-1', name: 'bash', params: {} }] : answered

// A model whose stream carries the bookkeeping a real provider sends around the
// text: which response this is, and where the block of prose starts and ends.
const bookkeeping: Script = () => [
  { type: 'response-metadata', id: 'response-1', modelId: 'scripted' },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'hi' },
  { type: 'text-end', id: 'text-1' },
]

const asking = (...questions: ReadonlyArray<string>): Promise<Array<Activity>> =>
  asked(answering, questions)

test('the loop runs the tool the model asks for and reports what came back', async () => {
  const [, call, result] = await asking('say hi')

  expect(call).toMatchObject({
    name: 'bash',
    params: { command: 'echo hi' },
    type: 'tool-call',
  })
  expect(result).toMatchObject({ isFailure: false, name: 'bash', type: 'tool-result' })
})

// The answer is worth nothing on a screen if it only lands once the turn is over, so
// what the model wrote is handed on in the pieces it wrote them in, id and all. Two
// pieces of one block share an id; the sentence before a tool call is a block of its own.
test('the answer arrives in the fragments the model wrote, not in one piece', async () => {
  const replies = (await asking('say hi')).filter((activity) => activity.type === 'reply')

  expect(replies.map((reply) => reply.text)).toEqual(['let me look', 'it printed ', 'hi'])
  expect(replies.map((reply) => reply.id)).toEqual(['text-0', 'text-1', 'text-1'])
})

test('a bash call arrives typed, not as an anonymous payload', async () => {
  const [, call] = await asking('say hi')

  if (call?.type !== 'tool-call' || call.name !== 'bash') {
    throw new Error(`expected a bash call, got ${String(call?.type)}`)
  }

  // The annotation is the assertion. A streamed tool call carries its arguments as
  // `unknown`, and they are a command again only because the agent parses them back.
  const command: string = call.params.command

  expect(command).toBe('echo hi')
})

// Nothing is reported for a call the agent could not parse, which is why the flag that
// sends the loop round again is set from a tap of its own rather than from what the
// turn reported. The refusal and the answer after it are the proof the loop went round.
test('a call the agent could not parse still sends the loop round again', async () => {
  const activities = await asked(misdialling, ['say hi'])

  expect(activities.filter((activity) => activity.type === 'tool-call')).toEqual([])
  expect(activities.filter((activity) => activity.type === 'tool-result')).toMatchObject([
    { isFailure: true, name: 'bash', type: 'tool-result' },
  ])
  expect(activities.filter((activity) => activity.type === 'reply')).toEqual([
    { id: 'text-1', text: 'it printed ', type: 'reply' },
    { id: 'text-1', text: 'hi', type: 'reply' },
  ])
})

test('the loop stops on a turn with no tool call', async () => {
  const activities = await asking('say hi', 'and again')

  // Only the first turn of the first question took a tool. Every turn after it
  // answered in prose, and each of those ended the question that asked it: nothing
  // follows the last fragment of the second answer.
  expect(activities.filter((activity) => activity.type === 'tool-call')).toHaveLength(1)
  expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'hi', type: 'reply' })
})

// An Activity is something the agent did: a reply, a tool it reached for, what came
// back. The rest of what a provider streams is the model's own bookkeeping, and it
// is not reported, so a screen never has to know it exists.
test('only replies, tool calls and tool results are reported', async () => {
  expect(await asked(bookkeeping, ['say hi'])).toEqual([
    { id: 'text-1', text: 'hi', type: 'reply' },
  ])
})
