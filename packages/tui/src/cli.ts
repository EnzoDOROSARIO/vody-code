#!/usr/bin/env bun
import pkg from "../package.json";

import { banner } from "./index.ts";

console.log(banner(pkg.version));
