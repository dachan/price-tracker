import crypto from "node:crypto";

import { load } from "cheerio";
import OpenAI from "openai";
import { fetch } from "undici";
import { z } from "zod";

import { parsePriceFromText } from "./price";
import type { ExtractEvidence, ExtractionAttempt, ExtractResult, StockState, VariantStock } from "./types";

type Candidate = {
  productName?: string;
  priceCents?: number | null;
  confidence: number;
  source: string;
  candidateText: string;
};

type ExtractOptions = {
  timeoutMs?: number;
  allowPlaywright?: boolean;
  allowAi?: boolean;
  model?: string;
  aiHints?: string[];
};

const AI_VARIANT_SCHEMA = z.object({
  label: z.string().min(1).max(80),
  inStock: z.boolean().nullable(),
});

const AI_RESPONSE_SCHEMA = z.object({
  productName: z.string().min(1),
  price: z.number().positive().nullable().optional().default(null),
  inStock: z.boolean().nullable().optional().default(null),
  stockState: z.enum(["IN_STOCK", "OUT_OF_STOCK", "PARTIAL", "UNKNOWN"]).optional().default("UNKNOWN"),
  variantStock: z.array(AI_VARIANT_SCHEMA).max(8).optional().default([]),
});

const REQUEST_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

const DEFAULT_SMALL_MODEL = "gpt-5-mini";

export async function extractProductFromUrl(url: string, options: ExtractOptions = {}): Promise<ExtractionAttempt> {
  const timeoutMs = options.timeoutMs ?? Number(process.env.SCRAPE_TIMEOUT_MS ?? 20000);
  const allowPlaywright = options.allowPlaywright ?? true;
  const allowAi = options.allowAi ?? true;
  const model = options.model ?? process.env.OPENAI_MODEL_SMALL ?? DEFAULT_SMALL_MODEL;
  const aiConfidenceThreshold = parseEnvNumber(process.env.AI_FALLBACK_CONFIDENCE_THRESHOLD, 0.88, 0.7, 0.98);
  const outOfStockVerifyThreshold = parseEnvNumber(process.env.OUT_OF_STOCK_VERIFY_CONFIDENCE_THRESHOLD, 0.78, 0.6, 0.95);
  const aiEvidenceMaxChars = parseEnvInt(process.env.AI_EVIDENCE_MAX_CHARS, 6000, 2500, 12000);
  const aiMaxOutputTokens = parseEnvInt(process.env.AI_MAX_OUTPUT_TOKENS, 180, 80, 300);

  const bestBuyResult = await tryExtractFromBestBuyApi(url, timeoutMs);
  if (bestBuyResult) {
    return {
      status: "success",
      result: bestBuyResult,
      usedPlaywright: false,
      usedAi: false,
    };
  }

  const shopifyResult = await tryExtractFromShopifyJson(url, timeoutMs);
  if (shopifyResult) {
    return {
      status: "success",
      result: shopifyResult,
      usedPlaywright: false,
      usedAi: false,
    };
  }

  let staticPage: { html: string; finalUrl: string };
  try {
    staticPage = await fetchPageHtml(url, timeoutMs);
  } catch (error) {
    if (isRedirectBlockedError(error)) {
      return {
        status: "needs_review",
        reason: "URL_REDIRECT_BLOCKED",
        usedPlaywright: false,
        usedAi: false,
      };
    }
    throw error;
  }

  if (hasRegionalHostRedirectMismatch(url, staticPage.finalUrl)) {
    return {
      status: "needs_review",
      reason: "REGIONAL_REDIRECT_MISMATCH",
      usedPlaywright: false,
      usedAi: false,
    };
  }

  let extracted = extractFromHtml(staticPage.html, staticPage.finalUrl);

  let usedPlaywright = false;
  let usedAi = false;
  let tokenInput: number | undefined;
  let tokenOutput: number | undefined;
  let estimatedCostUsd: number | undefined;

  if (
    extracted.confidence < aiConfidenceThreshold &&
    allowPlaywright &&
    (extracted.inStock !== false || extracted.confidence < outOfStockVerifyThreshold)
  ) {
    const renderedPage = await fetchRenderedHtml(staticPage.finalUrl, timeoutMs);
    if (renderedPage?.html) {
      usedPlaywright = true;
      const renderedExtract = extractFromHtml(renderedPage.html, renderedPage.finalUrl);
      if (renderedExtract.confidence > extracted.confidence) {
        extracted = {
          ...renderedExtract,
          method: "playwright",
        };
      }
    }
  }

  if (extracted.confidence < aiConfidenceThreshold && shouldUseAiFallback(extracted, outOfStockVerifyThreshold)) {
    if (!allowAi) {
      return {
        status: "needs_review",
        reason: "AI_BUDGET_EXCEEDED_OR_DISABLED",
        usedPlaywright,
        usedAi,
      };
    }

    const aiEvidence = createAiEvidence(extracted.evidence, staticPage.finalUrl, aiEvidenceMaxChars, options.aiHints);
    const aiResult = await extractWithAi(aiEvidence, model, aiMaxOutputTokens);
    usedAi = true;
    tokenInput = aiResult.tokenInput;
    tokenOutput = aiResult.tokenOutput;
    estimatedCostUsd = aiResult.estimatedCostUsd;

    extracted = {
      ...extracted,
      productName: aiResult.productName,
      priceCents: typeof aiResult.price === "number" ? Math.round(aiResult.price * 100) : null,
      inStock: aiResult.inStock,
      stockState: aiResult.stockState,
      variantStock: aiResult.variantStock,
      confidence: 0.87,
      method: "ai",
      evidence: {
        ...extracted.evidence,
        stockState: aiResult.stockState,
        variantStock: aiResult.variantStock,
        candidates: [...extracted.evidence.candidates, "ai_fallback"],
      },
    };
  }

  if (
    !extracted.productName ||
    extracted.confidence < 0.7 ||
    (extracted.inStock !== false && typeof extracted.priceCents !== "number")
  ) {
    return {
      status: "needs_review",
      reason: "LOW_CONFIDENCE_EXTRACTION",
      usedPlaywright,
      usedAi,
      tokenInput,
      tokenOutput,
      estimatedCostUsd,
    };
  }

  return {
    status: "success",
    result: extracted,
    usedPlaywright,
    usedAi,
    tokenInput,
    tokenOutput,
    estimatedCostUsd,
  };
}

