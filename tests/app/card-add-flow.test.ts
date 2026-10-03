import { describe, expect, it, vi } from "vitest";
import * as workbenchModule from "../../src/app/card-identity-workbench";
import type { WorkingCard } from "../../core/cards/types";

const card = {
  id: "imported-island",
  quantity: 4,
  order: 0,
  section: "Mainboard",
  importSource: { sourceId: "deck", importKind: "text", entryKind: "deck-card" },
  identityHints: { name: "Island" },
  identity: null,
  identityResolution: { status: "unresolved", candidates: [], confirmed: false },
  faces: [{ id: "front", side: "front" }],
  selectedArtworkByFace: {},
  backMode: "project-default",
  backModeSelectionPolicy: "automatic",
  localArtworkIds: [],
  mpcReferences: [],
  faceAssociations: [],
} satisfies WorkingCard;

const importReport = {
  summary: {},
  sources: [],
  selectedImporters: [],
  warnings: [],
  errors: [],
  pairings: [],
};

const providerHealth = {
  scryfall: { available: true, degraded: false },
  upload: { available: true, degraded: false },
  mpc: { available: true, degraded: false },
};

function runAddCardsFlow(): typeof import("../../src/app/card-identity-workbench").runAddCardsFlow {
  const run = (workbenchModule as unknown as Record<string, unknown>).runAddCardsFlow;
  expect(run).toBeTypeOf("function");
  return run as typeof import("../../src/app/card-identity-workbench").runAddCardsFlow;
}

function tryAcquireAddCardsOperation(): typeof import("../../src/app/card-identity-workbench").tryAcquireAddCardsOperation {
  const acquire = (workbenchModule as unknown as Record<string, unknown>).tryAcquireAddCardsOperation;
  expect(acquire).toBeTypeOf("function");
  return acquire as typeof import("../../src/app/card-identity-workbench").tryAcquireAddCardsOperation;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("single add-cards flow", () => {
  it("imports, resolves, and returns the final cards and ImportReport in order", async () => {
    const run = runAddCardsFlow();
    const resolvedCard = {
      ...card,
      identity: { id: "island", provider: "scryfall", name: "Island", resolutionMethod: "name", confidence: 1 },
      identityResolution: { status: "resolved", candidates: [], confirmed: false },
    } satisfies WorkingCard;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return String(input) === "/api/cards/import"
        ? Response.json({ workingCards: [card], report: importReport, providerHealth })
        : Response.json({ workingCards: [resolvedCard], providerHealth });
    });
    const controller = new AbortController();
    const phases: string[] = [];

    const result = await run(new FormData(), controller.signal, fetcher, (phase) => phases.push(phase));

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/cards/import",
      "/api/cards/resolve",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ action: "resolve", cards: [card] });
    expect(phases).toEqual(["import", "resolve"]);
    expect(result).toMatchObject({ workingCards: [resolvedCard], report: importReport, providerHealth });
  });

  it("does not begin resolution or return imported cards when import is cancelled", async () => {
    const run = runAddCardsFlow();
    const pendingImport = deferred<Response>();
    const controller = new AbortController();
    const fetcher = vi.fn(() => pendingImport.promise);
    const operation = run(new FormData(), controller.signal, fetcher, () => undefined);
    controller.abort();
    pendingImport.resolve(Response.json({ workingCards: [card], report: importReport, providerHealth }));

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not return an intermediate Working Set when resolution is cancelled", async () => {
    const run = runAddCardsFlow();
    const pendingResolve = deferred<Response>();
    const controller = new AbortController();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/cards/import"
      ? Response.json({ workingCards: [card], report: importReport, providerHealth })
      : pendingResolve.promise);
    const operation = run(new FormData(), controller.signal, fetcher, () => undefined);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    controller.abort();
    pendingResolve.resolve(Response.json({ workingCards: [card], providerHealth }));

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses a synchronous guard so same-tick invocations start only one addition", () => {
    const acquire = tryAcquireAddCardsOperation();
    const inFlight = { current: false };
    let started = 0;
    if (acquire(inFlight)) started += 1;
    if (acquire(inFlight)) started += 1;

    expect(started).toBe(1);
    inFlight.current = false;
    expect(acquire(inFlight)).toBe(true);
  });
});
