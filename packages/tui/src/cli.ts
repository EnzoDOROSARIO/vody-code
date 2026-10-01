#!/usr/bin/env node
import { layer } from 'agent'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { main } from './index.tsx'

// oxlint-disable-next-line effecttsgo/strict-effect-provide -- this is the entry point
NodeRuntime.runMain(main.pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))))
