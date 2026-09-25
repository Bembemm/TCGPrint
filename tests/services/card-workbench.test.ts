import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCardWorkbench } from "../../services/card-workbench";

const roots: string[] = [];
const workbenches: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const workbench of workbenches.splice(0)) workbench.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const solRing = JSON.parse(await readFile(new URL("../fixtures/scryfall/normal-card.json", import.meta.url), "utf8")) as Record<string, unknown>;
const basicLand = {
  ...solRing,
  id: "12121212-1212-4121-8121-121212121212",
  oracle_id: "23232323-2323-4232-8232-232323232323",
  name: "Island",
  set: "m21",
  collector_number: "265",
  image_uris: { small: "https://cards.scryfall.io/small/island.jpg", png: "https://cards.scryfall.io/png/island.png" },
  all_parts: undefined,
};
const delverCard = JSON.parse(await readFile(new URL("../fixtures/scryfall/dmf-card.json", import.meta.url), "utf8")) as Record<string, unknown>;

async function setup(fetchImpl?: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "tcgprint-workbench-"));
  roots.push(root);
  const workbench = await createCardWorkbench({ dataDirectory: root, fetchImpl, minIntervalMs: 0 });
  workbenches.push(workbench);
  return { root, workbench };
}

function scryfallFetch() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.href);
    expect(new Headers(init?.headers).get("User-Agent")).toMatch(/^TCGPrint\//);
    if (url.pathname === "/cards/named") {
      const name = url.searchParams.get("exact") ?? url.searchParams.get("fuzzy");
      const card = name === "Island" ? basicLand : solRing;
      return Response.json(card);
    }
    if (url.pathname === "/cards/search") {
      const query = url.searchParams.get("q") ?? "";
      const card = query.includes("23232323") || query.includes("Island") ? basicLand : solRing;
      if (query.startsWith("name:")) return Response.json({ data: [card], has_more: false });
      return Response.json({ data: [card], has_more: false });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as typeof fetch, calls, fetchMock: fetchImpl };
}

function collectKeys(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, output));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      output.push(key);
      collectKeys(item, output);
    }
  }
  return output;
}

