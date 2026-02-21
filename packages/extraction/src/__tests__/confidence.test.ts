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
                "price": "49.99",
                "priceCurrency": "USD"
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
});
