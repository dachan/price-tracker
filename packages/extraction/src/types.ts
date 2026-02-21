export type ExtractionMethod = "static" | "playwright" | "ai";

export type ExtractEvidence = {
  pageTitle?: string;
  metaDescription?: string;
  candidates: string[];
  sourceUrl: string;
};

export type ExtractResult = {
  productName: string;
  priceCents: number;
  currency: string;
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
  oldPriceCents?: number;
  newPriceCents?: number;
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
