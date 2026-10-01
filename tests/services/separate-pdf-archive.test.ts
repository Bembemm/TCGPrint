import { describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { createSeparatePdfArchive } from "../../services/separate-pdf-archive";

function readEntries(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("zip missing"));
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("entry stream missing"));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}

describe("separate PDF archive", () => {
  it("packages independently printable PDFs and a manifest without changing either PDF stream", async () => {
    const front = Buffer.from("front-pdf-bytes");
    const back = Buffer.from("back-pdf-bytes");
    const manifest = { projectRevision: 9, flipMode: "short-edge", pageOrientation: "landscape", pagePairs: [{ frontPageNumber: 1, backPageNumber: 1 }] };
    const archive = createSeparatePdfArchive([
      { filename: "front.pdf", bytes: new Uint8Array(front) },
      { filename: "back.pdf", bytes: new Uint8Array(back) },
      { filename: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
    ]);

    expect(Buffer.from(archive).readUInt32LE(0)).toBe(0x04034b50);
    const entries = await readEntries(archive);
    expect([...entries.keys()]).toEqual(["front.pdf", "back.pdf", "manifest.json"]);
    expect(entries.get("front.pdf")).toEqual(front);
    expect(entries.get("back.pdf")).toEqual(back);
    expect(JSON.parse(entries.get("manifest.json")!.toString("utf8"))).toEqual(manifest);
  });
});