export async function fetchPageHtml(url: string, timeoutMs: number): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        ...REQUEST_HEADERS,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (isRedirectStatus(response.status)) {
      throw new Error(`REDIRECT_BLOCKED:${response.status}:${response.headers.get("location") ?? ""}`);
    }

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}`);
    }

    const html = await response.text();
    return {
      html,
      finalUrl: response.url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function tryExtractFromBestBuyApi(url: string, timeoutMs: number): Promise<ExtractResult | null> {
  const sku = getBestBuySkuFromUrl(url);
  if (!sku) {
    return null;
  }

  const endpoint = `https://www.bestbuy.ca/api/v2/json/product/${sku}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(2500, Math.floor(timeoutMs / 2)));

  try {
    const response = await fetch(endpoint, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        ...REQUEST_HEADERS,
        accept: "application/json,text/plain,*/*",
      },
    });

    if (isRedirectStatus(response.status) || !response.ok) {
      return null;
    }

    const body = await response.text();
    if (!body) {
      return null;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return null;
    }

    return extractFromBestBuyPayload(payload, url, endpoint);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getBestBuySkuFromUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!/bestbuy\.ca$/i.test(parsed.hostname)) {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (/^\d{6,}$/.test(segment)) {
      return segment;
    }
  }

  const querySku = parsed.searchParams.get("sku") ?? parsed.searchParams.get("id");
  if (querySku && /^\d{6,}$/.test(querySku)) {
    return querySku;
  }

  return null;
}

export function extractFromBestBuyPayload(payload: unknown, sourceUrl: string, endpointUrl: string): ExtractResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, any>;
  const rawName = typeof record.name === "string" ? record.name.trim() : "";
  if (!rawName) {
    return null;
  }

  const priceCandidates = [
    record.salePrice,
    record.regularPrice,
    record.price,
    record.currentPrice,
  ];
  let priceCents: number | null = null;
  for (const candidate of priceCandidates) {
    const parsed = parseBestBuyPriceCents(candidate);
    if (typeof parsed === "number") {
      priceCents = parsed;
      break;
    }
  }

  const onlineAvailability = String(record.availability?.onlineAvailability ?? "").toLowerCase();
  const isAvailableOnline = normalizeBoolean(record.availability?.isAvailableOnline ?? record.isAvailableOnline);
  const inStoreAvailability = String(record.availability?.inStoreAvailability ?? "").toLowerCase();

  let stockState: StockState = "UNKNOWN";
  if (onlineAvailability.includes("instock") || isAvailableOnline === true) {
    stockState = "IN_STOCK";
  } else if (
    onlineAvailability.includes("outofstock") ||
    onlineAvailability.includes("soldout") ||
    onlineAvailability.includes("backorder") ||
    isAvailableOnline === false
  ) {
    stockState = "OUT_OF_STOCK";
  } else if (inStoreAvailability.includes("available")) {
    stockState = "IN_STOCK";
  }

  return {
    productName: normalizeProductName(rawName),
    priceCents,
    inStock: inStockFromState(stockState),
    stockState,
    variantStock: [],
    confidence: 0.96,
    method: "static",
    evidence: {
      pageTitle: rawName,
      metaDescription: typeof record.shortDescription === "string" ? stripHtml(record.shortDescription) : undefined,
      sourceUrl,
      stockState,
      variantStock: [],
      candidates: [
        `bestbuy_api:${endpointUrl}`,
        `bestbuy_sku:${String(record.sku ?? "")}`,
        `bestbuy_online_availability:${String(record.availability?.onlineAvailability ?? "")}`,
      ],
    },
    contentHash: crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex"),
  };
}

async function tryExtractFromShopifyJson(url: string, timeoutMs: number): Promise<ExtractResult | null> {
  const endpoints = getShopifyProductJsonEndpoints(url);
  if (endpoints.length === 0) {
    return null;
  }

  const perRequestTimeout = Math.max(2500, Math.floor(timeoutMs / 2));
  let bestResult: ExtractResult | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), perRequestTimeout);

    try {
      const response = await fetch(endpoint, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...REQUEST_HEADERS,
          accept: "application/json,text/javascript,*/*;q=0.8",
        },
      });

      if (isRedirectStatus(response.status)) {
        continue;
      }

      if (!response.ok) {
        continue;
      }

      if (hasRegionalHostRedirectMismatch(url, response.url || endpoint)) {
        continue;
      }

      const body = await response.text();
      if (!body) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }

      const extracted = extractFromShopifyPayload(parsed, url, response.url || endpoint);
      if (extracted) {
        const score = scoreShopifyExtraction(extracted);
        if (score > bestScore) {
          bestScore = score;
          bestResult = extracted;
        }
      }
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  return bestResult;
}

function getShopifyProductJsonEndpoints(rawUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const productsIndex = segments.findIndex((segment) => segment.toLowerCase() === "products");
  if (productsIndex === -1 || !segments[productsIndex + 1]) {
    return [];
  }

  const rawHandle = decodeURIComponent(segments[productsIndex + 1]);
  const handle = rawHandle.replace(/\.(json|js)$/i, "").trim();
  if (!handle) {
    return [];
  }

  const productPrefix = `/${segments.slice(0, productsIndex + 1).join("/")}/${encodeURIComponent(handle)}`;
  const jsonUrl = new URL(parsed.toString());
  jsonUrl.pathname = `${productPrefix}.json`;
  jsonUrl.search = "";
  jsonUrl.hash = "";

  const jsUrl = new URL(parsed.toString());
  jsUrl.pathname = `${productPrefix}.js`;
  jsUrl.search = "";
  jsUrl.hash = "";

  return [...new Set([jsUrl.toString(), jsonUrl.toString()])];
}

