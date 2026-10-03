import { describe, expect, it, vi } from "vitest";
import type { WorkingCard } from "../../core/cards/types";
import { mpcArtworkCandidateId } from "../../core/cards/ids";
import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "../../core/cards/limits";
import {
  DEFAULT_PROJECT_SETTINGS,
  MAX_PROJECT_SNAPSHOT_BYTES,
  deserializeProjectSnapshot,
  serializeProjectSnapshot,
} from "../../persistence/projects/serializer";
import { computePrinterProfileHash } from "../../persistence/printer-profiles/hash";

function singleFaceCard(): WorkingCard {
  return {
    id: "working-card-1",
    quantity: 1,
    order: 0,
    importSource: { sourceId: "source-1", importKind: "text", entryKind: "card" },
    identityHints: { name: "Sol Ring" },
    identity: null,
    identityResolution: { status: "unresolved", candidates: [], confirmed: false },
    faces: [{ id: "front", side: "front", name: "Sol Ring" }],
    selectedArtworkByFace: {},
    backMode: "project-default",
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
    metadata: { transientImportDetail: "must not persist" },
  };
}

describe("project snapshot serializer", () => {
  it.each(["filename", "ocr"] as const)("round-trips legacy %s identity resolution metadata without migration", (method) => {
    const card: WorkingCard = {
      ...singleFaceCard(),
      importSource: { sourceId: "legacy-upload", filename: "Island.png", importKind: "image", entryKind: "custom-card" },
      identityHints: { name: "Island" },
      identity: { id: "scryfall:oracle:legacy-island", provider: "scryfall", name: "Island", resolutionMethod: method, confidence: 0.99 },
      identityResolution: { status: "resolved", method, query: "Island", candidates: [], confirmed: false },
    };
    const roundTrip = deserializeProjectSnapshot(serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS));

    expect(roundTrip.projectSchemaVersion).toBe(5);
    expect(roundTrip.cards[0]).toMatchObject({
      importSource: { filename: "Island.png", entryKind: "custom-card" },
      identityHints: { name: "Island" },
      identity: { name: "Island", resolutionMethod: method },
      identityResolution: { status: "resolved", method, query: "Island", confirmed: false },
    });
  });

  it("serializes and validates snapshots without relying on Node Buffer", () => {
    vi.stubGlobal("Buffer", undefined);

    try {
      const encoded = serializeProjectSnapshot([singleFaceCard()], DEFAULT_PROJECT_SETTINGS);
      expect(deserializeProjectSnapshot(encoded).cards[0]?.id).toBe("working-card-1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips a single-face current project and omits transient WorkingCard metadata", () => {
    const card = singleFaceCard();

    const encoded = serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS);
    const snapshot = deserializeProjectSnapshot(encoded);

    expect(snapshot).toEqual({
      projectSchemaVersion: 5,
      cards: [{
        id: "working-card-1",
        quantity: 1,
        order: 0,
        importSource: { sourceId: "source-1", importKind: "text", entryKind: "card" },
        identityHints: { name: "Sol Ring" },
        identity: null,
        identityResolution: { status: "unresolved", candidates: [], confirmed: false },
        faces: [{ id: "front", side: "front", name: "Sol Ring" }],
        selectedArtworkByFace: {},
        backMode: "project-default",
        backModeSelectionPolicy: "automatic",
        localArtworkIds: [],
        mpcReferences: [],
        faceAssociations: [],
      }],
      settings: {
        bleedMm: 0.625,
        roundedCorners: false,
        cutGuides: {
          trim: { enabled: false, extentMm: 1, color: "blue" },
          external: { enabled: false, strokeWidthPt: 0.3, color: "black" },
        },
        pageOrientation: "portrait",
        cardOrientation: "portrait",
        paperFormat: DEFAULT_PROJECT_SETTINGS.paperFormat,
        cardFormat: DEFAULT_PROJECT_SETTINGS.cardFormat,
        marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
        horizontalGapMm: 0,
        verticalGapMm: 0,
        registration: { type: "none", orientation: "portrait" },
        registrationOverride: false,
        cutSourceSelection: null,
        exportContentMode: "front-only",
        missingBackPolicy: "use-project-default",
        duplexFlipMode: "long-edge",
        projectDefaultBack: null,
        printerProfileSelection: null,
        printerDuplexMode: "single-sided",
        layout: { skippedSlotIndices: [] },
      },
    });
  });

  it("migrates a legacy v1 project deterministically to v4 defaults", () => {
    const legacy = {
      projectSchemaVersion: 1,
      cards: [],
      settings: {
        bleedMm: DEFAULT_PROJECT_SETTINGS.bleedMm,
        roundedCorners: DEFAULT_PROJECT_SETTINGS.roundedCorners,
        cutGuides: DEFAULT_PROJECT_SETTINGS.cutGuides,
      },
    };

    expect(deserializeProjectSnapshot(legacy)).toMatchObject({
      projectSchemaVersion: 5,
      settings: {
        pageOrientation: "portrait",
        cardOrientation: "portrait",
        registration: { type: "none", orientation: "portrait" },
        registrationOverride: false,
        cutSourceSelection: null,
        exportContentMode: "front-only",
        missingBackPolicy: "use-project-default",
        duplexFlipMode: "long-edge",
        projectDefaultBack: null,
        layout: { skippedSlotIndices: [] },
      },
    });
  });

  it("migrates Phase 10 schema-2 snapshots without requiring a cut-source selection", () => {
    const {
      cutSourceSelection: _cutSourceSelection,
      exportContentMode: _exportContentMode,
      missingBackPolicy: _missingBackPolicy,
      duplexFlipMode: _duplexFlipMode,
      projectDefaultBack: _projectDefaultBack,
      printerProfileSelection: _printerProfileSelection,
      printerDuplexMode: _printerDuplexMode,
      ...phase10Settings
    } = DEFAULT_PROJECT_SETTINGS;
    expect(deserializeProjectSnapshot({ projectSchemaVersion: 2, cards: [], settings: phase10Settings })).toMatchObject({
      projectSchemaVersion: 5,
      settings: { cutSourceSelection: null, registrationOverride: false },
    });
  });

  it("persists registration orientation, custom geometry, and skipped slot settings", () => {
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      pageOrientation: "landscape" as const,
      cardOrientation: "portrait" as const,
      marginsMm: { top: 5, right: 6, bottom: 7, left: 8 },
      horizontalGapMm: 2.5,
      verticalGapMm: 3,
      registration: {
        type: "custom" as const,
        orientation: "landscape" as const,
        marks: [[{ type: "line" as const, x1Mm: 10, y1Mm: 10, x2Mm: 20, y2Mm: 10, strokeWidthMm: 0.5 }]],
        reservedZones: [{ xMm: 8, yMm: 8, widthMm: 14, heightMm: 4 }],
      },
      layout: {
        skippedSlotIndices: [0],
        templateGeometry: {
          orientation: "portrait" as const,
          cardOrientation: "portrait" as const,
          pageSizeMm: { widthMm: 210, heightMm: 297 },
          cardSizeMm: { widthMm: 63.5, heightMm: 88.9 },
          rows: 1,
          columns: 1,
          slots: [{ index: 0, row: 0, column: 0, xMm: 73.25, yMm: 104.05 }],
        },
      },
    };

    expect(deserializeProjectSnapshot(serializeProjectSnapshot([], settings)).settings).toEqual(settings);
  });

  it("persists an explicit Project registration override and defaults older snapshots to no override", () => {
    const encoded = serializeProjectSnapshot([], DEFAULT_PROJECT_SETTINGS);
    const legacySettings = JSON.parse(encoded) as { settings: Record<string, unknown> };
    delete legacySettings.settings.registrationOverride;
    const currentSettings = { ...DEFAULT_PROJECT_SETTINGS, registrationOverride: true };

    expect(deserializeProjectSnapshot(legacySettings).settings.registrationOverride).toBe(false);
    expect(deserializeProjectSnapshot(serializeProjectSnapshot([], currentSettings)).settings.registrationOverride).toBe(true);
  });

  it("round-trips a manual back lock and immutable Project default reference", () => {
    const asset = { assetId: `back:${"a".repeat(64)}`, sha256: "a".repeat(64), format: "png" as const };
    const card: WorkingCard = {
      ...singleFaceCard(),
      faces: [{ id: "front", side: "front" }, { id: "back", side: "back" }],
      selectedArtworkByFace: {
        back: {
          candidateId: `mpc:${"b".repeat(64)}`,
          source: "mpc",
          identityId: "scryfall:oracle:dfc",
          faceId: "back",
          providerAssetId: "provider-face-back",
          selectedArtworkId: "selected-back",
          selectionPolicy: "user-selected",
        },
      },
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
      manualBackAsset: asset,
    };
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      exportContentMode: "duplex" as const,
      duplexFlipMode: "short-edge" as const,
      projectDefaultBack: asset,
    };

    expect(deserializeProjectSnapshot(serializeProjectSnapshot([card], settings))).toMatchObject({
      projectSchemaVersion: 5,
      cards: [{
        backMode: "manual",
        backModeSelectionPolicy: "explicit",
        manualBackAsset: asset,
        selectedArtworkByFace: { back: { providerAssetId: "provider-face-back", selectedArtworkId: "selected-back", faceId: "back" } },
      }],
      settings: {
        exportContentMode: "duplex",
        duplexFlipMode: "short-edge",
        projectDefaultBack: asset,
      },
    });
  });

  it("round-trips a simple card's manual physical back artwork without adding a DFC face", () => {
    const card: WorkingCard = {
      ...singleFaceCard(),
      identity: { id: "scryfall:oracle:simple", provider: "scryfall", name: "Sol Ring", resolutionMethod: "manual", confidence: 1 },
      manualBackArtwork: {
        candidateId: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front",
        source: "scryfall",
        identityId: "scryfall:oracle:simple",
        faceId: "front",
        providerAssetId: "printing-123",
        selectedArtworkId: "artwork-123",
        selectionPolicy: "user-selected",
      },
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
    };

    expect(deserializeProjectSnapshot(serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS)).cards[0]).toMatchObject({
      faces: [{ side: "front" }],
      manualBackArtwork: { source: "scryfall", candidateId: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", faceId: "front", providerAssetId: "printing-123", selectedArtworkId: "artwork-123", selectionPolicy: "user-selected" },
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
    });
  });

  it("round-trips an MPC generic CARDBACK selection and its validated provider type", () => {
    const providerAssetId = "verified-mpc-cardback";
    const candidateId = mpcArtworkCandidateId(providerAssetId, "back");
    const card: WorkingCard = {
      ...singleFaceCard(),
      manualBackArtwork: {
        candidateId,
        source: "mpc",
        identityId: null,
        faceId: "back",
        providerAssetId,
        selectedArtworkId: providerAssetId,
        selectionPolicy: "user-selected",
      },
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
      mpcReferences: [{
        faceId: "back",
        importedAssetId: providerAssetId,
        providerAssetId,
        selectedArtworkId: providerAssetId,
        referenceOrigin: "gallery-selection",
        providerCardType: "CARDBACK",
        slots: [],
        availableLocally: false,
      }],
    };
    const restored = deserializeProjectSnapshot(serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS)).cards[0];

    expect(restored).toMatchObject({
      manualBackArtwork: { candidateId, source: "mpc", faceId: "back", selectionPolicy: "user-selected" },
      mpcReferences: [{ importedAssetId: providerAssetId, providerCardType: "CARDBACK" }],
      backMode: "manual",
    });
  });

  it("migrates a genuine schema-3 snapshot to safe front-only duplex defaults", () => {
    const current = JSON.parse(serializeProjectSnapshot([singleFaceCard()], DEFAULT_PROJECT_SETTINGS)) as {
      projectSchemaVersion: number;
      cards: Array<Record<string, unknown>>;
      settings: Record<string, unknown>;
    };
    current.projectSchemaVersion = 3;
    delete current.cards[0].backMode;
    delete current.cards[0].backModeSelectionPolicy;
    delete current.cards[0].manualBackAsset;
    delete current.settings.exportContentMode;
    delete current.settings.missingBackPolicy;
    delete current.settings.duplexFlipMode;
    delete current.settings.projectDefaultBack;
    delete current.settings.printerProfileSelection;
    delete current.settings.printerDuplexMode;

    expect(deserializeProjectSnapshot(current)).toMatchObject({
      projectSchemaVersion: 5,
      cards: [{ backMode: "project-default", backModeSelectionPolicy: "automatic" }],
      settings: {
        exportContentMode: "front-only",
        missingBackPolicy: "use-project-default",
        duplexFlipMode: "long-edge",
        projectDefaultBack: null,
      },
    });
  });

  it("requires skipped slots to have a fixed grid or versioned template geometry", () => {
    expect(() => serializeProjectSnapshot([], {
      ...DEFAULT_PROJECT_SETTINGS,
      layout: { skippedSlotIndices: [0] },
    })).toThrow(/skipped slots require .*fixed grid/i);
  });

  it("rejects a future logical snapshot version with an explicit version error", () => {
    expect(() => deserializeProjectSnapshot({ projectSchemaVersion: 6, cards: [], settings: {} }))
      .toThrowError(expect.objectContaining({ code: "FUTURE_PROJECT_SCHEMA_VERSION" }));
  });

  it("round-trips an exact immutable printer profile snapshot in Project v5", () => {
    const profile = {
      id: "profile-a4",
      name: "A4 manual",
      front: { offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 },
      back: { offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1.00012, scaleY: 0.99987 },
      paperSize: "A4",
      paperWidthMm: 210,
      paperHeightMm: 297,
      pageOrientation: "portrait" as const,
      duplexMode: "manual-long-edge" as const,
      physicalValidationStatus: "software-only" as const,
    };
    const printerProfileSelection = { ...profile, version: 2, profileHash: computePrinterProfileHash(profile, 2) };
    const settings = { ...DEFAULT_PROJECT_SETTINGS, printerProfileSelection, printerDuplexMode: "manual-long-edge" as const };

    const snapshot = deserializeProjectSnapshot(serializeProjectSnapshot([], settings));

    expect(snapshot.projectSchemaVersion).toBe(5);
    expect(snapshot.settings.printerProfileSelection).toEqual({
      ...printerProfileSelection,
      physicalVerification: null,
    });
    expect(snapshot.settings.printerDuplexMode).toBe("manual-long-edge");
  });

  it("migrates a genuine Project v4 snapshot to v5 with no calibration selection", () => {
    const v4 = JSON.parse(serializeProjectSnapshot([], DEFAULT_PROJECT_SETTINGS)) as {
      projectSchemaVersion: number;
      settings: Record<string, unknown>;
    };
    v4.projectSchemaVersion = 4;
    delete v4.settings.printerProfileSelection;
    delete v4.settings.printerDuplexMode;

    expect(deserializeProjectSnapshot(v4)).toMatchObject({
      projectSchemaVersion: 5,
      settings: { printerProfileSelection: null, printerDuplexMode: "single-sided" },
    });
  });

  it("rejects version zero instead of treating it as an implicit migration source", () => {
    expect(() => deserializeProjectSnapshot({ projectSchemaVersion: 0, cards: [], settings: {} }))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SCHEMA_VERSION" }));
  });

  it("rejects private bytes nested inside a persisted face", () => {
    const unsafeCard = {
      ...singleFaceCard(),
      faces: [{ id: "front", side: "front", originalBytes: new Uint8Array([1, 2, 3]) }],
    } as unknown as WorkingCard;

    expect(() => serializeProjectSnapshot([unsafeCard], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("rejects unknown filesystem references nested in persisted snapshot data", () => {
    const persisted = JSON.parse(serializeProjectSnapshot([singleFaceCard()], DEFAULT_PROJECT_SETTINGS)) as {
      cards: Array<{ faces: Array<Record<string, unknown>> }>;
    };
    persisted.cards[0].faces[0].originalUri = "file:///private/original.png";

    expect(() => deserializeProjectSnapshot(JSON.stringify(persisted)))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("rejects unsafe CardIdentity metadata instead of silently sanitizing it", () => {
    const card: WorkingCard = {
      ...singleFaceCard(),
      identity: {
        id: "identity-with-private-metadata",
        provider: "scryfall",
        name: "Unsafe metadata",
        resolutionMethod: "name",
        confidence: 1,
        metadata: { layout: "normal", faces: [{ name: "Front", localOriginalPath: "/private/front.png" }] },
      },
    };

    expect(() => serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("rejects absolute paths in persisted filename fields", () => {
    const legitimateFilenameCard: WorkingCard = {
      ...singleFaceCard(),
      importSource: { ...singleFaceCard().importSource, filename: "commander-deck.txt" },
    };
    const sourcePathCard: WorkingCard = {
      ...singleFaceCard(),
      importSource: { ...singleFaceCard().importSource, filename: "/home/private/deck.txt" },
    };
    const cardbackPathCard: WorkingCard = {
      ...singleFaceCard(),
      sharedMpcCardback: {
        importedAssetId: "shared-back-import",
        originalFormat: "png",
        availableLocally: true,
        provenance: { sourceId: "source", sourceFilename: "C:\\Users\\private\\order.xml" },
      },
    };
    const legitimate = deserializeProjectSnapshot(serializeProjectSnapshot([legitimateFilenameCard], DEFAULT_PROJECT_SETTINGS));

    expect(legitimate.cards[0].importSource.filename).toBe("commander-deck.txt");
    expect(() => serializeProjectSnapshot([sourcePathCard], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
    expect(() => serializeProjectSnapshot([cardbackPathCard], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("round-trips a confirmed custom identity resolution without a CardIdentity", () => {
    const card: WorkingCard = {
      ...singleFaceCard(),
      identity: null,
      identityResolution: { status: "custom", method: "custom", candidates: [], confirmed: true },
    };

    const snapshot = deserializeProjectSnapshot(serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS));

    expect(snapshot.cards[0].identity).toBeNull();
    expect(snapshot.cards[0].identityResolution).toEqual({
      status: "custom",
      method: "custom",
      candidates: [],
      confirmed: true,
    });
  });

  it("round-trips an unconfirmed custom identity resolution from import", () => {
    const card: WorkingCard = {
      ...singleFaceCard(),
      identity: null,
      identityResolution: { status: "custom", candidates: [], confirmed: false },
    };

    const snapshot = deserializeProjectSnapshot(serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS));

    expect(snapshot.cards[0].identity).toBeNull();
    expect(snapshot.cards[0].identityResolution).toEqual({ status: "custom", candidates: [], confirmed: false });
  });

  it.each(["unresolved", "suggested", "ambiguous", "resolved"] as const)(
    "rejects confirmed %s resolution without a current identity",
    (status) => {
      const card: WorkingCard = {
        ...singleFaceCard(),
        identity: null,
        identityResolution: { status, candidates: [], confirmed: true },
      };

      expect(() => serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS))
        .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
    },
  );

  it.each([
    ["malformed upload ID", "upload:abc"],
    ["uppercase upload hash", `upload:${"A".repeat(64)}`],
    ["Scryfall candidate ID", `scryfall:${"a".repeat(36)}:front`],
    ["MPC candidate ID", `mpc:${"a".repeat(64)}`],
  ])("rejects %s in localArtworkIds", (_description, localArtworkId) => {
    const card: WorkingCard = { ...singleFaceCard(), localArtworkIds: [localArtworkId] };

    expect(() => serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("rejects MPC references to faces the WorkingCard does not have", () => {
    const card: WorkingCard = {
      ...singleFaceCard(),
      mpcReferences: [{ faceId: "back", importedAssetId: "back-asset", slots: [], availableLocally: false }],
    };

    expect(() => serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("preserves a source-side MPC back reference for a manual physical back without creating a logical back face", () => {
    const importedAssetId = "physical-source-back";
    const candidateId = mpcArtworkCandidateId(importedAssetId, "back");
    const card: WorkingCard = {
      ...singleFaceCard(),
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
      manualBackArtwork: { candidateId, source: "mpc", identityId: null, faceId: "back", providerAssetId: importedAssetId, selectedArtworkId: importedAssetId, selectionPolicy: "user-selected" },
      mpcReferences: [{ faceId: "back", importedAssetId, providerAssetId: importedAssetId, selectedArtworkId: importedAssetId, slots: [], availableLocally: true }],
    };

    expect(deserializeProjectSnapshot(serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS)).cards[0]).toMatchObject({
      faces: [{ side: "front" }],
      manualBackArtwork: { candidateId, faceId: "back", source: "mpc" },
      mpcReferences: [{ faceId: "back", importedAssetId }],
    });
  });

  it("rejects artwork candidate IDs that the current API boundary cannot accept", () => {
    const card: WorkingCard = {
      ...singleFaceCard(),
      selectedArtworkByFace: {
        front: { candidateId: "mpc:invalid", source: "mpc", identityId: null, faceId: "front" },
      },
    };

    expect(() => serializeProjectSnapshot([card], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("rejects a valid-shape snapshot that exceeds the centralized payload limit", () => {
    const largeCard: WorkingCard = {
      ...singleFaceCard(),
      identity: {
        id: "identity-large-metadata",
        provider: "scryfall",
        name: "Long Metadata",
        resolutionMethod: "name",
        confidence: 1,
        metadata: { layout: "x".repeat(MAX_PROJECT_SNAPSHOT_BYTES + 1) },
      },
    };

    expect(() => serializeProjectSnapshot([largeCard], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "PROJECT_SNAPSHOT_TOO_LARGE" }));
  });

  it("rejects bleed beyond the current 3 mm export maximum", () => {
    expect(() => serializeProjectSnapshot([singleFaceCard()], {
      ...DEFAULT_PROJECT_SETTINGS,
      bleedMm: 3.001,
    })).toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("enforces the existing physical-card export limit without truncating quantity", () => {
    const atLimit = { ...singleFaceCard(), quantity: MAX_PHYSICAL_CARDS_PER_EXPORT };
    const overLimit = { ...singleFaceCard(), quantity: MAX_PHYSICAL_CARDS_PER_EXPORT + 1 };

    const snapshot = deserializeProjectSnapshot(serializeProjectSnapshot([atLimit], DEFAULT_PROJECT_SETTINGS));

    expect(snapshot.cards[0].quantity).toBe(MAX_PHYSICAL_CARDS_PER_EXPORT);
    expect(() => serializeProjectSnapshot([overLimit], DEFAULT_PROJECT_SETTINGS))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROJECT_SNAPSHOT" }));
  });

  it("preserves valid imported WorkingCard order values without rebasing them", () => {
    const cards = [
      { ...singleFaceCard(), id: "working-card-a", order: 1 },
      { ...singleFaceCard(), id: "working-card-b", order: 2 },
    ];

    const snapshot = deserializeProjectSnapshot(serializeProjectSnapshot(cards, DEFAULT_PROJECT_SETTINGS));

    expect(snapshot.cards.map(({ order }) => order)).toEqual([1, 2]);
  });

  it("preserves stable array order when imported WorkingCards have tied order values", () => {
    const cards = [
      { ...singleFaceCard(), id: "working-card-first", order: 0 },
      { ...singleFaceCard(), id: "working-card-second", order: 0 },
    ];

    const snapshot = deserializeProjectSnapshot(serializeProjectSnapshot(cards, DEFAULT_PROJECT_SETTINGS));

    expect(snapshot.cards.map(({ id, order }) => [id, order])).toEqual([
      ["working-card-first", 0],
      ["working-card-second", 0],
    ]);
  });

  it("preserves DFC and MDFC faces, identities, artwork choices, MPC references, and settings", () => {
    const dfcIdentity = {
      id: "scryfall:oracle:delver",
      provider: "scryfall",
      name: "Delver of Secrets // Insectile Aberration",
      scryfallId: "11111111-1111-4111-8111-111111111111",
      oracleId: "delver-oracle",
      setCode: "isd",
      collectorNumber: "51",
      lang: "en",
      resolutionMethod: "manual" as const,
      confidence: 1,
      metadata: {
        layout: "transform",
        digital: false,
        promo: false,
        fullArt: false,
        imageStatus: "highres_scan",
        faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }],
        relatedCards: [{ id: "token-1", name: "Human", component: "token", typeLine: "Token Creature" }],
      },
    };
    const candidateIdentity = { ...dfcIdentity, id: "scryfall:oracle:delver-candidate", name: "Delver suggestion" };
    const dfc: WorkingCard = {
      ...singleFaceCard(),
      id: "working-card-dfc",
      quantity: 2,
      order: 1,
      identity: dfcIdentity,
      identityResolution: {
        status: "resolved",
        method: "manual",
        query: "Delver of Secrets",
        confidence: 1,
        candidates: [{ identity: candidateIdentity, score: 0.98, reason: "confirmed candidate" }],
        confirmed: true,
      },
      faces: [
        { id: "front", side: "front", name: "Delver of Secrets", importedAssetId: "asset-delver-front", slots: ["1"] },
        { id: "back", side: "back", name: "Insectile Aberration", importedAssetId: "asset-delver-back", slots: ["1"] },
      ],
      selectedArtworkByFace: {
        front: {
          candidateId: "scryfall:11111111-1111-4111-8111-111111111111:front",
          source: "scryfall",
          identityId: dfcIdentity.id,
          faceId: "front",
          providerAssetId: "printing-front",
          selectedArtworkId: "art-front",
          selectionPolicy: "user-selected",
        },
        back: {
          candidateId: `mpc:${"b".repeat(64)}`,
          source: "mpc",
          identityId: dfcIdentity.id,
          faceId: "back",
          providerAssetId: "mpc-back-provider",
          selectedArtworkId: "mpc-back-artwork",
          selectionPolicy: "newest-en-highres-nondigital-v1",
        },
      },
      localArtworkIds: [`upload:${"a".repeat(64)}`],
      mpcReferences: [
        { faceId: "front", importedAssetId: "mpc-front-import", providerAssetId: "mpc-front-provider", selectedArtworkId: "mpc-front-artwork", referenceOrigin: "order-import", slots: ["1"], availableLocally: false },
        { faceId: "back", importedAssetId: "mpc-back-import", providerAssetId: "mpc-back-provider", selectedArtworkId: "mpc-back-artwork", referenceOrigin: "gallery-selection", slots: ["1", "2"], availableLocally: true },
      ],
      sharedMpcCardback: {
        importedAssetId: "shared-back-import",
        providerAssetId: "shared-back-provider",
        selectedArtworkId: "shared-back-artwork",
        originalFormat: "png",
        availableLocally: true,
        provenance: { sourceId: "order-source", sourceFilename: "order.xml" },
      },
      faceAssociations: [{ slot: "1", frontAssetId: "asset-delver-front", backAssetId: "asset-delver-back", confidence: 0.9, reason: "matched pair", accepted: true }],
    };
    const mdfc: WorkingCard = {
      ...singleFaceCard(),
      id: "working-card-mdfc",
      order: 2,
      identity: {
        id: "scryfall:oracle:modal",
        provider: "scryfall",
        name: "Emeria's Call // Emeria, Shattered Skyclave",
        resolutionMethod: "name",
        confidence: 0.8,
        metadata: { layout: "modal_dfc", faces: [{ name: "Emeria's Call" }, { name: "Emeria, Shattered Skyclave" }] },
      },
      identityResolution: {
        status: "suggested",
        method: "name",
        query: "Emeria's Call",
        candidates: [{ identity: {
          id: "scryfall:oracle:modal-candidate",
          provider: "scryfall",
          name: "Emeria's Call // Emeria, Shattered Skyclave",
          resolutionMethod: "name",
          confidence: 0.8,
        }, score: 0.8, reason: "name match" }],
        confirmed: false,
      },
      faces: [
        { id: "front", side: "front", name: "Emeria's Call" },
        { id: "back", side: "back", name: "Emeria, Shattered Skyclave" },
      ],
    };
    const settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      bleedMm: 3,
      roundedCorners: true,
      cutGuides: {
        trim: { enabled: true, extentMm: "full" as const, color: "green" as const },
        external: { enabled: true, strokeWidthPt: 0.7, color: "white" as const },
      },
    };

    const snapshot = deserializeProjectSnapshot(serializeProjectSnapshot([singleFaceCard(), dfc, mdfc], settings));

    expect(snapshot.cards.map(({ id, quantity, order }) => ({ id, quantity, order }))).toEqual([
      { id: "working-card-1", quantity: 1, order: 0 },
      { id: "working-card-dfc", quantity: 2, order: 1 },
      { id: "working-card-mdfc", quantity: 1, order: 2 },
    ]);
    expect(snapshot.cards[1]).toMatchObject({
      identity: dfcIdentity,
      identityResolution: dfc.identityResolution,
      faces: dfc.faces,
      selectedArtworkByFace: dfc.selectedArtworkByFace,
      localArtworkIds: dfc.localArtworkIds,
      mpcReferences: dfc.mpcReferences,
      sharedMpcCardback: dfc.sharedMpcCardback,
      faceAssociations: dfc.faceAssociations,
    });
    expect(snapshot.cards[2]).toMatchObject({
      identity: mdfc.identity,
      identityResolution: mdfc.identityResolution,
      faces: mdfc.faces,
    });
    expect(snapshot.settings).toEqual(settings);
  });
});
