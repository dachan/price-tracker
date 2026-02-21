import crypto from "node:crypto";

import { load } from "cheerio";
import OpenAI from "openai";
import { fetch } from "undici";
import { z } from "zod";

import { parsePriceFromText } from "./price";
import type { ExtractEvidence, ExtractionAttempt, ExtractResult } from "./types";

type Candidate = {
  productName?: string;
  priceCents?: number;
  currency?: string;
  confidence: number;
  source: string;
  candidateText: string;
};

type ExtractOptions = {
  defaultCurrency?: string;
  timeoutMs?: number;
  allowPlaywright?: boolean;
  allowAi?: boolean;
  model?: string;
};

const AI_RESPONSE_SCHEMA = z.object({
  productName: z.string().min(1),
  price: z.number().positive(),
  currency: z.string().min(3).max(3),
});

export async function extractProductFromUrl(url: string, options: ExtractOptions = {}): Promise<ExtractionAttempt> {
  const timeoutMs = options.timeoutMs ?? Number(process.env.SCRAPE_TIMEOUT_MS ?? 20000);
  const allowPlaywright = options.allowPlaywright ?? true;
  const allowAi = options.allowAi ?? true;
  const model = options.model ?? process.env.OPENAI_MODEL_SMALL ?? "gpt-4o-mini";
  const defaultCurrency = options.defaultCurrency ?? process.env.DEFAULT_CURRENCY ?? "CAD";

  const staticPage = await fetchPageHtml(url, timeoutMs);
  let extracted = extractFromHtml(staticPage.html, staticPage.finalUrl, defaultCurrency);

  let usedPlaywright = false;
  let usedAi = false;
  let tokenInput: number | undefined;
  let tokenOutput: number | undefined;
  let estimatedCostUsd: number | undefined;

  if (extracted.confidence < 0.85 && allowPlaywright) {
    const renderedPage = await fetchRenderedHtml(staticPage.finalUrl, timeoutMs);
    if (renderedPage?.html) {
      usedPlaywright = true;
      const renderedExtract = extractFromHtml(renderedPage.html, renderedPage.finalUrl, defaultCurrency);
      if (renderedExtract.confidence > extracted.confidence) {
        extracted = {
          ...renderedExtract,
          method: "playwright",
        };
      }
    }
  }

  if (extracted.confidence < 0.85) {
    if (!allowAi) {
      return {
        status: "needs_review",
        reason: "AI_BUDGET_EXCEEDED_OR_DISABLED",
        usedPlaywright,
        usedAi,
      };
    }

    const aiEvidence = createAiEvidence(extracted.evidence, staticPage.finalUrl);
    const aiResult = await extractWithAi(aiEvidence, model);
    usedAi = true;
    tokenInput = aiResult.tokenInput;
    tokenOutput = aiResult.tokenOutput;
    estimatedCostUsd = aiResult.estimatedCostUsd;

    extracted = {
      ...extracted,
      productName: aiResult.productName,
      priceCents: Math.round(aiResult.price * 100),
      currency: aiResult.currency,
      confidence: 0.87,
      method: "ai",
      evidence: {
        ...extracted.evidence,
        candidates: [...extracted.evidence.candidates, "ai_fallback"],
      },
    };
  }

  if (!extracted.productName || !extracted.priceCents || extracted.confidence < 0.7) {
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
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });

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

