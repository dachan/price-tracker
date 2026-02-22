import { Prisma } from "@prisma/client";
import pLimit from "p-limit";

import { prisma } from "@price-tracker/db";

import { sendDiscordBackInStock, sendDiscordPriceChange } from "./discord";
import { extractProductFromUrl } from "./extract";
import { normalizeTrackedUrl } from "./url";
import type { CheckResult } from "./types";

type CreateItemInput = {
  url: string;
};

type ServiceDependencies = {
  db?: typeof prisma;
  extractor?: typeof extractProductFromUrl;
  priceChangeNotifier?: typeof sendDiscordPriceChange;
  backInStockNotifier?: typeof sendDiscordBackInStock;
};

export class PriceTrackerService {
  private db: typeof prisma;
  private extractor: typeof extractProductFromUrl;
  private priceChangeNotifier: typeof sendDiscordPriceChange;
  private backInStockNotifier: typeof sendDiscordBackInStock;

  constructor(deps: ServiceDependencies = {}) {
    this.db = deps.db ?? prisma;
    this.extractor = deps.extractor ?? extractProductFromUrl;
    this.priceChangeNotifier = deps.priceChangeNotifier ?? sendDiscordPriceChange;
    this.backInStockNotifier = deps.backInStockNotifier ?? sendDiscordBackInStock;
  }

  async createItem(input: CreateItemInput): Promise<{ itemId: string; created: boolean; initialCheck?: CheckResult }> {
    const normalizedUrl = normalizeTrackedUrl(input.url);
    const host = new URL(normalizedUrl).host;

    const existing = await this.db.trackedItem.findFirst({
      where: {
        canonicalUrl: normalizedUrl,
        active: true,
      },
      select: {
        id: true,
      },
    });

    if (existing) {
      return { itemId: existing.id, created: false };
    }

    const created = await this.db.trackedItem.create({
      data: {
        url: input.url,
        canonicalUrl: normalizedUrl,
        siteHost: host,
      },
      select: {
        id: true,
      },
    });

    const initialCheck = await this.runCheckForItem(created.id);

    return {
      itemId: created.id,
      created: true,
      initialCheck,
    };
  }

  async listItems() {
    const items = await this.db.trackedItem.findMany({
      where: {
        active: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        snapshots: {
          orderBy: {
            checkedAt: "desc",
          },
          take: 20,
        },
        checkRuns: {
          orderBy: {
            startedAt: "desc",
          },
          take: 1,
        },
      },
    });

    return items.map((item) => {
      const lastPriceChange = findLastPriceChange(item.snapshots);
      return {
        ...item,
        snapshots: item.snapshots.slice(0, 1),
        lastPriceChange,
      };
    });
  }

  async getItemDetails(id: string) {
    return this.db.trackedItem.findFirst({
      where: {
        id,
      },
      include: {
        snapshots: {
          orderBy: {
            checkedAt: "desc",
          },
          take: 30,
        },
        checkRuns: {
          orderBy: {
            startedAt: "desc",
          },
          take: 30,
        },
        notifications: {
          orderBy: {
            sentAt: "desc",
          },
          take: 30,
        },
      },
    });
  }

  async deleteItem(id: string) {
    await this.db.trackedItem.update({
      where: {
        id,
      },
      data: {
        active: false,
      },
    });
  }

