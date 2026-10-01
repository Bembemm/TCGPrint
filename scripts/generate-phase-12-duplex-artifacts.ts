import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { MAGIC_STANDARD_CARD } from "../core/geometry";
import type { WorkingCard } from "../core/cards/types";
import { exportWorkingCardsByContentMode } from "../services/card-export";
import { createSeparatePdfArchive } from "../services/separate-pdf-archive";
import type { ArtworkCandidate } from "../core/cards/types";
import type { ArtworkOriginal } from "../artwork/storage/types";

const OUTPUT_DIRECTORY = join(process.cwd(), "artifacts/phase-12-duplex-validation");
const SVG_FIXTURE_DIRECTORY = join(OUTPUT_DIRECTORY, "fixtures");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

function svgFace(number: number, side: "front" | "back"): Uint8Array {
  const id = `${String(number).padStart(2, "0")}${side === "front" ? "F" : "B"}`;
  const background = side === "front" ? "#fff7ed" : "#dbeafe";
  const foreground = side === "front" ? "#7f1d1d" : "#1e3a8a";
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560"><rect width="400" height="560" fill="${background}"/><rect x="12" y="12" width="376" height="536" rx="22" fill="none" stroke="${foreground}" stroke-width="8"/><path d="M200 46 L150 126 L181 126 L181 196 L219 196 L219 126 L250 126 Z" fill="${foreground}"/><text x="200" y="244" text-anchor="middle" font-family="sans-serif" font-size="40" font-weight="700" fill="${foreground}">TOP ↑</text><text x="34" y="500" font-family="sans-serif" font-size="42" font-weight="700" fill="${foreground}">${id}</text><text x="350" y="78" text-anchor="end" font-family="sans-serif" font-size="24" fill="${foreground}">RIGHT</text></svg>`);
}

async function createFixtureCatalog() {
  const candidates = new Map<string, ArtworkCandidate>();
  const originals = new Map<string, ArtworkOriginal>();
  const cards: WorkingCard[] = [];
  const fixtureArtworkFiles: Array<{ filename: string; sha256: string; bytes: number }> = [];
  for (let index = 1; index <= 9; index += 1) {
    const identityId = `fixture:oracle:duplex-${index}`;
    const faceCandidates = {} as Record<"front" | "back", ArtworkCandidate>;
    for (const side of ["front", "back"] as const) {
      const candidateId = `fixture:${index}:${side}`;
      const svgBytes = svgFace(index, side);
      const bytes = new Uint8Array(await sharp(svgBytes).png().toBuffer());
      const hash = sha256(bytes);
      const candidate: ArtworkCandidate = {
        id: candidateId,
        source: "upload",
        identityId,
        faceId: side,
        originalAvailable: true,
        widthPx: 400,
        heightPx: 560,
        metadata: { contentHash: hash, fixture: "phase-12-numbered-asymmetric" },
      };
      const original: ArtworkOriginal = {
        artworkId: hash,
        contentHash: hash,
        extension: "png",
        format: "png",
        byteLength: bytes.byteLength,
        widthPx: 400,
        heightPx: 560,
        createdAt: "2026-10-01T00:00:00.000Z",
        bytes,
        provenance: [{ provider: "phase-12-validation-fixture", originalFilename: `numbered-${String(index).padStart(2, "0")}-${side}.png` }],
      };
      candidates.set(candidateId, candidate);
      originals.set(candidateId, original);
      faceCandidates[side] = candidate;
      const fixtureName = `numbered-${String(index).padStart(2, "0")}-${side}`;
      const svgFilename = `${fixtureName}.svg`;
      const pngFilename = `${fixtureName}.png`;
      await writeFile(join(SVG_FIXTURE_DIRECTORY, svgFilename), svgBytes);
      await writeFile(join(SVG_FIXTURE_DIRECTORY, pngFilename), bytes);
      fixtureArtworkFiles.push(
        { filename: `fixtures/${svgFilename}`, sha256: sha256(svgBytes), bytes: svgBytes.byteLength },
        { filename: `fixtures/${pngFilename}`, sha256: hash, bytes: bytes.byteLength },
      );
    }
    const name = `Fixture card ${String(index).padStart(2, "0")}`;
    cards.push({
      id: `fixture-card-${index}`,
      quantity: 1,
      order: index - 1,
      importSource: { sourceId: `fixture:phase-12:${index}`, importKind: "fixture", entryKind: "card" },
      identityHints: { name },
      identity: {
        id: identityId,
        provider: "fixture",
        name: `${name} // ${name} back`,
        resolutionMethod: "custom",
        confidence: 1,
        metadata: { layout: "transform", faces: [{ name }, { name: `${name} back` }] },
      },
      identityResolution: { status: "resolved", method: "custom", confirmed: true, candidates: [] },
      faces: [{ id: "front", side: "front", name }, { id: "back", side: "back", name: `${name} back` }],
      selectedArtworkByFace: {
        front: { candidateId: faceCandidates.front.id, source: "upload", identityId, faceId: "front" },
        back: { candidateId: faceCandidates.back.id, source: "upload", identityId, faceId: "back" },
      },
      backMode: "auto",
      backModeSelectionPolicy: "automatic",
      localArtworkIds: [],
      mpcReferences: [],
      faceAssociations: [],
    });
  }
  return {
    cards,
    fixtureArtworkFiles,
    catalog: {
      getArtworkCandidate: async (id: string) => candidates.get(id),
      getArtworkOriginal: async (id: string) => {
        const original = originals.get(id);
        if (!original) throw new Error(`Missing validation fixture original ${id}`);
        return original;
      },
    },
  };
}

