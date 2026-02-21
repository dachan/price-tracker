import { describe, expect, it } from "vitest";

import { parsePriceFromText } from "../price";

describe("parsePriceFromText", () => {
  it("parses USD price with commas", () => {
    const parsed = parsePriceFromText("$1,299.99");
    expect(parsed).toMatchObject({ priceCents: 129999, currency: "USD" });
  });

  it("parses European decimal format", () => {
    const parsed = parsePriceFromText("1.299,50 €");
    expect(parsed).toMatchObject({ priceCents: 129950, currency: "EUR" });
  });

  it("returns null for invalid text", () => {
    expect(parsePriceFromText("contact for price")).toBeNull();
  });
});
