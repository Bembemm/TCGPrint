import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument } from "@pdfme/pdf-lib";
import yauzl from "yauzl";

const root = join(process.cwd(), "artifacts/phase-12-duplex-validation");
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function zipMembers(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("Could not read ZIP archive."));
      const members = new Map();
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("Could not read ZIP member."));
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            members.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(members));
      zip.readEntry();
    });
  });
}

for (const item of [...manifest.files, ...manifest.fixtureArtworkFiles]) {
  const bytes = await readFile(join(root, item.filename));
  assert(bytes.byteLength === item.bytes, `Byte length mismatch: ${item.filename}`);
  assert(sha256(bytes) === item.sha256, `SHA-256 mismatch: ${item.filename}`);
}

let pdfCount = 0;
for (const item of manifest.files.filter(({ filename }) => filename.endsWith(".pdf"))) {
  const pdf = await PDFDocument.load(await readFile(join(root, item.filename)));
  const expectedPages = item.filename.endsWith("duplex-interleaved.pdf") ? 2 : 1;
  assert(pdf.getPageCount() === expectedPages, `Page count mismatch: ${item.filename}`);
  pdfCount += 1;
}

for (const run of manifest.runs) {
  const pairs = run.pagePairs;
  assert(pairs.length === 1, `${run.orientation} should have one front page pair in the 9-card fixture.`);
  const pair = pairs[0];
  const expectedAxis = run.orientation === "portrait" ? "x" : "y";
  assert(pair.reflectionAxis === expectedAxis, `Wrong physical mirror axis for ${run.orientation} + ${run.flipMode}.`);
  const expectedArtworkRotation = expectedAxis === "y" ? 180 : 0;
  assert(pair.backArtworkOrientation.rotationDegrees === expectedArtworkRotation, `Wrong back artwork rotation for ${run.orientation} + ${run.flipMode}.`);
  assert(pair.registrationReflectionAxis === expectedAxis, `Wrong registration transform for ${run.orientation} + ${run.flipMode}.`);
  assert(run.separateManifest.pagePairs[0].backArtworkRotationDegrees === expectedArtworkRotation, `Separate manifest omits back artwork rotation for ${run.orientation} + ${run.flipMode}.`);
  const slots = Array.from({ length: 9 }, () => "blank");
  for (const slot of pair.slots) {
    if (slot.physicalCardNumber !== null && !slot.skipped && !slot.reserved) {
      slots[slot.backSlotNumber - 1] = `TOP ↑ ${slot.physicalCardNumber}B`;
    }
  }
  const rows = [slots.slice(0, 3), slots.slice(3, 6), slots.slice(6, 9)];
  assert(JSON.stringify(rows) === JSON.stringify(run.expectedNumberedFixture), `Numbered slot map does not match ${run.orientation} fixture.`);

  const zipName = `${run.orientation}-${run.flipMode}-front-back-separate.zip`;
  const zip = await zipMembers(join(root, zipName));
  assert([...zip.keys()].sort().join(",") === "back.pdf,front.pdf,manifest.json", `Unexpected separate ZIP members: ${zipName}`);
  const separateManifest = JSON.parse(zip.get("manifest.json").toString("utf8"));
  assert(separateManifest.frontPdf.sha256 === sha256(zip.get("front.pdf")), `Front member hash mismatch: ${zipName}`);
  assert(separateManifest.backPdf.sha256 === sha256(zip.get("back.pdf")), `Back member hash mismatch: ${zipName}`);
  assert(separateManifest.pagePairs[0].backPageNumber === separateManifest.pagePairs[0].frontPageNumber, `Separate pair number mismatch: ${zipName}`);
}

console.log(`Verified ${manifest.files.length} output hashes, ${manifest.fixtureArtworkFiles.length} numbered source-art hashes, ${pdfCount} PDF page counts, 2 ZIP manifests, and portrait/landscape slot mappings.`);