  async runCheckForItem(itemId: string): Promise<CheckResult> {
    const item = await this.db.trackedItem.findFirst({
      where: {
        id: itemId,
        active: true,
      },
    });

    if (!item) {
      throw new Error("Tracked item not found");
    }

    const checkRun = await this.db.checkRun.create({
      data: {
        itemId: item.id,
        status: "FAILED",
      },
    });

    try {
      const remainingAiBudget = await this.getRemainingAiBudgetUsd();
      const allowPlaywright = process.env.ENABLE_PLAYWRIGHT !== "false";
      const aiHints = await this.getAiHintsForHost(item.siteHost, item.id);
      const extraction = await this.extractor(item.url, {
        allowAi: remainingAiBudget > 0,
        allowPlaywright,
        aiHints,
      });

      if (extraction.status !== "success" || !extraction.result) {
        const needsReview =
          extraction.reason?.includes("AI_BUDGET") ||
          extraction.reason?.includes("LOW_CONFIDENCE") ||
          extraction.reason?.includes("REGIONAL_REDIRECT") ||
          extraction.reason?.includes("REDIRECT_BLOCKED");

        await this.db.checkRun.update({
          where: {
            id: checkRun.id,
          },
          data: {
            status: needsReview ? "NEEDS_REVIEW" : "FAILED",
            errorCode: extraction.reason ?? "UNKNOWN_EXTRACTION_ERROR",
            errorMessage: `Extraction failed for ${item.url}`,
            usedPlaywright: extraction.usedPlaywright,
            usedAi: extraction.usedAi,
            tokenInput: extraction.tokenInput,
            tokenOutput: extraction.tokenOutput,
            estimatedCostUsd: extraction.estimatedCostUsd,
            finishedAt: new Date(),
          },
        });

        return {
          itemId: item.id,
          changed: false,
          status: needsReview ? "NEEDS_REVIEW" : "FAILED",
          reason: extraction.reason,
        };
      }

      const latestSnapshot = await this.db.priceSnapshot.findFirst({
        where: {
          itemId: item.id,
        },
        orderBy: {
          checkedAt: "desc",
        },
      });

      const snapshot = await this.db.priceSnapshot.create({
        data: {
          itemId: item.id,
          productName: extraction.result.productName,
          priceCents: extraction.result.priceCents,
          inStock: extraction.result.inStock,
          stockState: extraction.result.stockState,
          extractionMethod: extraction.result.method,
          confidence: extraction.result.confidence,
          evidenceJson: extraction.result.evidence,
          contentHash: extraction.result.contentHash,
        },
      });

      const changed = didPriceChange(latestSnapshot?.priceCents, snapshot.priceCents);

      if (changed && latestSnapshot && typeof latestSnapshot.priceCents === "number" && typeof snapshot.priceCents === "number") {
        await this.sendPriceChangeNotification({
          itemId: item.id,
          snapshotId: snapshot.id,
          url: item.url,
          productName: snapshot.productName,
          oldPriceCents: latestSnapshot.priceCents,
          newPriceCents: snapshot.priceCents,
          checkedAt: snapshot.checkedAt,
        });
      }

      if (latestSnapshot?.inStock === false && snapshot.inStock === true) {
        await this.sendBackInStockNotification({
          itemId: item.id,
          snapshotId: snapshot.id,
          url: item.url,
          productName: snapshot.productName,
          priceCents: snapshot.priceCents,
          checkedAt: snapshot.checkedAt,
        });
      }

      await this.db.checkRun.update({
        where: {
          id: checkRun.id,
        },
        data: {
          status: "SUCCESS",
          usedPlaywright: extraction.usedPlaywright,
          usedAi: extraction.usedAi,
          tokenInput: extraction.tokenInput,
          tokenOutput: extraction.tokenOutput,
          estimatedCostUsd: extraction.estimatedCostUsd,
          finishedAt: new Date(),
        },
      });

      return {
        itemId: item.id,
        snapshotId: snapshot.id,
        changed,
        oldPriceCents: latestSnapshot?.priceCents,
        newPriceCents: snapshot.priceCents,
        inStock: snapshot.inStock,
        stockState: extraction.result.stockState,
        status: "SUCCESS",
      };
    } catch (error) {
      await this.db.checkRun.update({
        where: {
          id: checkRun.id,
        },
        data: {
          status: "FAILED",
          errorCode: "CHECK_RUN_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        },
      });

      return {
        itemId: item.id,
        changed: false,
        status: "FAILED",
        reason: error instanceof Error ? error.message : "Unexpected error",
      };
    }
  }

  async runDailyChecks() {
    const items = await this.db.trackedItem.findMany({
      where: {
        active: true,
      },
      orderBy: {
        createdAt: "asc",
      },
      take: 200,
      select: {
        id: true,
      },
    });

    const limit = pLimit(3);

    for (const batch of chunk(items, 25)) {
      await Promise.all(batch.map((item) => limit(() => this.runCheckForItem(item.id))));
    }
  }

  async sendDiscordTestMessage() {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      throw new Error("DISCORD_WEBHOOK_URL is not configured");
    }

    return this.priceChangeNotifier({
      webhookUrl,
      itemId: "test-item",
      productName: "Price Tracker test notification",
      oldPriceCents: 10000,
      newPriceCents: 9500,
      url: "https://example.com/product",
      checkedAt: new Date(),
    });
  }

  private async sendPriceChangeNotification(input: {
    itemId: string;
    snapshotId: string;
    url: string;
    productName: string;
    oldPriceCents: number;
    newPriceCents: number;
    checkedAt: Date;
  }) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