export async function generatePhase12Artifacts(): Promise<void> {
  await mkdir(SVG_FIXTURE_DIRECTORY, { recursive: true });
  let productionSmoke: unknown;
  try {
    const previousManifest = JSON.parse(await readFile(join(OUTPUT_DIRECTORY, "manifest.json"), "utf8")) as { productionSmoke?: unknown };
    productionSmoke = previousManifest.productionSmoke;
  } catch {
    productionSmoke = undefined;
  }
  const numberedFixture = JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/duplex/numbered-slot-fixture.json"), "utf8")) as Record<string, unknown>;
  const { cards, catalog, fixtureArtworkFiles } = await createFixtureCatalog();
  const written: Array<{ filename: string; sha256: string; bytes: number }> = [];
  const runs: Array<Record<string, unknown>> = [];

  for (const { orientation, flipMode } of [
    { orientation: "portrait" as const, flipMode: "long-edge" as const },
    { orientation: "landscape" as const, flipMode: "long-edge" as const },
  ]) {
    const prefix = `${orientation}-${flipMode}`;
    const paperFormat = orientation === "portrait"
      ? { name: "A4", widthMm: 210, heightMm: 297 }
      : { name: "A3", widthMm: 297, heightMm: 420 };
    const common = {
      bleedMm: 0,
      cutGuides: {
        trim: { enabled: false, extentMm: 1 as const, color: "blue" as const },
        external: { enabled: false, strokeWidthPt: 0.3, color: "black" as const },
      },
      pageOrientation: orientation,
      cardOrientation: "portrait" as const,
      paperFormat,
      cardFormat: MAGIC_STANDARD_CARD,
      layoutRows: 3,
      layoutColumns: 3,
      duplexFlipMode: flipMode,
      missingBackPolicy: "block" as const,
    };
    const modeResults = await Promise.all([
      exportWorkingCardsByContentMode(catalog, undefined, cards, { ...common, exportContentMode: "front-only" }),
      exportWorkingCardsByContentMode(catalog, undefined, cards, { ...common, exportContentMode: "back-only" }),
      exportWorkingCardsByContentMode(catalog, undefined, cards, { ...common, exportContentMode: "front-back-separated" }),
      exportWorkingCardsByContentMode(catalog, undefined, cards, { ...common, exportContentMode: "duplex" }),
    ]);
    const [front, back, separate, duplex] = modeResults;
    const frontBytes = front.pdfBytes!;
    const backBytes = back.pdfBytes!;
    const separatedFront = separate.frontPdfBytes!;
    const separatedBack = separate.backPdfBytes!;
    const separateManifestBytes = new TextEncoder().encode(JSON.stringify(separate.manifest, null, 2) + "\n");
    const archive = createSeparatePdfArchive([
      { filename: "front.pdf", bytes: separatedFront },
      { filename: "back.pdf", bytes: separatedBack },
      { filename: "manifest.json", bytes: separateManifestBytes },
    ]);
    const outputs = [
      [`${prefix}-front-only.pdf`, frontBytes],
      [`${prefix}-back-only.pdf`, backBytes],
      [`${prefix}-front-back-separate-front.pdf`, separatedFront],
      [`${prefix}-front-back-separate-back.pdf`, separatedBack],
      [`${prefix}-front-back-separate.zip`, archive],
      [`${prefix}-front-back-separate-manifest.json`, separateManifestBytes],
      [`${prefix}-duplex-interleaved.pdf`, duplex.pdfBytes!],
    ] as const;
    for (const [filename, bytes] of outputs) {
      await writeFile(join(OUTPUT_DIRECTORY, filename), bytes);
      written.push({ filename, sha256: sha256(bytes), bytes: bytes.byteLength });
    }
    const plan = back.pagePairingPlan!;
    runs.push({
      orientation,
      flipMode,
      pageCount: plan.pagePairs.length,
      duplexPageCount: duplex.pageOrder?.length,
      expectedNumberedFixture: numberedFixture[`${orientation}-${flipMode}`],
      pagePairs: plan.pagePairs.map((pair) => ({
        frontPageNumber: pair.frontPageNumber,
        backPageNumber: pair.backPageNumber,
        reflectionAxis: pair.reflectionAxis,
        backArtworkOrientation: pair.backPageTransform.artworkOrientation,
        registrationReflectionAxis: pair.backPageTransform.registrationReflectionAxis,
        slots: pair.slots.map((slot) => ({
          physicalCardNumber: slot.physicalCardIndex === undefined ? null : slot.physicalCardIndex + 1,
          frontSlotNumber: slot.frontSlotIndex + 1,
          backSlotNumber: slot.backSlotIndex + 1,
          skipped: slot.skippedByUser,
          reserved: slot.reserved,
        })),
      })),
      separateManifest: separate.manifest,
    });
  }

  await writeFile(join(SVG_FIXTURE_DIRECTORY, "numbered-slot-mapping.json"), JSON.stringify(numberedFixture, null, 2) + "\n");
  const manifest = {
    schemaVersion: 1,
    validation: "duplex pairing/geometry validated in software",
    physicalAlignmentValidated: false,
    calibration: "not included; Phase 13 owns measured printer correction",
    physicalCardsPerRun: cards.reduce((sum, card) => sum + card.quantity, 0),
    doubleFacedCardsPerRun: cards.length,
    simpleCardsPerRun: 0,
    sourceArtwork: "18 independent lossless PNG originals rendered from the included asymmetric SVG fixture art; each face has its own SHA-256, TOP arrow and numbered front/back ID",
    fixtureArtworkFiles: fixtureArtworkFiles.sort((left, right) => left.filename.localeCompare(right.filename)),
    runs,
    ...(productionSmoke !== undefined ? { productionSmoke } : {}),
    files: written.sort((left, right) => left.filename.localeCompare(right.filename)),
  };
  await writeFile(join(OUTPUT_DIRECTORY, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const readme = [
    "# Phase 12 duplex software validation artifacts",
    "",
    "These files were generated through exportWorkingCardsByContentMode, the shared duplex page plan, and the existing lossless PDF engine. The portrait run uses A4; the landscape run uses A3. Both use 3×3 slots and long-edge flip. Each face uses an independent, numbered SVG original with an asymmetric TOP arrow. The back PDF vector placement rotates 180° in the two Y-reflection cases so the artwork reads upright after the sheet is flipped.",
    "",
    "Each orientation includes front-only, back-only, two separate PDF files, a ZIP containing those same PDFs plus its pairing manifest, and an interleaved duplex PDF. The adjacent manifest records exact page/slot mappings, registration reflection, artwork rotation, and SHA-256 hashes. The global manifest.json records hashes for every generated output and hashes of the numbered SVG and PNG source fixtures.",
    "",
    "The production build smoke exercised an imported Delver of Secrets DFC and Sol Ring through the UI, resolved both with Scryfall, chose an alternate DFC back manually, reopened the Project, re-resolved, and confirmed the manual face reference remained unchanged. It uploaded the included numbered PNG into Back Library, saved it as the Project default, and confirmed Sol Ring inherited it while the DFC stayed manual. Production API exports returned HTTP 200 for front-only, back-only, separate (two independent PDFs plus manifest in a ZIP), and duplex. See production-smoke.md for the recorded sequence.",
    "",
    "Validation statement: duplex pairing/geometry validated in software. No printer was used; no physical front/back alignment or calibration is claimed.",
    "",
  ].join("\n");
  await writeFile(join(OUTPUT_DIRECTORY, "README.md"), readme);
}
