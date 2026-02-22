import { describe, expect, it } from "vitest";

import { extractFromShopifyPayload } from "../extract";

describe("Shopify JSON extraction", () => {
  it("extracts product, price, and partial stock from product.json payload", () => {
    const payload = {
      product: {
        title: "Bambu Lab External Exhaust Fan Kit",
        available: true,
        body_html: "<p>External ventilation accessory kit</p>",
        variants: [
          { title: "P2S", price: "39.99", available: false },
          { title: "X1C", price: "42.50", available: true },
        ],
      },
    };

    const result = extractFromShopifyPayload(
      payload,
      "https://ca.store.bambulab.com/products/external-exhaust-fan-kit-p2s",
      "https://ca.store.bambulab.com/products/external-exhaust-fan-kit-p2s.json",
    );

    expect(result).not.toBeNull();
    expect(result?.method).toBe("shopify_json");
    expect(result?.productName).toBe("Bambu Lab External Exhaust Fan Kit");
    expect(result?.priceCents).toBe(4250);
    expect(result?.inStock).toBe(true);
    expect(result?.stockState).toBe("PARTIAL");
    expect(result?.variantStock).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "P2S", inStock: false }),
        expect.objectContaining({ label: "X1C", inStock: true }),
      ]),
    );
  });

  it("extracts out-of-stock from product.js style payload with cent values", () => {
    const payload = {
      title: "Air Filter for External Exhaust Fan Kit",
      available: false,
      variants: [{ title: "Default Title", price: 1999, available: false }],
    };

    const result = extractFromShopifyPayload(
      payload,
      "https://ca.store.bambulab.com/products/air-filter-for-external-exhaust-fan-kit",
      "https://ca.store.bambulab.com/products/air-filter-for-external-exhaust-fan-kit.js",
    );

    expect(result).not.toBeNull();
    expect(result?.priceCents).toBe(1999);
    expect(result?.inStock).toBe(false);
    expect(result?.stockState).toBe("OUT_OF_STOCK");
    expect(result?.variantStock).toHaveLength(0);
    expect(result?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("returns null for non-product payload", () => {
    const result = extractFromShopifyPayload(
      { foo: "bar" },
      "https://example.com/products/widget",
      "https://example.com/products/widget.json",
    );

    expect(result).toBeNull();
  });
});
