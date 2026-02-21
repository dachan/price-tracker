const SYMBOL_TO_CURRENCY: Record<string, string> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};

export type ParsedPrice = {
  priceCents: number;
  currency?: string;
  rawNumber: number;
};

export function parsePriceFromText(input: string): ParsedPrice | null {
  const trimmed = input.replace(/\s+/g, " ").trim();
  const symbolMatch = trimmed.match(/[\$€£¥₹]/);
  const currency = symbolMatch ? SYMBOL_TO_CURRENCY[symbolMatch[0]] : undefined;

  const numberMatch = trimmed.match(/([0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{2})|[0-9]+(?:[.,][0-9]{2})?)/);
  if (!numberMatch) {
    return null;
  }

  const raw = numberMatch[1].replace(/\s/g, "");
  const decimalSeparator = detectDecimalSeparator(raw);
  const normalized = normalizeNumber(raw, decimalSeparator);
  const value = Number.parseFloat(normalized);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return {
    priceCents: Math.round(value * 100),
    currency,
    rawNumber: value,
  };
}

function detectDecimalSeparator(value: string): "." | "," | null {
  const dot = value.lastIndexOf(".");
  const comma = value.lastIndexOf(",");

  if (dot !== -1 && comma !== -1) {
    return dot > comma ? "." : ",";
  }

  if (comma !== -1) {
    const trailing = value.length - comma - 1;
    return trailing === 2 ? "," : null;
  }

  if (dot !== -1) {
    const trailing = value.length - dot - 1;
    return trailing === 2 ? "." : null;
  }

  return null;
}

function normalizeNumber(value: string, decimalSeparator: "." | "," | null): string {
  if (decimalSeparator === ".") {
    return value.replace(/,/g, "");
  }

  if (decimalSeparator === ",") {
    return value.replace(/\./g, "").replace(",", ".");
  }

  return value.replace(/[.,]/g, "");
}

export function formatCurrency(priceCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(priceCents / 100);
}
