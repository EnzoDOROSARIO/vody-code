import { Schema } from 'effect'

import type { Response } from 'effect/unstable/ai'

import { toolkit } from './tools/index.ts'

import type { Tools } from './tools/index.ts'

// A streamed tool call carries its arguments as the JSON the model sent, which the
// provider never type-checked. Parsing them back through the tool's own parameter
// schema is what makes them arguments again rather than an anonymous payload.
const callTo = <Name extends string, Params extends Schema.Top>(
  name: Name,
  params: Params,
): Schema.Struct<{
  readonly id: Schema.String
  readonly name: Schema.tag<Name>
  readonly params: Params
  readonly type: Schema.tag<'tool-call'>
}> =>
  Schema.Struct({
    id: Schema.String,
    name: Schema.tag(name),
    params,
    type: Schema.tag('tool-call'),
  })

export const ToolCall = Schema.Union([
  callTo('bash', toolkit.tools.bash.parametersSchema),
  callTo('edit_file', toolkit.tools.edit_file.parametersSchema),
  callTo('glob', toolkit.tools.glob.parametersSchema),
  callTo('read_file', toolkit.tools.read_file.parametersSchema),
  callTo('write_file', toolkit.tools.write_file.parametersSchema),
])

/** A tool the model reached for, with its arguments parsed back into the tool's own types. */
export type ToolCall = typeof ToolCall.Type

/** What that tool gave back, or the failure it returned instead. */
export type ToolResult = Response.ToolResultParts<Tools>

/** Why a tool returned nothing: its own error, the model's, or a call left unrun. */
export type ToolFailure = Extract<ToolResult, { readonly isFailure: true }>['result']

/**
 * A piece of what the agent is saying, handed on the moment the model writes it.
 *
 * The answer arrives in fragments, and the fragments sharing an `id` are one block of
 * prose. Passing them along one at a time is what lets a screen show the answer being
 * written; joining them back up is that screen's business, as the rest of the shape is.
 */
export type Reply = {
  readonly id: string
  readonly text: string
  readonly type: 'reply'
}

// One thing the agent did on the way to an answer. Every one of these is a report of
// what happened, never a rendering of it: the agent writes to no screen, and whoever
// is watching decides how, and whether, each is shown.
export type Activity = Reply | ToolCall | ToolResult
