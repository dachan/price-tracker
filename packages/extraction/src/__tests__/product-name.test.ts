import { describe, expect, it } from "vitest";

import { extractFromHtml } from "../extract";

describe("product name normalization", () => {
  it("normalizes verbose LEVOIT title to concise product name", () => {
    const html = `
      <html>
        <head>
          <title>LEVOIT Air Purifiers for Large Room Home Up to 1733 Ft² with HEPA Sleep Mode, AHAM VERIFIDE, Smart WiFi, Auto Mode and Air Quality Monitor, removes Pet Allergies, Pollen, Smoke, Dust, Core 400S-P</title>
        </head>
        <body>
          <h1>LEVOIT Air Purifiers for Large Room Home Up to 1733 Ft² with HEPA Sleep Mode, AHAM VERIFIDE, Smart WiFi, Auto Mode and Air Quality Monitor, removes Pet Allergies, Pollen, Smoke, Dust, Core 400S-P</h1>
          <div class="price">$349.99</div>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/product");
    expect(result.productName).toBe("LEVOIT Air Purifier - Core 400S");
  });

  it("removes accessory bundle text from product name", () => {
    const html = `
      <html>
        <head><title>Dupray Neat Plus Steam Cleaner with 17-Piece Accessory Kit</title></head>
        <body>
          <h1>Dupray Neat Plus Steam Cleaner with 17-Piece Accessory Kit</h1>
          <div class="price">$189.00</div>
        </body>
      </html>
    `;

    const result = extractFromHtml(html, "https://example.com/product");
    expect(result.productName).toBe("Dupray Neat Plus Steam Cleaner");
  });
});
