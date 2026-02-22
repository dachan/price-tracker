export type ExtractionMethod = "shopify_json" | "static" | "playwright" | "ai";

export type StockState = "IN_STOCK" | "OUT_OF_STOCK" | "PARTIAL" | "UNKNOWN";

export type VariantStock = {
  label: string;
  inStock: boolean | null;
  source?: string;
};

export type ExtractEvidence = {
  pageTitle?: string;
  metaDescription?: string;
  candidates: string[];
  sourceUrl: string;
  stockState?: StockState;
  variantStock?: VariantStock[];
};

export type ExtractResult = {
  productName: string;
  priceCents: number | null;
  inStock: boolean | null;
  stockState: StockState;
  variantStock: VariantStock[];
  confidence: number;
  method: ExtractionMethod;
  evidence: ExtractEvidence;
  contentHash: string;
};

export type ExtractionAttempt = {
  status: "success" | "needs_review";
  result?: ExtractResult;
  reason?: string;
  usedPlaywright: boolean;
  usedAi: boolean;
  tokenInput?: number;
  tokenOutput?: number;
  estimatedCostUsd?: number;
};

export type CheckResult = {
  itemId: string;
  snapshotId?: string;
  changed: boolean;
  oldPriceCents?: number | null;
  newPriceCents?: number | null;
  inStock?: boolean | null;
  stockState?: StockState;
  status: "SUCCESS" | "FAILED" | "NEEDS_REVIEW";
  reason?: string;
};

export type NotificationPayload = {
  itemId: string;
  productName: string;
  oldPrice: string;
  newPrice: string;
  url: string;
  checkedAt: string;
};