export function extractFromShopifyPayload(payload: unknown, sourceUrl: string, endpointUrl: string): ExtractResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const payloadRecord = payload as Record<string, any>;
  const productRecord =
    payloadRecord.product && typeof payloadRecord.product === "object"
      ? (payloadRecord.product as Record<string, any>)
      : payloadRecord;

  const rawName = typeof productRecord.title === "string" ? productRecord.title.trim() : "";
  if (!rawName) {
    return null;
  }

  const assumeIntegerIsCents = endpointUrl.toLowerCase().includes(".js");
  const variants = Array.isArray(productRecord.variants)
    ? (productRecord.variants.filter((variant) => variant && typeof variant === "object") as Record<string, any>[])
    : [];

  const variantStockInput: VariantStock[] = [];
  let firstVariantPriceCents: number | null = null;
  let firstAvailableVariantPriceCents: number | null = null;

  for (const variant of variants) {
    const priceCents = parseShopifyPriceCents(variant.price, assumeIntegerIsCents);
    if (firstVariantPriceCents === null && typeof priceCents === "number") {
      firstVariantPriceCents = priceCents;
    }

    const variantInStock = parseShopifyAvailability(variant.available);
    if (variantInStock === true && firstAvailableVariantPriceCents === null && typeof priceCents === "number") {
      firstAvailableVariantPriceCents = priceCents;
    }

    const label = sanitizeVariantLabel(
      variant.title ??
        variant.name ??
        variant.option1 ??
        variant.sku ??
        variant.id,
    );
    if (!label || variantInStock === null) {
      continue;
    }

    variantStockInput.push({
      label,
      inStock: variantInStock,
      source: "shopify",
    });
  }

  const productLevelPrices = [
    parseShopifyPriceCents(productRecord.price, assumeIntegerIsCents),
    parseShopifyPriceCents(productRecord.price_min, assumeIntegerIsCents),
    parseShopifyPriceCents(productRecord.priceMin, assumeIntegerIsCents),
    parseShopifyPriceCents(productRecord.min_variant_price, assumeIntegerIsCents),
    parseShopifyPriceCents(productRecord.compare_at_price, assumeIntegerIsCents),
  ].filter((value): value is number => typeof value === "number");

  const priceCents = firstAvailableVariantPriceCents ?? firstVariantPriceCents ?? productLevelPrices[0] ?? null;
  const normalizedVariants = normalizeVariantStock(variantStockInput);
  const variantInCount = normalizedVariants.filter((variant) => variant.inStock === true).length;
  const variantOutCount = normalizedVariants.filter((variant) => variant.inStock === false).length;

  let stockState = inferStockStateFromVariants(variantInCount, variantOutCount);
  const productAvailable = parseShopifyAvailability(productRecord.available);
  if (stockState === "UNKNOWN") {
    if (productAvailable === true) {
      stockState = "IN_STOCK";
    } else if (productAvailable === false) {
      stockState = "OUT_OF_STOCK";
    }
  }

  const inStock = inStockFromState(stockState) ?? productAvailable;
  const description =
    typeof productRecord.body_html === "string"
      ? stripHtml(productRecord.body_html)
      : typeof productRecord.description === "string"
      ? stripHtml(productRecord.description)
      : undefined;

  const confidence = Math.min(
    0.99,
    0.84 +
      (typeof priceCents === "number" ? 0.06 : 0) +
      (stockState !== "UNKNOWN" ? 0.07 : 0) +
      (normalizedVariants.length > 0 ? 0.03 : 0),
  );

  return {
    productName: normalizeProductName(rawName),
    priceCents,
    inStock,
    stockState,
    variantStock: normalizedVariants,
    confidence,
    method: "shopify_json",
    evidence: {
      pageTitle: rawName,
      metaDescription: description,
      sourceUrl,
      stockState,
      variantStock: normalizedVariants,
      candidates: [
        `shopify_endpoint:${endpointUrl}`,
        `shopify_variants:${variants.length}`,
        `shopify_available:${String(productAvailable)}`,
      ],
    },
    contentHash: crypto.createHash("sha256").update(JSON.stringify(payloadRecord)).digest("hex"),
  };
}

function scoreShopifyExtraction(result: ExtractResult): number {
  const variantKnownCount = result.variantStock.filter((variant) => variant.inStock !== null).length;
  const stockScore = result.stockState === "UNKNOWN" ? 0 : result.stockState === "PARTIAL" ? 3 : 2.4;

  return (
    (typeof result.priceCents === "number" ? 2 : 0) +
    stockScore +
    Math.min(variantKnownCount, 8) * 0.25 +
    result.confidence
  );
}

