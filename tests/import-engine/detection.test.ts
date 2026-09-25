import { describe, expect, it } from "vitest";
import { DETECTION_POLICY, detectImport, type ImportKind } from "../../import-engine";

const encode = (value: string) => new TextEncoder().encode(value);

function detect(text: string, fileName?: string) {
  return detectImport({ text, fileName });
}

function selectedKind(text: string, fileName?: string): ImportKind | undefined {
  return detect(text, fileName).selected?.kind;
}

describe("universal import detection", () => {
  it("recognizes raster and archive signatures even when the extension lies", () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);

    expect(detectImport({ bytes: png, fileName: "image.csv" }).selected).toMatchObject({ kind: "image" });
    expect(detectImport({ bytes: jpeg, fileName: "scan.png" }).selected).toMatchObject({ kind: "image" });
    expect(detectImport({ bytes: zip, fileName: "cards.txt" }).selected).toMatchObject({ kind: "zip" });
    expect(detectImport({ bytes: jpeg, fileName: "scan.png" }).reasons.join(" ")).toMatch(/extensão|conteúdo/i);
  });

  it("does not treat an extension by itself as format evidence", () => {
    const detection = detectImport({ bytes: new Uint8Array([0xff, 0x00, 0xff, 0x12]), fileName: "card.png" });
    expect(detection.status).toBe("unknown");
    expect(detection.selected).toBeUndefined();
  });

  it.each([
    ["<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>", "art.png", "svg"],
    ["4b4d5c", "synthetic.webp", "image"],
  ] as const)("recognizes %s by content", (content, fileName, kind) => {
    if (content === "4b4d5c") {
      const webp = new Uint8Array([...encode("RIFF"), 4, 0, 0, 0, ...encode("WEBP"), ...encode("VP8 ")]);
      expect(detectImport({ bytes: webp, fileName }).selected?.kind).toBe(kind);
    } else {
      expect(selectedKind(content, fileName)).toBe(kind);
    }
  });

  it("recognizes all TIFF byte order and classic/BigTIFF signatures", () => {
    for (const signature of [
      [0x49, 0x49, 0x2a, 0x00],
      [0x4d, 0x4d, 0x00, 0x2a],
      [0x49, 0x49, 0x2b, 0x00],
      [0x4d, 0x4d, 0x00, 0x2b],
    ]) {
      expect(detectImport({ bytes: new Uint8Array([...signature, 0, 0]), fileName: "x.bin" }).selected?.kind)
        .toBe("image");
    }
  });

  it("distinguishes simple, Arena, MTGO, XMage, and MWS text structures", () => {
    expect(selectedKind("Sol Ring")).toBe("simple-decklist");
    expect(selectedKind("1 Sol Ring (CMM) 396\n10 Island")).toBe("simple-decklist");
    expect(selectedKind("Deck\n1 Sol Ring (CMM) 396\nSideboard\n1 Island (M21) 310")).toBe("arena-like");
    expect(selectedKind("1 Sol Ring\nSB: 1 Island")).toBe("mtgo-like");
    expect(selectedKind("LAYOUT MAIN\n1 Sol Ring\nLAYOUT SIDEBOARD\n1 Island")).toBe("xmage-like");
    expect(selectedKind("// Deck file for Magic Workstation\n4 [CMM] Sol Ring", "list.mwDeck"))
      .toBe("mwdeck-like");
  });

  it("recognizes quoted CSV and TSV, JSON and generic XML", () => {
    expect(selectedKind('name,quantity\n"Sol Ring, Revised",1\n', "cards.csv")).toBe("csv");
    expect(selectedKind("name\tquantity\nSol Ring\t1\n", "cards.tsv")).toBe("tsv");
    expect(selectedKind('{"cards":[{"name":"Sol Ring"}]}', "cards.json")).toBe("json");
    expect(selectedKind("<?xml version=\"1.0\"?><deck><card><name>Sol Ring</name></card></deck>"))
      .toBe("generic-xml");
  });

  it("detects MPC Autofill order XML without selecting an online provider", () => {
    const xml = "<order><details></details><fronts><card><id>art-7</id><slots>1</slots><name>Custom</name><query>Custom</query></card></fronts></order>";
    expect(selectedKind(xml, "cards.xml")).toBe("mpc-autofill-xml");
  });

  it("requires explicit choice when two delimited formats are equally plausible", () => {
    const detection = detect('name, set\tquantity\nA, ABC\t1\nB, XYZ\t2\n', "mixed.csv");
    expect(detection.status).toBe("ambiguous");
    expect(detection.selected).toBeUndefined();
    expect(detection.candidates.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["csv", "tsv"]));
  });

  it("detects URLs as inert input and leaves unrecognized binary input unknown", () => {
    expect(selectedKind("https://example.invalid/deck.txt")).toBe("url");
    const detection = detectImport({ bytes: new Uint8Array([0xff, 0x00, 0xff, 0x12]), fileName: "unknown.data" });
    expect(detection.status).toBe("unknown");
    expect(detection.candidates[0]).toMatchObject({ kind: "unknown", confidence: 1 });
  });

  it("centralizes numeric confidence and explicit selection thresholds", () => {
    expect(DETECTION_POLICY.autoSelectMinimum).toBeGreaterThan(0);
    expect(DETECTION_POLICY.autoSelectMinimum).toBeLessThanOrEqual(1);
    expect(DETECTION_POLICY.ambiguousMinimum).toBeGreaterThan(0);
    expect(DETECTION_POLICY.ambiguityMargin).toBeGreaterThanOrEqual(0);
    const detection = detect("1 Sol Ring\n");
    for (const candidate of detection.candidates) {
      expect(candidate.confidence).toBeGreaterThanOrEqual(0);
      expect(candidate.confidence).toBeLessThanOrEqual(1);
      expect(candidate.reasons.length).toBeGreaterThan(0);
    }
  });
});
