import { describe, expect, it } from "vitest";

import { didPriceChange } from "../check-service";

describe("didPriceChange", () => {
  it("returns false with no previous value", () => {
    expect(didPriceChange(undefined, 1000)).toBe(false);
  });

  it("returns false when values are equal", () => {
    expect(didPriceChange(1000, 1000)).toBe(false);
  });

  it("returns true when values differ", () => {
    expect(didPriceChange(1000, 950)).toBe(true);
  });
});