async function fetchRenderedHtml(url: string, timeoutMs: number): Promise<{ html: string; finalUrl: string } | null> {
  const playwright = await import("playwright").catch(() => null);
  if (!playwright) {
    return null;
  }

  let browser: any = null;
  let page: any = null;

  try {
    browser = await playwright.chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.floor(timeoutMs / 2) }).catch(() => undefined);
    const html = await page.content();
    const finalUrl = page.url();
    if (!isSameExtractionUrl(url, finalUrl)) {
      return null;
    }

    return {
      html,
      finalUrl,
    };
  } catch {
    return null;
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export function extractFromHtml(html: string, sourceUrl: string): ExtractResult {
  const $ = load(html);
  const candidates: Candidate[] = [];
  const stockDetection = detectStockStatus($);

  candidates.push(...extractJsonLdCandidates($));
  candidates.push(...extractMetaCandidates($));
  candidates.push(...extractEmbeddedProductCandidates($));
  candidates.push(...extractDomCandidates($));

  const bestCandidate = chooseBestCandidate(candidates);
  const pageTitle = $("title").first().text().trim() || undefined;
  const metaDescription =
    $("meta[name='description']").attr("content")?.trim() ||
    $("meta[property='og:description']").attr("content")?.trim() ||
    undefined;

  const evidence: ExtractEvidence = {
    pageTitle,
    metaDescription,
    sourceUrl,
    stockState: stockDetection.stockState,
    variantStock: stockDetection.variantStock,
    candidates: [
      ...candidates.map((candidate) => `${candidate.source}:${candidate.candidateText}`).slice(0, 8),
      ...stockDetection.signals.map((signal) => `stock:${signal}`).slice(0, 6),
      ...stockDetection.variantStock
        .slice(0, 6)
        .map((variant) => `variant:${variant.label}:${stringifyStockValue(variant.inStock)}${variant.source ? `:${variant.source}` : ""}`),
    ],
  };

  const contentHash = crypto.createHash("sha256").update(html).digest("hex");
  const confidence =
    stockDetection.stockState !== "UNKNOWN" ? Math.max(bestCandidate.confidence, stockDetection.stockState === "PARTIAL" ? 0.8 : 0.75) : bestCandidate.confidence;

  return {
    productName: normalizeProductName(bestCandidate.productName ?? pageTitle ?? "Unknown Product"),
    priceCents: bestCandidate.priceCents ?? null,
    inStock: stockDetection.inStock,
    stockState: stockDetection.stockState,
    variantStock: stockDetection.variantStock,
    confidence,
    method: "static",
    evidence,
    contentHash,
  };
}

function chooseBestCandidate(candidates: Candidate[]): Candidate {
  if (candidates.length === 0) {
    return {
      confidence: 0,
      source: "none",
      candidateText: "none",
    };
  }

  const sorted = candidates
    .map((candidate) => {
      let score = candidate.confidence;
      if (candidate.productName) {
        score += 0.05;
      }
      if (candidate.priceCents) {
        score += 0.05;
      }
      return { ...candidate, confidence: Math.min(score, 0.99) };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const [top, second] = sorted;
  if (
    typeof second?.priceCents === "number" &&
    typeof top.priceCents === "number" &&
    top.priceCents !== second.priceCents &&
    second.confidence > top.confidence - 0.05
  ) {
    return {
      ...top,
      confidence: Math.max(0.5, top.confidence - 0.1),
    };
  }

  return top;
}

function extractJsonLdCandidates($: ReturnType<typeof load>): Candidate[] {
  const candidates: Candidate[] = [];

  $("script[type='application/ld+json']").each((_, node) => {
    const text = $(node).text().trim();
    if (!text) {
      return;
    }

    try {
      const parsed = JSON.parse(text);
      for (const entry of flattenJsonLd(parsed)) {
        const type = normalizeType(entry["@type"]);
        const isProduct = type.includes("product");
        const offer = entry.offers ?? entry.offer;
        const priceNode = Array.isArray(offer) ? offer[0] : offer;
        const priceSpecification = priceNode?.priceSpecification ?? entry.priceSpecification;

        const rawPrice = entry.price ?? priceNode?.price ?? priceNode?.lowPrice ?? priceSpecification?.price ?? priceSpecification?.minPrice;
        const parsedPrice = typeof rawPrice === "number" ? { priceCents: Math.round(rawPrice * 100) } : parsePriceFromText(String(rawPrice ?? ""));
        const productName = typeof entry.name === "string" ? entry.name.trim() : undefined;

        const availability = parseAvailabilityValue(priceNode?.availability ?? entry.availability);
        if (isProduct && productName && (parsedPrice?.priceCents || availability === false)) {
          candidates.push({
            productName,
            priceCents: parsedPrice?.priceCents ?? null,
            confidence: parsedPrice?.priceCents ? 0.95 : 0.88,
            source: "jsonld",
            candidateText: `${productName} ${rawPrice ?? ""} availability=${String(availability)}`,
          });
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  });

  return candidates;
}

function extractMetaCandidates($: ReturnType<typeof load>): Candidate[] {
  const candidates: Candidate[] = [];

  const productName =
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("meta[name='twitter:title']").attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    $("title").first().text().trim() ||
    undefined;

  const priceText =
    $("meta[property='product:price:amount']").attr("content") ||
    $("meta[property='og:price:amount']").attr("content") ||
    $("meta[itemprop='price']").attr("content") ||
    $("[itemprop='price']").first().attr("content") ||
    $("[itemprop='price']").first().text() ||
    undefined;

  if (!priceText) {
    return candidates;
  }

  const parsed = parsePriceFromText(priceText);
  if (!parsed) {
    return candidates;
  }

  candidates.push({
    productName,
    priceCents: parsed.priceCents,
    confidence: 0.82,
    source: "meta",
    candidateText: `${productName ?? ""} ${priceText}`.trim(),
  });

  return candidates;
}

function extractDomCandidates($: ReturnType<typeof load>): Candidate[] {
  const candidates: Candidate[] = [];

  const productName =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("title").first().text().trim() ||
    undefined;

  const selectors = [
    "[class*='price']",
    "[id*='price']",
    "[data-price]",
    "[itemprop='price']",
    ".product-price",
    ".price",
  ];

  const seen = new Set<string>();
  for (const selector of selectors) {
    $(selector).each((_, node) => {
      const text = $(node).text().replace(/\s+/g, " ").trim();
      if (!text || seen.has(text)) {
        return;
      }
      seen.add(text);

      const parsed = parsePriceFromText(text);
      if (!parsed) {
        return;
      }

      candidates.push({
        productName,
        priceCents: parsed.priceCents,
        confidence: 0.72,
        source: "dom",
        candidateText: text,
      });
    });
  }

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  for (const match of bodyText.matchAll(/(?:[\$€£¥₹]\s?[0-9][0-9.,]{0,14})/g)) {
    const text = match[0];
    const parsed = parsePriceFromText(text);
    if (!parsed) {
      continue;
    }

    candidates.push({
      productName,
      priceCents: parsed.priceCents,
      confidence: 0.6,
      source: "body",
      candidateText: text,
    });

    if (candidates.length > 20) {
      break;
    }
  }

  return candidates;
}

function extractEmbeddedProductCandidates($: ReturnType<typeof load>): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const fallbackName =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("title").first().text().trim() ||
    undefined;

  $("script").each((_, node) => {
    const rawText = $(node).html() ?? $(node).text();
    if (!rawText || (!rawText.includes("productSku") && !rawText.includes("defaultPrice"))) {
      return;
    }
    const text = rawText.replace(/\\"/g, "\"");

    for (const match of text.matchAll(/"productSku"\s*:\s*\{[\s\S]{0,1400}?"price"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)[\s\S]{0,400}?"isSoldOut"\s*:\s*(true|false)/g)) {
      const parsed = parsePriceFromText(match[1]);
      if (!parsed) {
        continue;
      }

      const key = `sku:${parsed.priceCents}:${match[2]}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const nameMatch = text.match(/"name"\s*:\s*"([^"]{2,160})"/);
      const productName = nameMatch?.[1]?.trim() || fallbackName;
      candidates.push({
        productName,
        priceCents: parsed.priceCents,
        confidence: 0.92,
        source: "embedded",
        candidateText: `productSku price=${match[1]} soldOut=${match[2]}`,
      });
    }

    for (const match of text.matchAll(/"defaultPrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/g)) {
      const parsed = parsePriceFromText(match[1]);
      if (!parsed) {
        continue;
      }

      const around = text.slice(Math.max(0, match.index - 240), Math.min(text.length, match.index + 240)).toLowerCase();
      if (!around.includes("product") && !around.includes("sku")) {
        continue;
      }

      const key = `default:${parsed.priceCents}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      candidates.push({
        productName: fallbackName,
        priceCents: parsed.priceCents,
        confidence: 0.86,
        source: "embedded",
        candidateText: `defaultPrice=${match[1]}`,
      });
    }
  });

  return candidates;
}

function flattenJsonLd(input: unknown): Record<string, any>[] {
  const out: Record<string, any>[] = [];

  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record["@graph"])) {
        walk(record["@graph"]);
      }
      out.push(record as Record<string, any>);
    }
  };

  walk(input);
  return out;
}

function normalizeType(type: unknown): string[] {
  if (typeof type === "string") {
    return [type.toLowerCase()];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toLowerCase());
  }
  return [];
}

