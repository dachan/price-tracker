import { describe, expect, it, vi } from "vitest";

import { PriceTrackerService } from "../check-service";

function makeFakeDb() {
  const notificationCreate = vi.fn().mockResolvedValue({ id: "notif-1" });
  const notificationUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

  const checkRunCreate = vi.fn().mockResolvedValue({ id: "check-1" });
  const checkRunUpdate = vi.fn().mockResolvedValue({ id: "check-1" });
  const checkRunAggregate = vi.fn().mockResolvedValue({ _sum: { estimatedCostUsd: 0 } });

  const priceSnapshotFindFirst = vi.fn().mockResolvedValue({ id: "snap-prev", priceCents: 10000, inStock: true });
  const priceSnapshotCreate = vi.fn().mockResolvedValue({
    id: "snap-new",
    priceCents: 9500,
    inStock: true,
    stockState: "IN_STOCK",
    productName: "Widget",
    checkedAt: new Date("2026-02-21T12:00:00.000Z"),
  });

  const trackedItemFindFirst = vi.fn().mockResolvedValue({
    id: "item-1",
    url: "https://example.com/widget",
    active: true,
  });

  return {
    trackedItem: {
      findFirst: trackedItemFindFirst,
    },
    checkRun: {
      create: checkRunCreate,
      update: checkRunUpdate,
      aggregate: checkRunAggregate,
    },
    priceSnapshot: {
      findFirst: priceSnapshotFindFirst,
      create: priceSnapshotCreate,
    },
    notification: {
      create: notificationCreate,
      updateMany: notificationUpdateMany,
    },
    __mocks: {
      trackedItemFindFirst,
      checkRunCreate,
      checkRunUpdate,
      checkRunAggregate,
      priceSnapshotFindFirst,
      priceSnapshotCreate,
      notificationCreate,
      notificationUpdateMany,
    },
  };
}

describe("PriceTrackerService integration", () => {
  it("persists snapshot and sends notification on price change", async () => {
    const db = makeFakeDb();

    const extractor = vi.fn().mockResolvedValue({
      status: "success",
      usedPlaywright: false,
      usedAi: false,
      result: {
        productName: "Widget",
        priceCents: 9500,
        inStock: true,
        stockState: "IN_STOCK",
        variantStock: [],
        confidence: 0.91,
        method: "static",
        evidence: {
          sourceUrl: "https://example.com/widget",
          candidates: ["jsonld"],
        },
        contentHash: "abc123",
      },
    });

    const notifier = vi.fn().mockResolvedValue({ status: 204, body: "" });

    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/test";

    const service = new PriceTrackerService({
      db: db as any,
      extractor,
      priceChangeNotifier: notifier,
      backInStockNotifier: vi.fn(),
    });

    const result = await service.runCheckForItem("item-1");

    expect(result.status).toBe("SUCCESS");
    expect(result.changed).toBe(true);
    expect(db.__mocks.priceSnapshotCreate).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it("marks run as needs review when AI budget is exhausted", async () => {
    const db = makeFakeDb();
    db.checkRun.aggregate = vi.fn().mockResolvedValue({ _sum: { estimatedCostUsd: 1.0 } });

    const extractor = vi.fn().mockResolvedValue({
      status: "needs_review",
      reason: "AI_BUDGET_EXCEEDED_OR_DISABLED",
      usedPlaywright: false,
      usedAi: false,
    });

    process.env.AI_DAILY_BUDGET_USD = "1.00";

    const service = new PriceTrackerService({
      db: db as any,
      extractor,
      priceChangeNotifier: vi.fn(),
      backInStockNotifier: vi.fn(),
    });

    const result = await service.runCheckForItem("item-1");

    expect(result.status).toBe("NEEDS_REVIEW");
    expect(db.__mocks.priceSnapshotCreate).toHaveBeenCalledTimes(0);
    expect(db.__mocks.checkRunUpdate).toHaveBeenCalled();
  });

  it("sends back in stock notification when stock flips from false to true", async () => {
    const db = makeFakeDb();
    db.priceSnapshot.findFirst = vi.fn().mockResolvedValue({ id: "snap-prev", priceCents: null, inStock: false });
    db.priceSnapshot.create = vi.fn().mockResolvedValue({
      id: "snap-new",
      priceCents: 14999,
      inStock: true,
      stockState: "IN_STOCK",
      productName: "Widget",
      checkedAt: new Date("2026-02-21T12:10:00.000Z"),
    });

    const extractor = vi.fn().mockResolvedValue({
      status: "success",
      usedPlaywright: false,
      usedAi: false,
      result: {
        productName: "Widget",
        priceCents: 14999,
        inStock: true,
        stockState: "IN_STOCK",
        variantStock: [],
        confidence: 0.91,
        method: "static",
        evidence: {
          sourceUrl: "https://example.com/widget",
          candidates: ["jsonld"],
        },
        contentHash: "abc123",
      },
    });

    const priceChangeNotifier = vi.fn().mockResolvedValue({ status: 204, body: "" });
    const backInStockNotifier = vi.fn().mockResolvedValue({ status: 204, body: "" });

    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/test";

    const service = new PriceTrackerService({
      db: db as any,
      extractor,
      priceChangeNotifier,
      backInStockNotifier,
    });

    const result = await service.runCheckForItem("item-1");

    expect(result.status).toBe("SUCCESS");
    expect(result.inStock).toBe(true);
    expect(backInStockNotifier).toHaveBeenCalledTimes(1);
  });
});
