import { describe, expect, it } from "vitest";
import { sanitizeCardIdentityMetadata, validateCardIdentityMetadata } from "../../../core/cards/safe-identity-metadata";

describe("safe CardIdentity metadata", () => {
  it("sanitizes only the safe application metadata contract for API cards", () => {
    const sanitized = sanitizeCardIdentityMetadata({
      layout: "transform",
      digital: false,
      promo: true,
      fullArt: false,
      imageStatus: "highres_scan",
      faces: [
        { name: "F".repeat(205), privatePath: "/secret/front.png" },
        { name: "Back face" },
        { name: "Ignored third face" },
      ],
      relatedCards: [
        { id: "i".repeat(90), name: "N".repeat(210), component: "c".repeat(50), typeLine: "T".repeat(210), sourcePath: "/secret/token.png" },
      ],
      originalUri: "file:///secret/original.png",
    });

    expect(sanitized).toEqual({
      layout: "transform",
      digital: false,
      promo: true,
      fullArt: false,
      imageStatus: "highres_scan",
      faces: [{ name: "F".repeat(200) }, { name: "Back face" }],
      relatedCards: [{
        id: "i".repeat(80),
        name: "N".repeat(200),
        component: "c".repeat(40),
        typeLine: "T".repeat(200),
      }],
    });
  });

  it("returns no metadata when the API input contains no safe fields", () => {
    expect(sanitizeCardIdentityMetadata({ originalUri: "file:///private/card.png", layout: 42 })).toBeUndefined();
  });

  it("validates and preserves safe metadata for lossless Project snapshots", () => {
    const metadata = {
      layout: "modal_dfc",
      digital: false,
      faces: [{ name: "Front" }, { name: "Back" }],
      relatedCards: [{ id: "token-1", name: "Powerstone", component: "token", typeLine: "Token Artifact" }],
    };

    expect(validateCardIdentityMetadata(metadata)).toEqual(metadata);
  });

  it("rejects unsupported fields and malformed nested values in strict Project mode", () => {
    expect(() => validateCardIdentityMetadata({ layout: "normal", originalUri: "file:///private/card.png" })).toThrow(/unsupported property/);
    expect(() => validateCardIdentityMetadata({ faces: [{ name: "Front", sourcePath: "/private/card.png" }] })).toThrow(/unsupported property/);
    expect(() => validateCardIdentityMetadata({ relatedCards: [{ id: "token-1", name: "Token", component: "token", sourcePath: "/private/token.png" }] })).toThrow(/unsupported property/);
    expect(() => validateCardIdentityMetadata({ digital: 42 })).toThrow(/string or boolean/);
  });
});
