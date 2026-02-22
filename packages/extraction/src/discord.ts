import { formatPrice } from "./price";
import type { NotificationPayload } from "./types";

export function buildDiscordMessage(payload: NotificationPayload): { content: string } {
  return {
    content: [
      "**Price Change Detected**",
      `Product: ${payload.productName}`,
      `Old Price: ${payload.oldPrice}`,
      `New Price: ${payload.newPrice}`,
      `Link: ${payload.url}`,
      `Checked: ${payload.checkedAt}`,
    ].join("\n"),
  };
}

export async function sendDiscordPriceChange(input: {
  webhookUrl: string;
  itemId: string;
  productName: string;
  oldPriceCents: number;
  newPriceCents: number;
  url: string;
  checkedAt: Date;
}): Promise<{ status: number; body: string }> {
  const message = buildDiscordMessage({
    itemId: input.itemId,
    productName: input.productName,
    oldPrice: formatPrice(input.oldPriceCents),
    newPrice: formatPrice(input.newPriceCents),
    url: input.url,
    checkedAt: input.checkedAt.toISOString(),
  });

  const response = await fetch(input.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(message),
  });

  const body = await response.text();
  return {
    status: response.status,
    body,
  };
}

export async function sendDiscordBackInStock(input: {
  webhookUrl: string;
  productName: string;
  url: string;
  checkedAt: Date;
  priceCents?: number | null;
}): Promise<{ status: number; body: string }> {
  const priceLine = typeof input.priceCents === "number" ? `Current Price: ${formatPrice(input.priceCents)}` : "Current Price: n/a";

  const response = await fetch(input.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content: [
        "**Back In Stock**",
        `Product: ${input.productName}`,
        priceLine,
        `Link: ${input.url}`,
        `Checked: ${input.checkedAt.toISOString()}`,
      ].join("\n"),
    }),
  });

  const body = await response.text();
  return {
    status: response.status,
    body,
  };
}
