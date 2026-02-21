import { formatCurrency } from "./price";
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
  currency: string;
  url: string;
  checkedAt: Date;
}): Promise<{ status: number; body: string }> {
  const message = buildDiscordMessage({
    itemId: input.itemId,
    productName: input.productName,
    oldPrice: formatCurrency(input.oldPriceCents, input.currency),
    newPrice: formatCurrency(input.newPriceCents, input.currency),
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
