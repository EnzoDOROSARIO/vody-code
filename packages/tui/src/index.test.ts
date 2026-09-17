import { describe, expect, it } from "bun:test";

import { banner } from "./index.ts";

describe("banner", () => {
  it("includes the version", () => {
    expect(banner("0.0.0")).toBe("vody-code tui v0.0.0");
  });
});
