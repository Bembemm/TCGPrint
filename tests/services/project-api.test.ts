import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkingCard } from "../../core/cards/types";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import {
  DEFAULT_PROJECT_SETTINGS,
  MAX_PROJECT_SNAPSHOT_BYTES,
  deserializeProjectSnapshot,
  serializeProjectSnapshot,
} from "../../persistence/projects/serializer";
import {
  handleProjectCreate,
  handleProjectDelete,
  handleProjectDuplicate,
  handleProjectList,
  handleProjectOpen,
  handleProjectSave,
  handleProjectStageRecovery,
  handleProjectPromoteRecovery,
  handleProjectDiscardRecovery,
  handleProjectCopyRecovery,
} from "../../services/project-api";
import { openArtworkDatabase } from "../../persistence/sqlite";

describe("project API service", () => {
  let projectDatabase: ReturnType<typeof openProjectDatabase> | undefined;
  let artworkDatabase: ReturnType<typeof openArtworkDatabase> | undefined;
  let repository: ProjectRepository | undefined;

  afterEach(() => {
    projectDatabase?.close();
    projectDatabase = undefined;
    artworkDatabase?.close();
    artworkDatabase = undefined;
    repository = undefined;
  });

  function setup() {
    projectDatabase = openProjectDatabase(":memory:");
    let nextId = 0;
    let nextSecond = 0;
    repository = new ProjectRepository(projectDatabase, {
      idFactory: () => `project-${++nextId}`,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, nextSecond++)).toISOString(),
    });
    return repository;
  }

  function request(method: string, body?: unknown) {
    return new Request("http://localhost/api/projects", {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  function snapshot() {
    const identity = {
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
        faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }],
      },
    };
    const cards: WorkingCard[] = [
      {
        id: "working-card-dfc",
        quantity: 2,
        order: 8,
        section: "Main",
        importSource: { sourceId: "source-dfc", importKind: "text", entryKind: "card" },
        identityHints: { name: "Delver of Secrets", setCode: "isd", collectorNumber: "51" },
        identity,
        identityResolution: {
          status: "resolved",
          method: "manual",
          query: "Delver of Secrets",
          confidence: 1,
          candidates: [],
          confirmed: true,
        },
        faces: [
          { id: "front", side: "front", name: "Delver of Secrets", importedAssetId: "asset-front", slots: ["1"] },
          { id: "back", side: "back", name: "Insectile Aberration", importedAssetId: "asset-back", slots: ["1"] },
        ],
        selectedArtworkByFace: {
          front: {
            candidateId: "scryfall:11111111-1111-4111-8111-111111111111:front",
            source: "scryfall",
            identityId: identity.id,
            faceId: "front",
            providerAssetId: "printing-front",
            selectedArtworkId: "art-front",
            selectionPolicy: "user-selected",
          },
          back: {
            candidateId: `mpc:${"b".repeat(64)}`,
            source: "mpc",
            identityId: identity.id,
            faceId: "back",
            providerAssetId: "mpc-back-provider",
            selectedArtworkId: "mpc-back-artwork",
            selectionPolicy: "newest-en-highres-nondigital-v1",
          },
        },
        localArtworkIds: [`upload:${"a".repeat(64)}`],
        mpcReferences: [{
          faceId: "back",
          importedAssetId: "mpc-back-import",
          providerAssetId: "mpc-back-provider",
          selectedArtworkId: "mpc-back-artwork",
          referenceOrigin: "gallery-selection",
          slots: ["1", "2"],
          availableLocally: true,
        }],
        faceAssociations: [{ slot: "1", frontAssetId: "asset-front", backAssetId: "asset-back", confidence: 0.9, reason: "paired", accepted: true }],
        metadata: { temporaryImportData: "must not persist" },
      },
      {
        id: "working-card-mdfc",
        quantity: 1,
        order: 2,
        importSource: { sourceId: "source-mdfc", importKind: "text", entryKind: "card" },
        identityHints: { name: "Emeria's Call" },
        identity: {
          id: "scryfall:oracle:modal",
          provider: "scryfall",
          name: "Emeria's Call // Emeria, Shattered Skyclave",
          resolutionMethod: "name",
          confidence: 0.8,
          metadata: { layout: "modal_dfc", faces: [{ name: "Emeria's Call" }, { name: "Emeria, Shattered Skyclave" }] },
        },
        identityResolution: { status: "suggested", method: "name", query: "Emeria's Call", candidates: [], confirmed: false },
        faces: [
          { id: "front", side: "front", name: "Emeria's Call" },
          { id: "back", side: "back", name: "Emeria, Shattered Skyclave" },
        ],
        selectedArtworkByFace: {},
        localArtworkIds: [],
        mpcReferences: [],
        faceAssociations: [],
      },
    ];
    return deserializeProjectSnapshot(serializeProjectSnapshot(cards, {
      ...DEFAULT_PROJECT_SETTINGS,
      bleedMm: 2.25,
      roundedCorners: true,
      cutGuides: {
        trim: { enabled: true, extentMm: 2.5, color: "green" },
        external: { enabled: true, strokeWidthPt: 0.7, color: "white" },
      },
    }));
  }

  it("lists no projects before creation", async () => {
    const projects = setup();

    const response = await handleProjectList(request("GET"), projects);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
  });

  it("creates an empty revision-one project and returns safe metadata in the list", async () => {
    const projects = setup();

    const createdResponse = await handleProjectCreate(request("POST"), projects);
    const created = await createdResponse.json();
    const listResponse = await handleProjectList(request("GET"), projects);

    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({
      id: "project-1",
      name: "Novo projeto",
      projectSchemaVersion: 3,
      revision: 1,
      snapshot: {
        projectSchemaVersion: 3,
        cards: [],
        settings: DEFAULT_PROJECT_SETTINGS,
      },
    });
    expect(created).not.toHaveProperty("autosavedAt");
    expect(created).not.toHaveProperty("snapshot_json");
    expect(created).not.toHaveProperty("databasePath");
    expect(await listResponse.json()).toEqual({ projects: [{
      id: "project-1",
      name: "Novo projeto",
      projectSchemaVersion: 3,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }] });
  });

  it("creates a new revision-one Project from a validated local conflict snapshot", async () => {
    const projects = setup();
    const localSnapshot = snapshot();

    const response = await handleProjectCreate(request("POST", { snapshot: localSnapshot }), projects);
    const created = await response.json();

    expect(response.status).toBe(201);
    expect(created).toMatchObject({ id: "project-1", revision: 1, snapshot: localSnapshot });
  });

  it("treats a streamed empty POST body as an empty Project create", async () => {
    const projects = setup();
    const emptyBodyRequest = new Request("http://localhost/api/projects", { method: "POST", body: "" });

    const response = await handleProjectCreate(emptyBodyRequest, projects);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "project-1", revision: 1, snapshot: { cards: [] } });
  });

  it("rejects extra fields when creating a Project from a snapshot", async () => {
    const projects = setup();
    const response = await handleProjectCreate(request("POST", { snapshot: snapshot(), name: "Injected name" }), projects);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PROJECT_REQUEST" });
    expect(projects.list()).toEqual([]);
  });

  it("saves a validated snapshot, advances revision, and opens the exact persisted content", async () => {
    const projects = setup();
    await handleProjectCreate(request("POST"), projects);
    const nextSnapshot = snapshot();

    const saveResponse = await handleProjectSave(request("PUT", { expectedRevision: 1, snapshot: nextSnapshot }), "project-1", projects);
    const openedResponse = await handleProjectOpen(request("GET"), "project-1", projects);
    const saved = await saveResponse.json();
    const opened = await openedResponse.json();

    expect(saveResponse.status).toBe(200);
    expect(saved.revision).toBe(2);
    expect(opened.snapshot).toEqual(nextSnapshot);
    expect(opened.snapshot.cards.map((card: WorkingCard) => [card.id, card.quantity, card.order])).toEqual([
      ["working-card-dfc", 2, 8],
      ["working-card-mdfc", 1, 2],
    ]);
    expect(opened.snapshot.cards[0]).not.toHaveProperty("metadata");
    expect(opened).not.toHaveProperty("selectedCardId");
    expect(opened).not.toHaveProperty("face");
    expect(opened).not.toHaveProperty("past");
    expect(opened).not.toHaveProperty("future");
    expect(opened).not.toHaveProperty("snapshot_json");
    expect(opened).not.toHaveProperty("databasePath");
  });

  it("returns a staged recovery alongside the unchanged canonical snapshot when opening", async () => {
    const projects = setup();
    const canonical = projects.create();
    const candidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };
    projects.stageRecovery(canonical.id, canonical.revision, candidate);

    const response = await handleProjectOpen(request("GET"), canonical.id, projects);
    const opened = await response.json();

    expect(response.status).toBe(200);
    expect(opened.snapshot).toEqual(canonical.snapshot);
    expect(opened.recovery).toMatchObject({
      baseRevision: 1,
      projectSchemaVersion: 3,
      snapshot: candidate,
    });
  });

  it("stages, promotes, and discards recovery through explicit API operations", async () => {
    const projects = setup();
    const canonical = projects.create();
    const candidate = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };

    const staged = await handleProjectStageRecovery(request("POST", { expectedRevision: 1, snapshot: candidate }), canonical.id, projects);
    const firstStage = await staged.json();
    expect(staged.status).toBe(200);
    expect(firstStage).toMatchObject({ recovery: { baseRevision: 1, snapshot: candidate } });
    const competingCandidate = { ...candidate, settings: { ...candidate.settings, bleedMm: 3 } };
    const competingStage = await handleProjectStageRecovery(request("POST", { expectedRevision: 1, snapshot: competingCandidate }), canonical.id, projects);
    expect(competingStage.status).toBe(409);
    expect(await competingStage.json()).toMatchObject({ code: "PROJECT_RECOVERY_EXISTS" });
    const repeatedStage = await handleProjectStageRecovery(request("POST", { expectedRevision: 1, snapshot: candidate }), canonical.id, projects);
    expect(repeatedStage.status).toBe(200);
    expect(await repeatedStage.json()).toEqual(firstStage);
    expect(projects.open(canonical.id)).toEqual(canonical);

    const promoted = await handleProjectPromoteRecovery(request("POST"), canonical.id, projects);
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ revision: 2, snapshot: candidate });
    expect(projects.readRecovery(canonical.id)).toBeUndefined();

    const nextCandidate = { ...candidate, settings: { ...candidate.settings, bleedMm: 2.5 } };
    await handleProjectStageRecovery(request("POST", { expectedRevision: 2, snapshot: nextCandidate }), canonical.id, projects);
    const discarded = await handleProjectDiscardRecovery(request("DELETE"), canonical.id, projects);

    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toEqual({ discarded: true, id: canonical.id });
    expect(projects.open(canonical.id).snapshot).toEqual(candidate);
    expect(projects.readRecovery(canonical.id)).toBeUndefined();
  });

  it("copies an obsolete recovery into a new project without overwriting the concurrent canonical save", async () => {
    const projects = setup();
    const canonical = projects.create();
    const recoverySnapshot = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 2 } };
    projects.stageRecovery(canonical.id, 1, recoverySnapshot);
    const concurrentSnapshot = { ...canonical.snapshot, settings: { ...canonical.snapshot.settings, bleedMm: 1 } };
    const concurrentSave = projects.save(canonical.id, 1, concurrentSnapshot);

    const copied = await handleProjectCopyRecovery(request("POST"), canonical.id, projects);
    const recoveredProject = await copied.json();

    expect(copied.status).toBe(201);
    expect(recoveredProject).toMatchObject({
      id: "project-2",
      revision: 1,
      snapshot: recoverySnapshot,
    });
    expect(projects.open(canonical.id)).toEqual(concurrentSave);
    expect(projects.readRecovery(canonical.id)).toBeUndefined();
  });

  it("returns a typed conflict for a stale CAS save without overwriting the saved snapshot", async () => {
    const projects = setup();
    const created = await handleProjectCreate(request("POST"), projects);
    const initial = await created.json();
    const currentSnapshot = { ...initial.snapshot, settings: { ...initial.snapshot.settings, bleedMm: 1.25 } };
    const staleSnapshot = { ...initial.snapshot, settings: { ...initial.snapshot.settings, bleedMm: 2.5 } };
    await handleProjectSave(request("PUT", { expectedRevision: 1, snapshot: currentSnapshot }), "project-1", projects);

    const conflict = await handleProjectSave(request("PUT", { expectedRevision: 1, snapshot: staleSnapshot }), "project-1", projects);
    const opened = await handleProjectOpen(request("GET"), "project-1", projects);

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "PROJECT_REVISION_CONFLICT" });
    expect((await opened.json()).snapshot.settings.bleedMm).toBe(1.25);
  });

  it("duplicates with a new Project ID while retaining WorkingCard IDs and the full snapshot", async () => {
    const projects = setup();
    projects.create(snapshot());

    const duplicateResponse = await handleProjectDuplicate(request("POST"), "project-1", projects);
    const duplicate = await duplicateResponse.json();

    expect(duplicateResponse.status).toBe(201);
    expect(duplicate.id).toBe("project-2");
    expect(duplicate.revision).toBe(1);
    expect(duplicate.snapshot).toEqual(snapshot());
    expect(duplicate.snapshot.cards.map((card: WorkingCard) => card.id)).toEqual(["working-card-dfc", "working-card-mdfc"]);
    expect(projects.open("project-1").snapshot).toEqual(snapshot());
  });

  it("deletes only the project and leaves artwork cache storage untouched", async () => {
    const projects = setup();
    projects.create(snapshot());
    artworkDatabase = openArtworkDatabase(":memory:");
    artworkDatabase.exec("CREATE TABLE isolation_marker (value TEXT NOT NULL); INSERT INTO isolation_marker VALUES ('shared artwork stays');");

    const response = await handleProjectDelete(request("DELETE"), "project-1", projects);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, id: "project-1" });
    expect(projects.list()).toEqual([]);
    expect(artworkDatabase.prepare("SELECT value FROM isolation_marker").get()).toEqual({ value: "shared artwork stays" });
  });

  it("rejects malformed save requests without changing the project", async () => {
    const projects = setup();
    projects.create();

    const response = await handleProjectSave(request("PUT", { expectedRevision: 1, snapshot: { projectSchemaVersion: 4 } }), "project-1", projects);
    const opened = projects.open("project-1");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "FUTURE_PROJECT_SCHEMA_VERSION" });
    expect(opened.revision).toBe(1);
    expect(opened.snapshot.cards).toEqual([]);
  });

  it("rejects a chunked body beyond the snapshot and maximum envelope before parsing or mutating", async () => {
    const projects = setup();
    const created = projects.create(snapshot());
    const compactBody = new TextEncoder().encode(JSON.stringify({ expectedRevision: 1, snapshot: snapshot() }));
    const bytes = new Uint8Array(MAX_PROJECT_SNAPSHOT_BYTES + 1_024);
    bytes.set(compactBody);
    bytes.fill(0x20, compactBody.byteLength);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 64 * 1024, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    });
    const streamedRequest = new Request("http://localhost/api/projects/project-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const parse = vi.spyOn(JSON, "parse");

    expect(streamedRequest.headers.get("content-length")).toBeNull();
    try {
      const response = await handleProjectSave(streamedRequest, created.id, projects);

      expect(response.status).toBe(413);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }

    const unchanged = projects.open(created.id);
    expect(unchanged.revision).toBe(1);
    expect(unchanged.snapshot).toEqual(snapshot());
  });

  it("rejects oversized save bodies before parsing or mutating the project", async () => {
    const projects = setup();
    const created = projects.create(snapshot());
    const body = `${JSON.stringify({ expectedRevision: 1, snapshot: snapshot() })}${" ".repeat(MAX_PROJECT_SNAPSHOT_BYTES + 2_048)}`;
    const oversizedRequest = new Request("http://localhost/api/projects/project-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await handleProjectSave(oversizedRequest, created.id, projects);
    const unchanged = projects.open(created.id);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(unchanged.revision).toBe(1);
    expect(unchanged.snapshot).toEqual(snapshot());
  });
});