function shouldUseAiFallback(result: ExtractResult, outOfStockVerifyThreshold: number): boolean {
  if (result.inStock !== false) {
    return true;
  }

  const hasEmbeddedOutSignal = result.evidence.candidates.some((candidate) => candidate.includes("stock:embedded:out="));
  const hasEmbeddedInSignal = result.evidence.candidates.some((candidate) => candidate.includes("stock:embedded:in="));
  if (result.stockState === "OUT_OF_STOCK" && hasEmbeddedOutSignal && !hasEmbeddedInSignal) {
    return false;
  }

  if (result.stockState === "PARTIAL") {
    return true;
  }

  if (result.variantStock.length > 0) {
    return true;
  }

  return result.confidence < outOfStockVerifyThreshold;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isRedirectBlockedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("REDIRECT_BLOCKED:");
}

function isSameExtractionUrl(inputUrl: string, outputUrl: string): boolean {
  try {
    const input = new URL(inputUrl);
    const output = new URL(outputUrl);
    input.hash = "";
    output.hash = "";
    return input.toString() === output.toString();
  } catch {
    return false;
  }
}

function parseEnvNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function hasRegionalHostRedirectMismatch(requestUrl: string, finalUrl: string): boolean {
  try {
    const requested = new URL(requestUrl);
    const resolved = new URL(finalUrl);
    const requestedHost = requested.hostname.toLowerCase();
    const resolvedHost = resolved.hostname.toLowerCase();

    if (requestedHost === resolvedHost) {
      return false;
    }

    const requestedParts = requestedHost.split(".");
    const resolvedParts = resolvedHost.split(".");
    if (requestedParts.length < 3 || resolvedParts.length < 3) {
      return false;
    }

    const requestedRoot = requestedParts.slice(-2).join(".");
    const resolvedRoot = resolvedParts.slice(-2).join(".");
    if (requestedRoot !== resolvedRoot) {
      return false;
    }

    const regionalPrefixes = new Set(["us", "ca", "uk", "eu", "au", "de", "fr", "it", "es", "jp", "sg", "hk"]);
    const requestedPrefix = requestedParts[0];
    const resolvedPrefix = resolvedParts[0];
    return regionalPrefixes.has(requestedPrefix) && regionalPrefixes.has(resolvedPrefix) && requestedPrefix !== resolvedPrefix;
  } catch {
    return false;
  }
}

function parseEnvInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function createAiEvidence(evidence: ExtractEvidence, sourceUrl: string, maxChars: number, aiHints: string[] = []): string {
  const compactHints = aiHints
    .map((hint) => hint.trim())
    .filter((hint) => hint.length > 0)
    .slice(0, 4);

  const compact = [
    `url=${sourceUrl}`,
    evidence.pageTitle ? `title=${evidence.pageTitle}` : "",
    evidence.metaDescription ? `meta=${evidence.metaDescription}` : "",
    evidence.stockState ? `stockState=${evidence.stockState}` : "",
    ...compactHints.map((hint) => `hint=${hint}`),
    ...toCompactVariantEvidence(evidence.variantStock),
    ...evidence.candidates.slice(0, 12).map((candidate) => `candidate=${candidate}`),
  ]
    .filter(Boolean)
    .join("\n");

  return compact.slice(0, maxChars);
}

async function extractWithAi(
  compactEvidence: string,
  model: string,
  maxOutputTokens: number,
): Promise<{
  productName: string;
  price: number | null;
  inStock: boolean | null;
  stockState: StockState;
  variantStock: VariantStock[];
  tokenInput: number;
  tokenOutput: number;
  estimatedCostUsd: number;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for AI fallback extraction");
  }

  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: maxOutputTokens,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extract exactly one primary product name, current numeric price, and stock state from evidence. Return strict JSON with keys: productName, price, inStock, stockState, variantStock. stockState must be one of IN_STOCK, OUT_OF_STOCK, PARTIAL, UNKNOWN. Use PARTIAL when only some sizes/models/variants are available and others are unavailable. inStock must be true for IN_STOCK or PARTIAL, false for OUT_OF_STOCK, null for UNKNOWN. variantStock must be a short array of variant labels with inStock booleans when evidence includes per-size/per-model availability, otherwise []. If out-of-stock and no price exists, set price to null. Stock precedence rules: (1) If enabled purchase CTA exists for the same product context (Add to cart/Buy now), do NOT output OUT_OF_STOCK unless explicit selected-variant availability says out-of-stock. (2) Generic page text like 'currently unavailable' can refer to other offers/variants; when conflicting with active purchase CTA, prefer IN_STOCK or PARTIAL. (3) Use OUT_OF_STOCK only when selected/default product context is clearly unavailable and no active purchase CTA exists. (4) If signals conflict and selected context is unclear, choose UNKNOWN, not OUT_OF_STOCK. (5) If any variant/size/model in evidence is in stock while others are unavailable, output PARTIAL and include those variants in variantStock. Product name must be concise canonical naming only (brand + product line/model). Remove marketing qualifiers, room size coverage, feature lists, and accessory bundle details. Example: 'LEVOIT Air Purifiers for Large Room ... Core 400S-P' -> 'LEVOIT Air Purifier - Core 400S'. Example: 'Dupray Neat Plus Steam Cleaner with 17-Piece Accessory Kit' -> 'Dupray Neat Plus Steam Cleaner'.",
      },
      {
        role: "user",
        content: compactEvidence,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("AI extractor returned empty content");
  }

  const parsed = AI_RESPONSE_SCHEMA.parse(JSON.parse(content));
  const tokenInput = completion.usage?.prompt_tokens ?? 0;
  const tokenOutput = completion.usage?.completion_tokens ?? 0;
  const aiVariantStock = normalizeVariantStock(parsed.variantStock.map((variant) => ({ ...variant, source: "ai" })));
  const aiStockState = normalizeAiStockState(parsed.stockState, parsed.inStock, aiVariantStock);

  const pricingDefaults = getDefaultModelPricing(model);
  const inputRatePer1M = parseRateEnv(process.env.OPENAI_INPUT_COST_PER_1M, pricingDefaults.inputPer1M);
  const outputRatePer1M = parseRateEnv(process.env.OPENAI_OUTPUT_COST_PER_1M, pricingDefaults.outputPer1M);
  const estimatedCostUsd = (tokenInput / 1_000_000) * inputRatePer1M + (tokenOutput / 1_000_000) * outputRatePer1M;

  return {
    productName: normalizeProductName(parsed.productName),
    price: parsed.price,
    stockState: aiStockState,
    inStock: normalizeInStockFromState(parsed.inStock, aiStockState),
    variantStock: aiVariantStock,
    tokenInput,
    tokenOutput,
    estimatedCostUsd,
  };
}

