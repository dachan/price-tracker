import { describe, expect, it } from "vitest";

import { extractFromHtml } from "../extract";

describe("stock status extraction", () => {
  it("detects out of stock signals", () => {
    const html = `
      <html>
        <head>
          <title>Widget Pro</title>
          <meta property="product:availability" content="out of stock" />
        </head>
        <body>
          <h1>Widget Pro</h1>
          <div class="stock">Currently unavailable - out of stock</div>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/widget");
    expect(result.inStock).toBe(false);
    expect(result.stockState).toBe("OUT_OF_STOCK");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("detects in stock signals", () => {
    const html = `
      <html>
        <head>
          <title>Widget Pro</title>
          <meta property="product:availability" content="in stock" />
        </head>
        <body>
          <h1>Widget Pro</h1>
          <button>Add to cart</button>
          <div class="price">$49.99</div>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/widget");
    expect(result.inStock).toBe(true);
    expect(result.stockState).toBe("IN_STOCK");
  });

  it("detects partial stock when some variants are unavailable", () => {
    const html = `
      <html>
        <head>
          <title>Runner Shoe</title>
        </head>
        <body>
          <h1>Runner Shoe</h1>
          <button>Add to cart</button>
          <select name="size">
            <option>Size 8 - Out of stock</option>
            <option>Size 9 - In stock</option>
          </select>
          <div class="price">$89.99</div>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/shoe");
    expect(result.inStock).toBe(true);
    expect(result.stockState).toBe("PARTIAL");
    expect(result.variantStock.length).toBeGreaterThanOrEqual(2);
  });

  it("prefers in-stock when purchase CTA is enabled despite noisy unavailable text", () => {
    const html = `
      <html>
        <head>
          <title>Widget Pro</title>
        </head>
        <body>
          <h1>Widget Pro</h1>
          <div class="recommendation-note">Some options are currently unavailable.</div>
          <div class="recommendation-note">Temporarily unavailable in another listing.</div>
          <button>Add to cart</button>
          <button>Buy now</button>
          <div class="price">$129.99</div>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/widget");
    expect(result.inStock).toBe(true);
    expect(result.stockState).toBe("IN_STOCK");
  });

  it("detects out of stock from embedded inventory JSON signals", () => {
    const html = `
      <html>
        <head>
          <title>External Exhaust Fan Kit - P2S</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "ProductGroup",
              "hasVariant": [
                {
                  "@type": "Product",
                  "name": "External Exhaust Fan Kit - P2S",
                  "offers": {
                    "@type": "Offer",
                    "availability": "https://schema.org/OutOfStock",
                    "price": 19.99
                  }
                }
              ]
            }
          </script>
          <script>
            window.__PRODUCT__ = {
              productSkuList: [{ id: "sku-1", isSoldOut: true, outOfStockMsg: "Sold Out", addFlag: true }]
            };
          </script>
        </head>
        <body>
          <h1>External Exhaust Fan Kit - P2S</h1>
          <button disabled>Add to cart</button>
          <div class="price">$19.99</div>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://ca.store.bambulab.com/products/external-exhaust-fan-kit-p2s");
    expect(result.inStock).toBe(false);
    expect(result.stockState).toBe("OUT_OF_STOCK");
  });
});
