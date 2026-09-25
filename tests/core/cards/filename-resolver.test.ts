import { describe, expect, it } from "vitest";
import { normalizeArtworkFilename } from "../../../core/cards/filename-resolver";

describe("artwork filename resolver", () => {
  it.each([
    ["Sol Ring.png", "Sol Ring"],
    ["Sol_Ring_custom.png", "Sol Ring"],
    ["01 - Sol Ring - alt art.jpg", "Sol Ring"],
    ["1x Sol Ring proxy.png", "Sol Ring"],
    ["Sol Ring [MPC].png", "Sol Ring"],
    ["Sol Ring-front.png", "Sol Ring"],
    ["Sol Ring_back.png", "Sol Ring"],
  ])("normalizes %s conservatively", (filename, query) => {
    expect(normalizeArtworkFilename(filename)).toBe(query);
  });

  it("keeps legitimate interior card-name words and removes only terminal marker words", () => {
    expect(normalizeArtworkFilename("Proxy Dragon.png")).toBe("Proxy Dragon");
    expect(normalizeArtworkFilename("Island of Wak-Wak custom.png")).toBe("Island of Wak-Wak");
    expect(normalizeArtworkFilename("Dwarven Mine [MPC].jpg")).toBe("Dwarven Mine");
  });
});
