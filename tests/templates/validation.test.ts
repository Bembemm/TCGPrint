import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  calculateTemplatePackageHash,
  parseTemplateMetadata,
  validateTemplateFile,
} from "../../templates/validation";
import { createDefaultRegistrationConfig } from "../../core/registration";

const metadataInput = {
  name: "  A4 Standard  ",
  source: "  Alan Cha / SCM  ",
  version: " v5 ",
  paper: "A4",
  cardFormat: "standard",
  orientation: "landscape",
  recommendedBleedMm: 0.625,
  registrationType: "three-point",
};

const dxf = new TextEncoder().encode("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n");

describe("template metadata and original validation", () => {
  it("normalizes complete template metadata without dropping its supported fields", () => {
    expect(parseTemplateMetadata(metadataInput)).toEqual({
      name: "A4 Standard",
      source: "Alan Cha / SCM",
      version: "v5",
      paper: "a4",
      cardFormat: "standard",
      orientation: "landscape",
      recommendedBleedMm: 0.625,
      registrationType: "three-point",
    });
  });

  it("stores bounded registration geometry as part of the exact immutable template version", () => {
    const config = createDefaultRegistrationConfig("three-point", "landscape", { insetXMm: 11 });
    const metadata = parseTemplateMetadata({ ...metadataInput, registrationConfig: config });

    expect(metadata.registrationConfig).toEqual(config);
    expect(calculateTemplatePackageHash(metadata, [])).not.toBe(calculateTemplatePackageHash(parseTemplateMetadata(metadataInput), []));
  });

  it("validates and hashes exact bounded template slot geometry as immutable version metadata", () => {
    const templateGeometry = {
      orientation: "landscape",
      cardOrientation: "portrait",
      pageSizeMm: { widthMm: 297, heightMm: 210 },
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 2,
      slots: [
        { index: 0, row: 0, column: 0, xMm: 10, yMm: 10 },
        { index: 1, row: 0, column: 1, xMm: 80, yMm: 10 },
      ],
    };
    const metadata = parseTemplateMetadata({ ...metadataInput, templateGeometry });

    expect(metadata.templateGeometry).toEqual(templateGeometry);
    expect(calculateTemplatePackageHash(metadata, [])).not.toBe(calculateTemplatePackageHash(parseTemplateMetadata(metadataInput), []));
  });

  it("rejects out-of-bounds, overlapping, and excessive template slot metadata", () => {
    const valid = {
      orientation: "landscape",
      pageSizeMm: { widthMm: 297, heightMm: 210 },
      cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
      rows: 1,
      columns: 1,
      slots: [{ index: 0, row: 0, column: 0, xMm: 10, yMm: 10 }],
    };
    const malformed = [
      { ...valid, slots: [{ ...valid.slots[0], xMm: 250 }] },
      { ...valid, columns: 2, slots: [{ ...valid.slots[0] }, { ...valid.slots[0], index: 1, column: 1 }] },
      { ...valid, rows: 2_000, columns: 2_000 },
    ];

    for (const templateGeometry of malformed) {
      expect(() => parseTemplateMetadata({ ...metadataInput, templateGeometry }))
        .toThrowError(expect.objectContaining({ code: "TEMPLATE_METADATA_INVALID" }));
    }
  });

  it.each([
    ["unknown metadata", { ...metadataInput, localPath: "/srv/private/template.studio3" }],
    ["empty name", { ...metadataInput, name: "  " }],
    ["unsupported paper", { ...metadataInput, paper: "A0" }],
    ["unsupported card format", { ...metadataInput, cardFormat: "unknown" }],
    ["unsupported orientation", { ...metadataInput, orientation: "diagonal" }],
    ["unsupported registration type", { ...metadataInput, registrationType: "automatic" }],
    ["registration type mismatch", { ...metadataInput, registrationConfig: createDefaultRegistrationConfig("four-point") }],
    ["non-finite bleed", { ...metadataInput, recommendedBleedMm: Number.NaN }],
    ["bleed above the physical limit", { ...metadataInput, recommendedBleedMm: 3.001 }],
  ])("rejects %s with a clear validation error", (_description, value) => {
    expect(() => parseTemplateMetadata(value)).toThrowError(expect.objectContaining({ code: "TEMPLATE_METADATA_INVALID" }));
  });

  it("validates a studio3 as opaque non-empty bytes and calculates its SHA-256", () => {
    const bytes = new Uint8Array([0, 255, 60, 115, 116, 117, 100, 105, 111, 51]);

    expect(validateTemplateFile("official.studio3", bytes)).toMatchObject({
      fileName: "official.studio3",
      extension: "studio3",
      byteLength: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("rejects empty, oversized, path-bearing, and unsupported template files", () => {
    expect(() => validateTemplateFile("empty.studio3", new Uint8Array())).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_FILE_INVALID" }),
    );
    expect(() => validateTemplateFile("../official.studio3", new Uint8Array([1]))).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_FILE_NAME_INVALID" }),
    );
    expect(() => validateTemplateFile("template.exe", new Uint8Array([1]))).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_FILE_TYPE_UNSUPPORTED" }),
    );
    expect(() => validateTemplateFile("large.studio3", new Uint8Array(5), { maxFileBytes: 4 })).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_FILE_TOO_LARGE" }),
    );
  });

  it("accepts a well-formed SVG without executing scripts or resolving external resources", () => {
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><script>throw 1</script><image href="https://example.invalid/a.png"/></svg>');

    expect(validateTemplateFile("cut.svg", bytes)).toMatchObject({
      extension: "svg",
      mediaType: "image/svg+xml",
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it.each([
    ["malformed XML", "<svg><path></svg>"],
    ["a document type declaration", '<!DOCTYPE svg [<!ENTITY x "unsafe">]><svg>&x;</svg>'],
    ["a non-SVG root", "<html/>"],
  ])("rejects SVG with %s", (_description, value) => {
    expect(() => validateTemplateFile("cut.svg", new TextEncoder().encode(value))).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_FILE_INVALID" }),
    );
  });

  it("checks DXF structure while preserving the source bytes for storage", () => {
    expect(validateTemplateFile("cut.dxf", dxf)).toMatchObject({
      extension: "dxf",
      mediaType: "application/dxf",
      contentHash: createHash("sha256").update(dxf).digest("hex"),
    });
    expect(() => validateTemplateFile("cut.dxf", new TextEncoder().encode("0\nSECTION\n2\nENTITIES\n"))).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_FILE_INVALID" }),
    );
  });

  it("validates large text DXFs pair-by-pair without changing their original identity", () => {
    const source = `0\nSECTION\n2\nHEADER\n${"9\n$CUSTOM\n".repeat(100_000)}0\nENDSEC\n0\nEOF\n`;
    const bytes = new TextEncoder().encode(source);

    expect(validateTemplateFile("large-cut.dxf", bytes)).toMatchObject({
      extension: "dxf",
      byteLength: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("requires valid bounded JSON for associated JSON files", () => {
    expect(validateTemplateFile("template.json", new TextEncoder().encode('{"name":"A4 Standard"}')).extension).toBe("json");
    expect(() => validateTemplateFile("template.json", new TextEncoder().encode("{bad}"))).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_FILE_INVALID" }),
    );
  });

  it("computes a stable package identity independent of upload order", () => {
    const metadata = parseTemplateMetadata(metadataInput);
    const svg = validateTemplateFile("cut.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    const studio = validateTemplateFile("template.studio3", new Uint8Array([1, 2, 3]));
    const files = [
      { ...svg, relativePath: "cut.svg" },
      { ...studio, relativePath: "template.studio3" },
    ];

    const hash = calculateTemplatePackageHash(metadata, files);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(calculateTemplatePackageHash(metadata, [...files].reverse())).toBe(hash);
    expect(calculateTemplatePackageHash({ ...metadata, version: "v6" }, files)).not.toBe(hash);
  });
});