    try {
      await this.db.notification.create({
        data: {
          itemId: input.itemId,
          snapshotId: input.snapshotId,
          eventType: "PRICE_CHANGED",
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return;
      }
      throw error;
    }

    if (!webhookUrl) {
      await this.db.notification.updateMany({
        where: {
          itemId: input.itemId,
          snapshotId: input.snapshotId,
          eventType: "PRICE_CHANGED",
        },
        data: {
          webhookStatus: 0,
          webhookResponse: "DISCORD_WEBHOOK_URL not configured",
          sentAt: new Date(),
        },
      });
      return;
    }

    const response = await this.priceChangeNotifier({
      webhookUrl,
      itemId: input.itemId,
      productName: input.productName,
      oldPriceCents: input.oldPriceCents,
      newPriceCents: input.newPriceCents,
      url: input.url,
      checkedAt: input.checkedAt,
    });

    await this.db.notification.updateMany({
      where: {
        itemId: input.itemId,
        snapshotId: input.snapshotId,
        eventType: "PRICE_CHANGED",
      },
      data: {
        webhookStatus: response.status,
        webhookResponse: response.body.slice(0, 1000),
        sentAt: new Date(),
      },
    });
  }

  private async sendBackInStockNotification(input: {
    itemId: string;
    snapshotId: string;
    url: string;
    productName: string;
    priceCents: number | null;
    checkedAt: Date;
  }) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

    try {
      await this.db.notification.create({
        data: {
          itemId: input.itemId,
          snapshotId: input.snapshotId,
          eventType: "BACK_IN_STOCK",
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return;
      }
      throw error;
    }

    if (!webhookUrl) {
      await this.db.notification.updateMany({
        where: {
          itemId: input.itemId,
          snapshotId: input.snapshotId,
          eventType: "BACK_IN_STOCK",
        },
        data: {
          webhookStatus: 0,
          webhookResponse: "DISCORD_WEBHOOK_URL not configured",
          sentAt: new Date(),
        },
      });
      return;
    }

    const response = await this.backInStockNotifier({
      webhookUrl,
      productName: input.productName,
      url: input.url,
      checkedAt: input.checkedAt,
      priceCents: input.priceCents,
    });

    await this.db.notification.updateMany({
      where: {
        itemId: input.itemId,
        snapshotId: input.snapshotId,
        eventType: "BACK_IN_STOCK",
      },
      data: {
        webhookStatus: response.status,
        webhookResponse: response.body.slice(0, 1000),
        sentAt: new Date(),
      },
    });
  }

  private async getRemainingAiBudgetUsd(): Promise<number> {
    const dailyBudgetUsd = Number.parseFloat(process.env.AI_DAILY_BUDGET_USD ?? "1.00");
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const aggregate = await this.db.checkRun.aggregate({
      where: {
        startedAt: {
          gte: startOfDay,
        },
        usedAi: true,
      },
      _sum: {
        estimatedCostUsd: true,
      },
    });

    const spent = Number(aggregate._sum.estimatedCostUsd ?? 0);
    return Math.max(0, dailyBudgetUsd - spent);
  }

  private async getAiHintsForHost(siteHost: string, currentItemId: string): Promise<string[]> {
    if (!siteHost || typeof this.db.priceSnapshot?.findMany !== "function") {
      return [];
    }

    const priorSnapshots = await this.db.priceSnapshot.findMany({
      where: {
        item: {
          siteHost,
          active: true,
          id: {
            not: currentItemId,
          },
        },
      },
      orderBy: {
        checkedAt: "desc",
      },
      take: 4,
      select: {
        productName: true,
        priceCents: true,
        inStock: true,
        stockState: true,
      },
    });

    return priorSnapshots.map((snapshot) => {
      const price = typeof snapshot.priceCents === "number" ? (snapshot.priceCents / 100).toFixed(2) : "n/a";
      const stock = snapshot.stockState ?? (snapshot.inStock === true ? "IN_STOCK" : snapshot.inStock === false ? "OUT_OF_STOCK" : "UNKNOWN");
      return `${snapshot.productName} | price=${price} | stock=${stock}`;
    });
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

export function didPriceChange(previousPriceCents: number | null | undefined, currentPriceCents: number | null | undefined): boolean {
  if (typeof previousPriceCents !== "number" || typeof currentPriceCents !== "number") {
    return false;
  }
  return previousPriceCents !== currentPriceCents;
}

function findLastPriceChange(
  snapshots: Array<{ priceCents: number | null; checkedAt: Date }>,
): { fromPriceCents: number; toPriceCents: number; changedAt: Date } | null {
  for (let i = 0; i < snapshots.length - 1; i += 1) {
    const current = snapshots[i];
    const previous = snapshots[i + 1];

    if (
      typeof current.priceCents === "number" &&
      typeof previous.priceCents === "number" &&
      current.priceCents !== previous.priceCents
    ) {
      return {
        fromPriceCents: previous.priceCents,
        toPriceCents: current.priceCents,
        changedAt: current.checkedAt,
      };
    }
  }

  return null;
}
