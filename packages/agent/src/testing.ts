import { BunServices } from '@effect/platform-bun'
import { Layer } from 'effect'
import { TestConsole } from 'effect/testing'

import { toolkitLayer } from './tools/index.ts'
import { Workspace } from './workspace.ts'

import type { Handlers } from './tools/index.ts'

export const services = (
  workspace: string,
): Layer.Layer<BunServices.BunServices | Handlers | TestConsole.TestConsole> =>
  Layer.mergeAll(toolkitLayer, TestConsole.layer).pipe(
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(Layer.succeed(Workspace, workspace)),
  )