describe("card workbench services", () => {
  it("keeps deck quantities, sections and order in one session WorkingCard per entry", async () => {
    const { workbench } = await setup();
    const result = await workbench.importForWorkingSet({ text: "Mainboard\n1 Sol Ring\n6 Island\nSideboard\n2 Counterspell" });

    expect(result.workingCards.map(({ quantity, order, section, identityHints }) => ({ quantity, order, section, name: identityHints.name }))).toEqual([
      { quantity: 1, order: 0, section: "Mainboard", name: "Sol Ring" },
      { quantity: 6, order: 1, section: "Mainboard", name: "Island" },
      { quantity: 2, order: 2, section: "Sideboard", name: "Counterspell" },
    ]);
    expect(result.workingCards).toHaveLength(3);
  });

  it("registers upload bytes once by SHA-256 and returns path-free WorkingCard DTOs", async () => {
    const { root, workbench } = await setup();
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [
      { filename: "Sol Ring-front.png", bytes },
      { filename: "Sol Ring-copy.png", bytes: new Uint8Array(bytes) },
    ] });
    const localIds = imported.workingCards.flatMap((card) => card.localArtworkIds);

    expect(localIds).toHaveLength(2);
    expect(new Set(localIds).size).toBe(1);
    expect(imported.workingCards[0].selectedArtworkByFace.front).toMatchObject({ source: "upload", candidateId: localIds[0] });
    expect(collectKeys(imported)).not.toContain("originalBytes");
    expect(collectKeys(imported)).not.toContain("sourcePath");
    expect(collectKeys(imported)).not.toContain("localOriginalPath");
    expect(collectKeys(imported)).not.toContain("originalUri");
    const paths = await readFile(join(root, ".tcgprint", "artwork-cache.sqlite"));
    expect(paths.byteLength).toBeGreaterThan(0);
    expect(await workbench.getArtworkPreview(localIds[0])).toMatchObject({ candidateId: localIds[0], source: "upload" });
  });

  it("resolves a name through cached metadata and assigns a deterministic default without expanding quantity", async () => {
    const fake = scryfallFetch();
    const { workbench } = await setup(fake.fetchImpl);
    const imported = await workbench.importForWorkingSet({ text: "6 Sol Ring" });
    const first = await workbench.resolveWorkingCards(imported.workingCards);
    const callCount = fake.fetchMock.mock.calls.length;
    const repeated = await workbench.resolveWorkingCards(first.workingCards);

    expect(first.workingCards).toHaveLength(1);
    expect(first.workingCards[0]).toMatchObject({ quantity: 6, identity: { name: "Sol Ring", oracleId: solRing.oracle_id }, selectedArtworkByFace: { front: { source: "scryfall", candidateId: `scryfall:${solRing.id}:front` } } });
    expect(repeated.workingCards[0].id).toBe(first.workingCards[0].id);
    expect(fake.fetchMock).toHaveBeenCalledTimes(callCount);
  });

  it("keeps upload usage working with Scryfall degraded and does not call Scryfall for MPC references", async () => {
    const failingFetch = vi.fn(async () => new Response("offline", { status: 503 })) as typeof fetch;
    const { workbench } = await setup(failingFetch);
    const bytes = new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: "#357" } }).png().toBuffer());
    const upload = await workbench.importForWorkingSet({ files: [{ filename: "custom.png", bytes }] });
    expect(await workbench.getArtworkPreview(upload.workingCards[0].localArtworkIds[0])).toMatchObject({ source: "upload" });
    await expect(workbench.resolveWorkingCards(upload.workingCards)).resolves.toMatchObject({ providerHealth: { scryfall: { degraded: true } } });

    const xml = new TextEncoder().encode("<order><details><quantity>1</quantity></details><fronts><card><id>art-front-9</id><slots>1</slots><name>Custom</name></card></fronts></order>");
    const mpc = await workbench.importForWorkingSet({ files: [{ filename: "order.xml", bytes: xml }] });
    expect(mpc.workingCards[0].selectedArtworkByFace.front).toMatchObject({ source: "mpc", selectedArtworkId: "art-front-9" });
    expect(mpc.workingCards[0].mpcReferences[0].selectedArtworkId).toBe("art-front-9");
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });

  it("honors caller cancellation before starting resolution", async () => {
    const { workbench } = await setup();
    const imported = await workbench.importForWorkingSet({ text: "1 Sol Ring" });
    const controller = new AbortController();
    controller.abort();
    await expect(workbench.resolveWorkingCards(imported.workingCards, { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("maps a resolved DFC to two faces while preserving a local front and selecting Scryfall for the back", async () => {
    const fakeFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/cards/named") return Response.json(delverCard);
      if (url.pathname === "/cards/search") return Response.json({ data: [delverCard], has_more: false });
      return new Response("offline", { status: 503 });
    });
    const { workbench } = await setup(fakeFetch as typeof fetch);
    const bytes = new Uint8Array(await sharp({ create: { width: 40, height: 56, channels: 3, background: "#695" } }).png().toBuffer());
    const imported = await workbench.importForWorkingSet({ files: [{ filename: "delver-front.png", bytes }], text: "1 Delver of Secrets // Insectile Aberration" });
    const uploadedCard = imported.workingCards.find((item) => item.localArtworkIds.length > 0)!;
    const deckEntry = imported.workingCards.find((item) => item.identityHints.name?.includes("//"))!;
    const localId = uploadedCard.localArtworkIds[0];
    const working = {
      ...deckEntry,
      faces: [{ id: "front", side: "front" as const, name: "Delver of Secrets", importedAssetId: localId }, { id: "back", side: "back" as const, name: "Insectile Aberration" }],
      selectedArtworkByFace: { front: { candidateId: localId, source: "upload" as const, identityId: null, faceId: "front" as const } },
      localArtworkIds: [localId],
    };
    const resolved = await workbench.resolveWorkingCards([working]);
    const result = resolved.workingCards[0];

    expect(result.id).toBe(working.id);
    expect(result.faces).toEqual([{ id: "front", side: "front", name: "Delver of Secrets", importedAssetId: localId }, { id: "back", side: "back", name: "Insectile Aberration" }]);
    expect(result.identity?.id).toBe(`scryfall:oracle:${delverCard.oracle_id}`);
    expect(result.selectedArtworkByFace.front).toMatchObject({ candidateId: localId, source: "upload", identityId: result.identity?.id });
    expect(result.selectedArtworkByFace.back).toMatchObject({ source: "scryfall", faceId: "back", candidateId: `scryfall:${delverCard.id}:back` });
    expect(await workbench.getArtworkOriginal(localId)).toMatchObject({ bytes });
  });
});