function parseRateEnv(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getDefaultModelPricing(model: string): { inputPer1M: number; outputPer1M: number } {
  const normalized = model.toLowerCase();

  if (normalized.startsWith("gpt-5-mini")) {
    return { inputPer1M: 0.25, outputPer1M: 2.0 };
  }
  if (normalized.startsWith("gpt-5-nano")) {
    return { inputPer1M: 0.05, outputPer1M: 0.4 };
  }
  if (normalized.startsWith("gpt-5")) {
    return { inputPer1M: 1.25, outputPer1M: 10.0 };
  }
  if (normalized.startsWith("gpt-4.1-mini")) {
    return { inputPer1M: 0.4, outputPer1M: 1.6 };
  }
  if (normalized.startsWith("gpt-4.1-nano")) {
    return { inputPer1M: 0.1, outputPer1M: 0.4 };
  }
  if (normalized.startsWith("gpt-4o-mini")) {
    return { inputPer1M: 0.15, outputPer1M: 0.6 };
  }

  return { inputPer1M: 0.25, outputPer1M: 2.0 };
}

function detectStockStatus($: ReturnType<typeof load>): {
  inStock: boolean | null;
  stockState: StockState;
  variantStock: VariantStock[];
  signals: string[];
} {
  const signals: string[] = [];
  let outScore = 0;
  let inScore = 0;
  let hasExplicitOutAvailability = false;
  let hasExplicitInAvailability = false;

  const bodyText = extractVisibleBodyText($);
  const markerScopes = [
    bodyText,
    $("[class*='stock'], [id*='stock'], [class*='availability'], [id*='availability']")
      .text()
      .replace(/\s+/g, " ")
      .toLowerCase(),
  ];

  const outPatterns = [
    { re: /\bout of stock\b/g, weight: 2 },
    { re: /\bsold out\b/g, weight: 2 },
    { re: /\bcurrently unavailable\b/g, weight: 1.4 },
    { re: /\bunavailable\b/g, weight: 0.5 },
    { re: /\btemporarily out of stock\b/g, weight: 1.6 },
    { re: /\bback[- ]?ordered\b/g, weight: 1.2 },
    { re: /\bpre[- ]?order\b/g, weight: 0.8 },
  ];

  const inPatterns = [
    { re: /\bin stock\b/g, weight: 1.5 },
    { re: /\bavailable now\b/g, weight: 1.1 },
    { re: /\bready to ship\b/g, weight: 1.1 },
    { re: /\bships today\b/g, weight: 1.1 },
    { re: /\badd to cart\b/g, weight: 2.1 },
    { re: /\bbuy now\b/g, weight: 2.1 },
  ];

  for (const scope of markerScopes) {
    for (const pattern of outPatterns) {
      const matches = scope.match(pattern.re)?.length ?? 0;
      if (matches > 0) {
        const weighted = Math.min(matches, 3) * pattern.weight;
        outScore += weighted;
        signals.push(`text:${pattern.re.source}:${matches}:w${weighted.toFixed(1)}`);
      }
    }

    for (const pattern of inPatterns) {
      const matches = scope.match(pattern.re)?.length ?? 0;
      if (matches > 0) {
        const weighted = Math.min(matches, 3) * pattern.weight;
        inScore += weighted;
        signals.push(`text:${pattern.re.source}:${matches}:w${weighted.toFixed(1)}`);
      }
    }
  }

  const availabilityValues = [
    $("meta[itemprop='availability']").attr("content"),
    $("link[itemprop='availability']").attr("href"),
    $("meta[property='product:availability']").attr("content"),
    $("[itemprop='availability']").first().attr("href"),
    $("[itemprop='availability']").first().text(),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const value of availabilityValues) {
    const parsed = parseAvailabilityValue(value);
    if (parsed === false) {
      hasExplicitOutAvailability = true;
      outScore += 3;
      signals.push(`availability:${value}`);
    } else if (parsed === true) {
      hasExplicitInAvailability = true;
      inScore += 3;
      signals.push(`availability:${value}`);
    }
  }

  const purchaseSignals = detectPurchaseCtaSignals($);
  if (purchaseSignals.enabledCount > 0) {
    const boost = 3 + Math.min(purchaseSignals.enabledCount, 2);
    inScore += boost;
    signals.push(`purchase:enabled=${purchaseSignals.enabledCount}:boost=${boost}`);
  }
  if (purchaseSignals.disabledCount > 0) {
    const boost = 1 + Math.min(purchaseSignals.disabledCount, 2);
    outScore += boost;
    signals.push(`purchase:disabled=${purchaseSignals.disabledCount}:boost=${boost}`);
  }

  const embeddedInventory = detectEmbeddedInventorySignals($);
  if (embeddedInventory.outCount > 0) {
    const boost = Math.min(embeddedInventory.outCount, 8) * 1.6;
    outScore += boost;
    signals.push(`embedded:out=${embeddedInventory.outCount}:boost=${boost.toFixed(1)}`);
  }
  if (embeddedInventory.inCount > 0) {
    const boost = Math.min(embeddedInventory.inCount, 8) * 1.2;
    inScore += boost;
    signals.push(`embedded:in=${embeddedInventory.inCount}:boost=${boost.toFixed(1)}`);
  }

  const variantStock = normalizeVariantStock([
    ...extractVariantAvailabilityFromJsonLd($),
    ...extractVariantAvailabilityFromDom($),
  ]);

  const variantInCount = variantStock.filter((entry) => entry.inStock === true).length;
  const variantOutCount = variantStock.filter((entry) => entry.inStock === false).length;
  if (variantStock.length > 0) {
    signals.push(`variant:count=${variantStock.length}:in=${variantInCount}:out=${variantOutCount}`);
  }

  const pageState = inferStockStateFromScores(inScore, outScore, {
    hasExplicitOutAvailability,
    hasExplicitInAvailability,
    enabledPurchaseCtaCount: purchaseSignals.enabledCount,
    embeddedOutCount: embeddedInventory.outCount,
    embeddedInCount: embeddedInventory.inCount,
  });
  const variantState = inferStockStateFromVariants(variantInCount, variantOutCount);

  const stockState =
    variantState === "UNKNOWN"
      ? pageState
      : pageState === "UNKNOWN" || pageState === variantState
        ? variantState
        : "PARTIAL";

  return {
    inStock: inStockFromState(stockState),
    stockState,
    variantStock,
    signals,
  };
}

function inferStockStateFromScores(
  inScore: number,
  outScore: number,
  options: {
    hasExplicitOutAvailability: boolean;
    hasExplicitInAvailability: boolean;
    enabledPurchaseCtaCount: number;
    embeddedOutCount: number;
    embeddedInCount: number;
  },
): StockState {
  if (options.hasExplicitInAvailability && !options.hasExplicitOutAvailability) {
    return "IN_STOCK";
  }

  if (options.hasExplicitOutAvailability && !options.hasExplicitInAvailability && options.enabledPurchaseCtaCount === 0) {
    return "OUT_OF_STOCK";
  }

  if (options.embeddedOutCount > 0 && options.embeddedInCount === 0 && options.enabledPurchaseCtaCount === 0) {
    return "OUT_OF_STOCK";
  }

  // If a real purchase CTA is enabled, avoid false negatives from generic "unavailable" text.
  if (options.enabledPurchaseCtaCount > 0 && inScore >= outScore - 2) {
    return "IN_STOCK";
  }

  if (outScore >= inScore + 3 && outScore >= 3) {
    return "OUT_OF_STOCK";
  }

  if (inScore >= outScore + 2 && inScore >= 2) {
    return "IN_STOCK";
  }

  return "UNKNOWN";
}

function detectPurchaseCtaSignals($: ReturnType<typeof load>): { enabledCount: number; disabledCount: number } {
  let enabledCount = 0;
  let disabledCount = 0;
  const ctaPattern = /\b(add to cart|buy now|add to bag|checkout|shop now)\b/i;

  $("button, input[type='submit'], a[role='button'], [aria-label]").each((_, node) => {
    const element = $(node);
    if (element.parents("header, nav, footer").length > 0) {
      return;
    }
    if (element.attr("hidden") !== undefined || element.attr("aria-hidden") === "true") {
      return;
    }

    const text = [element.text(), element.attr("value"), element.attr("aria-label")]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text || !ctaPattern.test(text)) {
      return;
    }

    const disabled = element.is("[disabled]") || element.attr("aria-disabled") === "true";
    if (disabled) {
      disabledCount += 1;
    } else {
      enabledCount += 1;
    }
  });

  return {
    enabledCount,
    disabledCount,
  };
}

