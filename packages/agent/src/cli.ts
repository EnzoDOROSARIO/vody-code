#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Effect, Layer } from 'effect'

import { layer, main } from './index.ts'

// oxlint-disable-next-line effecttsgo/strict-effect-provide -- this is the entry point
BunRuntime.runMain(main.pipe(Effect.provide(layer.pipe(Layer.provideMerge(BunServices.layer)))))
