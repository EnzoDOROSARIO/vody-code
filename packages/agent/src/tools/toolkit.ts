import { Toolkit } from 'effect/unstable/ai'

import type { Tool } from 'effect/unstable/ai'

import * as Bash from './bash.ts'
import * as EditFile from './edit-file.ts'
import * as Glob from './glob.ts'
import * as ReadFile from './read-file.ts'
import * as WriteFile from './write-file.ts'

export const toolkit = Toolkit.merge(
  Bash.toolkit,
  EditFile.toolkit,
  Glob.toolkit,
  ReadFile.toolkit,
  WriteFile.toolkit,
)

export type Tools = (typeof toolkit)['tools']

/**
 * One tool being called: which one, and its arguments in that tool's own types.
 *
 * This is what the transcript's `ToolCall` carries once its framing — the call's id
 * and its kind — is set aside. A handler is not always told the id, so what runs
 * before it is handed exactly what it can be told, rather than an id made up.
 *
 * Built one tool at a time and then joined, so that over several tools it is a
 * discriminated union: checking `name` narrows `params` to that tool's arguments,
 * rather than leaving them the arguments of any tool at all.
 */
export type Call<Name extends keyof Tools = keyof Tools> = {
  [N in Name]: { readonly name: N; readonly params: Tool.Parameters<Tools[N]> }
}[Name]
