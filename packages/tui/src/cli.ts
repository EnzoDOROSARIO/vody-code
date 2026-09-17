#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun";

import { main } from "./index.ts";

BunRuntime.runMain(main);
