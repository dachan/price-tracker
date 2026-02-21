import { describe, expect, it } from "vitest";

import { buildDiscordMessage } from "../discord";

describe("buildDiscordMessage", () => {
  it("builds a message with key fields", () => {
    const payload = buildDiscordMessage({
      itemId: "item-1",
      productName: "Widget Pro",
      oldPrice: "$59.99",
      newPrice: "$49.99",
      url: "https://example.com/widget-pro",
      checkedAt: "2026-02-21T10:00:00.000Z",
    });

    expect(payload.content).toContain("Price Change Detected");
    expect(payload.content).toContain("Widget Pro");
    expect(payload.content).toContain("$49.99");
    expect(payload.content).toContain("https://example.com/widget-pro");
  });
});
