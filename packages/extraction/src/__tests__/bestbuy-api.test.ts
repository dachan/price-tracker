import { describe, expect, it } from "vitest";

import { extractFromBestBuyPayload } from "../extract";

describe("Best Buy API extraction", () => {
  it("extracts name, price, and in-stock state", () => {
    const payload = {
      name: "Nintendo Switch 2 Console",
      salePrice: 629.99,
      regularPrice: 629.99,
      sku: "19296507",
      availability: {
        onlineAvailability: "InStock",
        isAvailableOnline: true,
      },
      shortDescription: "Start your next gaming adventure",
    };

    const result = extractFromBestBuyPayload(
      payload,
      "https://www.bestbuy.ca/en-ca/product/nintendo-switch-2-console/19296507",
      "https://www.bestbuy.ca/api/v2/json/product/19296507",
    );

    expect(result).not.toBeNull();
    expect(result?.productName).toBe("Nintendo Switch 2 Console");
    expect(result?.priceCents).toBe(62999);
    expect(result?.inStock).toBe(true);
    expect(result?.stockState).toBe("IN_STOCK");
    expect(result?.evidence.candidates[0]).toContain("bestbuy_api:");
  });

  it("extracts out-of-stock state", () => {
    const payload = {
      name: "Nintendo Switch 2 Console",
      salePrice: 629.99,
      availability: {
        onlineAvailability: "OutOfStock",
        isAvailableOnline: false,
      },
    };

    const result = extractFromBestBuyPayload(
      payload,
      "https://www.bestbuy.ca/en-ca/product/nintendo-switch-2-console/19296507",
      "https://www.bestbuy.ca/api/v2/json/product/19296507",
    );

    expect(result).not.toBeNull();
    expect(result?.inStock).toBe(false);
    expect(result?.stockState).toBe("OUT_OF_STOCK");
  });

  it("returns null for invalid payload", () => {
    const result = extractFromBestBuyPayload(
      { sku: "19296507", salePrice: 629.99 },
      "https://www.bestbuy.ca/en-ca/product/nintendo-switch-2-console/19296507",
      "https://www.bestbuy.ca/api/v2/json/product/19296507",
    );

    expect(result).toBeNull();
  });
});
