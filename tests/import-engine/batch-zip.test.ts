import { describe, expect, it } from "vitest";
import { ImportCancelledError, importFiles } from "../../import-engine";
import { makeSyntheticZip } from "../helpers/zip";
import type { ImportFileInput, UniversalImportRequest } from "../../import-engine/types";

const bytes = (text: string) => new TextEncoder().encode(text);
const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

function file(filename: string, text: string, sourcePath?: string): ImportFileInput {
  return { filename, bytes: bytes(text), ...(sourcePath ? { sourcePath, kind: "folder-file" as const } : {}) };
}

function requestForZip(zip: Uint8Array, filename = "batch.zip"): UniversalImportRequest {
  return { files: [{ filename, bytes: zip }] };
}

describe("universal batch import and secure ZIP handling", () => {
  it("imports normal and nested ZIP entries in order without filesystem extraction", async () => {
    const nested = makeSyntheticZip([{ name: "inside.txt", bytes: bytes("2 Island") }]);
    const zip = makeSyntheticZip([
      { name: "deck.txt", bytes: bytes("1 Sol Ring") },
      { name: "nested/cards.zip", bytes: nested },
    ]);
    const result = await importFiles(requestForZip(zip));
    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring", "Island"]);
    expect(result.entries.map((entry) => entry.quantity)).toEqual([1, 2]);
    expect(result.entries[1].sourcePath).toBe("nested/cards.zip!/inside.txt");
    expect(result.report.summary).toMatchObject({ totalInputs: 4, recognizedInputs: 4, deckEntries: 2, errors: 0 });
  });

  it("blocks traversal, absolute, drive and symlink entries individually", async () => {
    const zip = makeSyntheticZip([
      { name: "../escape.txt", bytes: bytes("Bad") },
      { name: "/absolute.txt", bytes: bytes("Bad") },
      { name: "C:/drive.txt", bytes: bytes("Bad") },
      { name: "link.txt", bytes: bytes("target"), symlink: true },
      { name: "safe.txt", bytes: bytes("1 Sol Ring") },
    ]);
    const result = await importFiles(requestForZip(zip));
    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring"]);
    expect(result.report.errors.map((error) => error.code)).toContain("ZIP_UNSAFE_PATH");
    expect(result.report.errors.map((error) => error.code)).toContain("ZIP_SYMLINK_BLOCKED");
    expect(result.report.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("enforces configurable entry count, entry size, aggregate size and compression ratio limits", async () => {
    const tooMany = makeSyntheticZip([
      { name: "a.txt", bytes: bytes("1 A") }, { name: "b.txt", bytes: bytes("1 B") },
    ]);
    const countResult = await importFiles(requestForZip(tooMany), { limits: { maxZipEntries: 1 } });
    expect(countResult.report.errors.some((error) => error.code === "ZIP_ENTRY_LIMIT")).toBe(true);

    const oversized = makeSyntheticZip([{ name: "large.txt", bytes: bytes("123456789") }]);
    const sizeResult = await importFiles(requestForZip(oversized), { limits: { maxZipEntryBytes: 8 } });
    expect(sizeResult.report.errors.some((error) => error.code === "ZIP_SIZE_LIMIT")).toBe(true);

    const aggregate = makeSyntheticZip([
      { name: "a.txt", bytes: bytes("1234") }, { name: "b.txt", bytes: bytes("5678") },
    ]);
    const aggregateResult = await importFiles(requestForZip(aggregate), { limits: { maxZipTotalUncompressedBytes: 6 } });
    expect(aggregateResult.report.errors.some((error) => error.code === "ZIP_SIZE_LIMIT")).toBe(true);

    const compressed = makeSyntheticZip([{ name: "repeat.txt", bytes: bytes("a".repeat(5000)), compression: "deflate" }]);
    const ratioResult = await importFiles(requestForZip(compressed), { limits: { maxZipCompressionRatio: 2 } });
    expect(ratioResult.report.errors.some((error) => error.code === "ZIP_RATIO_LIMIT")).toBe(true);

    const archiveLimit = await importFiles(requestForZip(tooMany), { limits: { maxZipArchiveBytes: tooMany.byteLength - 1 } });
    expect(archiveLimit.report.errors.some((error) => error.code === "ZIP_SIZE_LIMIT")).toBe(true);

    const inner = makeSyntheticZip([{ name: "leaf.txt", bytes: bytes("Island") }]);
    const middle = makeSyntheticZip([{ name: "inner.zip", bytes: inner }]);
    const outer = makeSyntheticZip([{ name: "middle.zip", bytes: middle }]);
    const depthResult = await importFiles(requestForZip(outer), { limits: { maxZipNestingDepth: 1 } });
    expect(depthResult.report.errors.some((error) => error.code === "ZIP_DEPTH_LIMIT")).toBe(true);
  });

  it("keeps valid files when one XML entry fails and reports ambiguous and unknown input", async () => {
    const result = await importFiles({ files: [
      file("broken.xml", "<order><fronts>"),
      file("valid.txt", "1 Sol Ring"),
    ] });
    expect(result.entries.map((entry) => entry.cardHint?.name)).toEqual(["Sol Ring"]);
    expect(result.report.errors).toHaveLength(1);

    const ambiguous = await importFiles({ text: "name,count\tset\nSol Ring,1\tCMM" });
    expect(ambiguous.report.summary.ambiguousDetections).toBe(1);
    expect(ambiguous.entries).toHaveLength(0);
    const unknown = await importFiles({ files: [{ filename: "mystery.bin", bytes: new Uint8Array([0xff, 0x00, 0x03]) }] });
    expect(unknown.report.summary.unknownInputs).toBe(1);
  });

  it("suggests only high confidence folder front/back pairs and flags duplicate matches", async () => {
    const paired = await importFiles({ files: [
      { filename: "card-front.svg", bytes: svg, sourcePath: "Deck/Card-Front.svg", kind: "folder-file" },
      { filename: "card-back.svg", bytes: svg, sourcePath: "Deck/Card-Back.svg", kind: "folder-file" },
    ] });
    expect(paired.report.pairings).toHaveLength(1);
    expect(paired.report.pairings[0]).toMatchObject({ confidence: 0.99, accepted: false });

    const ambiguous = await importFiles({ files: [
      { filename: "Card-Front.svg", bytes: svg, sourcePath: "Deck/Card-Front.svg", kind: "folder-file" },
      { filename: "card-front.svg", bytes: svg, sourcePath: "Deck/card-front.svg", kind: "folder-file" },
      { filename: "card-back.svg", bytes: svg, sourcePath: "Deck/card-back.svg", kind: "folder-file" },
    ] });
    expect(ambiguous.report.pairings).toHaveLength(0);
    expect(ambiguous.report.warnings.some((warning) => warning.code === "AMBIGUOUS_ASSET_PAIRING")).toBe(true);
  });

  it("reports progress and returns no partial result after cancellation", async () => {
    const progress: number[] = [];
    const result = await importFiles({ files: [file("one.txt", "Sol Ring"), file("two.txt", "Island")] }, {
      onProgress: (event) => progress.push(event.completed),
    });
    expect(progress).toEqual([1, 2]);
    const controller = new AbortController();
    controller.abort();
    await expect(importFiles({ files: [file("one.txt", "Sol Ring")] }, { signal: controller.signal }))
      .rejects.toBeInstanceOf(ImportCancelledError);

    const midBatchController = new AbortController();
    const nestedZip = makeSyntheticZip([{ name: "one.txt", bytes: bytes("Sol Ring") }, { name: "two.txt", bytes: bytes("Island") }]);
    await expect(importFiles(requestForZip(nestedZip), {
      signal: midBatchController.signal,
      onProgress: (event) => {
        if (event.phase === "zip-entry" && event.completed === 1) midBatchController.abort();
      },
    })).rejects.toBeInstanceOf(ImportCancelledError);
  });

  it("aggregates a preview report without resolving names or persisting a project", async () => {
    const result = await importFiles({ files: [
      { filename: "upload.png", bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]) },
      { filename: "unknown.bin", bytes: new Uint8Array([0xff, 0x00, 0x01]) },
    ] });
    expect(result.report.summary).toMatchObject({ totalInputs: 2, customCards: 0, errors: 1, unknownInputs: 1 });
    expect(result.report.selectedImporters.map((item) => item.kind)).toContain("unknown");
    expect(result.entries.some((entry) => entry.cardHint?.name === "upload")).toBe(false);
  });

  it("keeps an unrecognized card image as an importable custom card with exact bytes", async () => {
    const customSvg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3" viewBox="0 0 2 3"><rect width="2" height="3"/></svg>');
    const result = await importFiles({ files: [{ filename: "IMG_8372.png", bytes: customSvg }] });
    expect(result.entries[0]).toMatchObject({
      kind: "custom-card",
      nameSuggestion: "IMG_8372",
      asset: { originalFormat: "svg", sha256: expect.any(String) },
    });
    expect(result.entries[0].asset?.originalBytes).toBe(customSvg);
    expect(result.sources[0].originalFormat).toBe("svg");
  });

  it("surfaces a content-versus-extension mismatch in the report for structured inputs", async () => {
    const result = await importFiles({ files: [{
      filename: "deck.txt",
      bytes: bytes('{"cards":[{"name":"Sol Ring"}]}'),
    }] });
    expect(result.entries[0].cardHint?.name).toBe("Sol Ring");
    expect(result.report.warnings.some((item) => item.code === "EXTENSION_MISMATCH")).toBe(true);
  });
});
