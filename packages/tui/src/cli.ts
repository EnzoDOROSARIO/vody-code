#!/usr/bin/env node
import { layer, Workspace } from 'agent'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { main } from './index.tsx'

// The composition root: the one place that decides where the agent works, and the only
// place the process's current directory is read.
NodeRuntime.runMain(
  main.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this is the entry point
    Effect.provide(
      layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(Layer.succeed(Workspace, process.cwd())),
      ),
    ),
  ),
)