export function extractFromHtml(html: string, sourceUrl: string, defaultCurrency = "CAD"): ExtractResult {
  const $ = load(html);
  const candidates: Candidate[] = [];

  candidates.push(...extractJsonLdCandidates($));
  candidates.push(...extractMetaCandidates($, defaultCurrency));
  candidates.push(...extractDomCandidates($, defaultCurrency));

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
    candidates: candidates.map((candidate) => `${candidate.source}:${candidate.candidateText}`).slice(0, 8),
  };

  const contentHash = crypto.createHash("sha256").update(html).digest("hex");

  return {
    productName: normalizeProductName(bestCandidate.productName ?? pageTitle ?? "Unknown Product"),
    priceCents: bestCandidate.priceCents ?? 0,
    currency: bestCandidate.currency ?? defaultCurrency,
    confidence: bestCandidate.confidence,
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
  if (second?.priceCents && top.priceCents && top.priceCents !== second.priceCents && second.confidence > top.confidence - 0.05) {
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

        const rawPrice = entry.price ?? priceNode?.price ?? priceNode?.lowPrice;
        const parsedPrice = typeof rawPrice === "number" ? { priceCents: Math.round(rawPrice * 100) } : parsePriceFromText(String(rawPrice ?? ""));
        const productName = typeof entry.name === "string" ? entry.name.trim() : undefined;
        const currency = priceNode?.priceCurrency ?? entry.priceCurrency;

        if (isProduct && productName && parsedPrice?.priceCents) {
          candidates.push({
            productName,
            priceCents: parsedPrice.priceCents,
            currency,
            confidence: 0.95,
            source: "jsonld",
            candidateText: `${productName} ${rawPrice ?? ""}`,
          });
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  });

  return candidates;
}

function extractMetaCandidates($: ReturnType<typeof load>, defaultCurrency: string): Candidate[] {
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

  const currency =
    $("meta[property='product:price:currency']").attr("content") ||
    $("meta[itemprop='priceCurrency']").attr("content") ||
    $("[itemprop='priceCurrency']").first().attr("content") ||
    parsed.currency ||
    defaultCurrency;

  candidates.push({
    productName,
    priceCents: parsed.priceCents,
    currency,
    confidence: 0.82,
    source: "meta",
    candidateText: `${productName ?? ""} ${priceText}`.trim(),
  });

  return candidates;
}

function extractDomCandidates($: ReturnType<typeof load>, defaultCurrency: string): Candidate[] {
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
        currency: parsed.currency ?? defaultCurrency,
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
      currency: parsed.currency ?? defaultCurrency,
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

function createAiEvidence(evidence: ExtractEvidence, sourceUrl: string): string {
  const compact = [
    `url=${sourceUrl}`,
    evidence.pageTitle ? `title=${evidence.pageTitle}` : "",
    evidence.metaDescription ? `meta=${evidence.metaDescription}` : "",
    ...evidence.candidates.slice(0, 8).map((candidate) => `candidate=${candidate}`),
  ]
    .filter(Boolean)
    .join("\n");

  return compact.slice(0, 4000);
}

async function extractWithAi(compactEvidence: string, model: string): Promise<{
  productName: string;
  price: number;
  currency: string;
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
    max_tokens: 120,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extract exactly one primary product name and current numeric price from evidence. Return JSON with keys: productName, price, currency. Product name must be concise canonical naming only (brand + product line/model). Remove marketing qualifiers, room size coverage, feature lists, and accessory bundle details. Example: 'LEVOIT Air Purifiers for Large Room ... Core 400S-P' -> 'LEVOIT Air Purifier - Core 400S'. Example: 'Dupray Neat Plus Steam Cleaner with 17-Piece Accessory Kit' -> 'Dupray Neat Plus Steam Cleaner'.",
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

  const inputRatePer1M = Number.parseFloat(process.env.OPENAI_INPUT_COST_PER_1M ?? "0.15");
  const outputRatePer1M = Number.parseFloat(process.env.OPENAI_OUTPUT_COST_PER_1M ?? "0.6");
  const estimatedCostUsd = (tokenInput / 1_000_000) * inputRatePer1M + (tokenOutput / 1_000_000) * outputRatePer1M;

  return {
    productName: normalizeProductName(parsed.productName),
    price: parsed.price,
    currency: parsed.currency.toUpperCase(),
    tokenInput,
    tokenOutput,
    estimatedCostUsd,
  };
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