function detectEmbeddedInventorySignals($: ReturnType<typeof load>): { outCount: number; inCount: number } {
  const scriptText = $("script")
    .map((_, node) => $(node).html() ?? "")
    .get()
    .join("\n")
    .toLowerCase();

  if (!scriptText) {
    return { outCount: 0, inCount: 0 };
  }

  const outCount =
    (scriptText.match(/["']?issoldout["']?\s*:\s*true/g)?.length ?? 0) +
    (scriptText.match(/["']?availability["']?\s*:\s*["']https:\/\/schema\.org\/outofstock["']/g)?.length ?? 0) +
    (scriptText.match(/["']?outofstockmsg["']?\s*:\s*["'][^"']*(sold out|out of stock|unavailable)[^"']*["']/g)?.length ?? 0);

  const inCount =
    (scriptText.match(/["']?issoldout["']?\s*:\s*false/g)?.length ?? 0) +
    (scriptText.match(/["']?availability["']?\s*:\s*["']https:\/\/schema\.org\/instock["']/g)?.length ?? 0);

  return {
    outCount,
    inCount,
  };
}

function extractVisibleBodyText($: ReturnType<typeof load>): string {
  const clonedBody = $("body").clone();
  clonedBody.find("script, style, noscript, template").remove();
  return clonedBody.text().replace(/\s+/g, " ").toLowerCase();
}

function inferStockStateFromVariants(variantInCount: number, variantOutCount: number): StockState {
  if (variantInCount > 0 && variantOutCount > 0) {
    return "PARTIAL";
  }
  if (variantInCount > 0) {
    return "IN_STOCK";
  }
  if (variantOutCount > 0) {
    return "OUT_OF_STOCK";
  }
  return "UNKNOWN";
}

function extractVariantAvailabilityFromJsonLd($: ReturnType<typeof load>): VariantStock[] {
  const variants: VariantStock[] = [];

  $("script[type='application/ld+json']").each((_, node) => {
    const text = $(node).text().trim();
    if (!text) {
      return;
    }

    try {
      const parsed = JSON.parse(text);
      for (const entry of flattenJsonLd(parsed)) {
        const type = normalizeType(entry["@type"]);
        const offers = [
          ...(Array.isArray(entry.offers) ? entry.offers : entry.offers ? [entry.offers] : []),
          ...(type.includes("offer") ? [entry] : []),
        ];

        for (const offer of offers) {
          const inStock = parseAvailabilityValue(offer?.availability);
          if (inStock === null) {
            continue;
          }

          const label = sanitizeVariantLabel(
            offer?.sku ??
              offer?.name ??
              offer?.itemOffered?.name ??
              offer?.mpn ??
              offer?.gtin ??
              offer?.url ??
              "",
          );

          if (!label) {
            continue;
          }

          variants.push({
            label,
            inStock,
            source: "jsonld",
          });
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  });

  return variants;
}

function extractVariantAvailabilityFromDom($: ReturnType<typeof load>): VariantStock[] {
  const variants: VariantStock[] = [];
  const variantSelectors = [
    "select option",
    "[data-size]",
    "[data-model]",
    "[data-variant]",
    "[data-option]",
    "[class*='variant']",
    "[class*='swatch']",
    "[class*='size']",
    "[class*='model']",
    "[id*='variant']",
  ].join(", ");

  const nodes = $(variantSelectors).slice(0, 120);
  nodes.each((_, node) => {
    const element = $(node);
    const attr = (name: string) => element.attr(name) ?? undefined;
    const text = element.text().replace(/\s+/g, " ").trim();
    const raw = [
      text,
      attr("aria-label"),
      attr("title"),
      attr("data-stock"),
      attr("data-availability"),
      attr("data-status"),
      attr("class"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const disabledSignal = element.is("[disabled]") || attr("aria-disabled") === "true";
    const statusFromText = parseAvailabilityValue(raw);
    const inStock = disabledSignal ? false : statusFromText;

    if (inStock === null) {
      return;
    }

    const label = sanitizeVariantLabel(
      attr("data-size") ??
        attr("data-model") ??
        attr("data-variant") ??
        attr("data-option") ??
        attr("value") ??
        attr("aria-label") ??
        attr("title") ??
        text,
    );

    if (!label) {
      return;
    }

    variants.push({
      label,
      inStock,
      source: "dom",
    });
  });

  return variants;
}

function sanitizeVariantLabel(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }

  const label = input
    .replace(/\s+/g, " ")
    .replace(/\b(out of stock|sold out|unavailable|in stock|available now|add to cart|buy now)\b/gi, "")
    .replace(/[|:,-]+\s*$/, "")
    .trim();

  if (label.length < 1 || label.length > 64) {
    return null;
  }

  if (!/[a-z0-9]/i.test(label)) {
    return null;
  }

  if (/^(select|choose|option|size|model|variant)$/i.test(label)) {
    return null;
  }

  if (/^default title$/i.test(label)) {
    return null;
  }

  return label;
}

function normalizeVariantStock(input: VariantStock[]): VariantStock[] {
  const deduped = new Map<string, VariantStock>();

  for (const entry of input) {
    const label = sanitizeVariantLabel(entry.label);
    if (!label) {
      continue;
    }

    const key = `${label.toLowerCase()}::${stringifyStockValue(entry.inStock)}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        label,
        inStock: entry.inStock,
        source: entry.source,
      });
    }
  }

  return [...deduped.values()].slice(0, 8);
}

function stringifyStockValue(value: boolean | null): string {
  if (value === true) {
    return "IN";
  }
  if (value === false) {
    return "OUT";
  }
  return "UNK";
}

function toCompactVariantEvidence(variantStock: VariantStock[] | undefined): string[] {
  if (!variantStock?.length) {
    return [];
  }
  return variantStock.slice(0, 6).map((variant) => `variant=${variant.label}|${stringifyStockValue(variant.inStock)}`);
}

function inStockFromState(state: StockState): boolean | null {
  if (state === "OUT_OF_STOCK") {
    return false;
  }
  if (state === "IN_STOCK" || state === "PARTIAL") {
    return true;
  }
  return null;
}

function normalizeInStockFromState(inStock: boolean | null, state: StockState): boolean | null {
  if (state === "IN_STOCK" || state === "PARTIAL") {
    return true;
  }
  if (state === "OUT_OF_STOCK") {
    return false;
  }
  return inStock;
}

function normalizeAiStockState(state: StockState, inStock: boolean | null, variantStock: VariantStock[]): StockState {
  const variantInCount = variantStock.filter((entry) => entry.inStock === true).length;
  const variantOutCount = variantStock.filter((entry) => entry.inStock === false).length;
  const variantState = inferStockStateFromVariants(variantInCount, variantOutCount);

  if (state !== "UNKNOWN") {
    return state;
  }

  if (variantState !== "UNKNOWN") {
    return variantState;
  }

  if (inStock === true) {
    return "IN_STOCK";
  }

  if (inStock === false) {
    return "OUT_OF_STOCK";
  }

  return "UNKNOWN";
}

function parseShopifyPriceCents(value: unknown, assumeIntegerIsCents: boolean): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && assumeIntegerIsCents) {
      return value > 0 ? value : null;
    }
    return value > 0 ? Math.round(value * 100) : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    if (assumeIntegerIsCents) {
      return parsed;
    }
    return parsed * 100;
  }

  const parsed = parsePriceFromText(trimmed);
  return parsed?.priceCents ?? null;
}

function parseShopifyAvailability(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value > 0;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (["true", "1", "in_stock", "instock", "available"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "out_of_stock", "outofstock", "unavailable", "sold_out"].includes(normalized)) {
    return false;
  }

  return null;
}

function parseBestBuyPriceCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value * 100);
  }
  if (typeof value === "string") {
    const parsed = parsePriceFromText(value);
    return parsed?.priceCents ?? null;
  }
  return null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value > 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAvailabilityValue(value: unknown): boolean | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const normalized = value.toLowerCase();
  if (
    normalized.includes("outofstock") ||
    normalized.includes("out of stock") ||
    normalized.includes("soldout") ||
    normalized.includes("sold out") ||
    normalized.includes("unavailable") ||
    normalized.includes("not available") ||
    normalized.includes("backorder") ||
    normalized.includes("back-order") ||
    normalized.includes("preorder")
  ) {
    return false;
  }

  if (
    normalized.includes("instock") ||
    normalized.includes("in stock") ||
    normalized.includes("available") ||
    normalized.includes("ready to ship") ||
    normalized.includes("ships today") ||
    normalized.includes("limited stock")
  ) {
    return true;
  }

  return null;
}

function normalizeProductName(input: string): string {
  let name = input.replace(/\s+/g, " ").trim();
  if (!name) {
    return "Unknown Product";
  }

  const model = extractModelHint(name);

  name = name
    .replace(/\s+with\s+.+$/i, "")
    .replace(/\s+for\s+.+$/i, "")
    .replace(/,\s*.+$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  name = name
    .replace(/\bAir Purifiers\b/i, "Air Purifier")
    .replace(/\s+/g, " ")
    .trim();

  if (model && !name.toLowerCase().includes(model.toLowerCase())) {
    const normalizedModel = model.replace(/-P$/i, "");
    return `${name} - ${normalizedModel}`.trim();
  }

  return name || "Unknown Product";
}

function extractModelHint(input: string): string | null {
  const patterns = [
    /\b(Core)\s+([A-Z0-9-]{3,})\b/gi,
    /\b([A-Z]{1,}[0-9]{2,}[A-Z0-9-]*)\b/g,
  ];

  let lastMatch: string | null = null;

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      lastMatch = match[1] && match[2] ? `${match[1]} ${match[2]}` : match[1];
    }
  }

  return lastMatch;
}
