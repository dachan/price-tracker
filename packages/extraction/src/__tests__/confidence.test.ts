import { describe, expect, it } from "vitest";

import { extractFromHtml } from "../extract";

describe("extractFromHtml confidence", () => {
  it("assigns high confidence for Product JSON-LD", () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "Widget Pro",
              "offers": {
                "@type": "Offer",
                "price": "49.99"
              }
            }
          </script>
          <title>Widget Pro</title>
        </head>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/product/widget");
    expect(result.productName).toBe("Widget Pro");
    expect(result.priceCents).toBe(4999);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("extracts price from JSON-LD priceSpecification", () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "UniFi Travel Router",
              "offers": {
                "@type": "Offer",
                "availability": "https://schema.org/OutOfStock",
                "priceSpecification": {
                  "@type": "PriceSpecification",
                  "price": 115
                }
              }
            }
          </script>
          <title>UniFi Travel Router</title>
        </head>
      </html>
    `;

    const result = extractFromHtml(html, "https://ca.store.ui.com/ca/en/category/wifi-special-devices/products/utr");
    expect(result.productName).toBe("UniFi Travel Router");
    expect(result.priceCents).toBe(11500);
    expect(result.inStock).toBe(false);
    expect(result.stockState).toBe("OUT_OF_STOCK");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("assigns lower confidence for weak body-only candidates", () => {
    const html = `
      <html>
        <head><title>Example</title></head>
        <body>
          <div>Best deals available today.</div>
          <div>From $39.95</div>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/p");
    expect(result.confidence).toBeLessThan(0.85);
  });

  it("extracts embedded productSku/defaultPrice ahead of noisy body prices", () => {
    const html = `
      <html>
        <head><title>External Exhaust Air Filter</title></head>
        <body>
          <h1>External Exhaust Air Filter</h1>
          <div>Free shipping over $89</div>
          <script>
            window.__PRODUCT__ = {"productSku":{"price":14.99,"isSoldOut":true},"defaultPrice":14.99,"name":"External Exhaust Air Filter"};
          </script>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/products/air-filter");
    expect(result.productName).toBe("External Exhaust Air Filter");
    expect(result.priceCents).toBe(1499);
    expect(result.evidence.candidates.some((candidate) => candidate.includes("embedded:productSku"))).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });
});
