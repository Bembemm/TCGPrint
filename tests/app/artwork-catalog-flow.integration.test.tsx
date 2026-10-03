import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtworkCandidateView } from "../../src/app/artwork-candidate-grid";
import { ArtworkCandidateGrid } from "../../src/app/artwork-candidate-grid";
import { handleArtworkList } from "../../services/card-api";
import { createCardWorkbench, type CardWorkbench } from "../../services/card-workbench";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const workbenches: CardWorkbench[] = [];

afterEach(async () => {
  await Promise.all(workbenches.splice(0).map((workbench) => workbench.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artwork catalog count through MPC service, API, and UI", () => {
  it("keeps the 1200-item logical total when MPC filters to 247 and renders only the first 60", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgprint-artwork-count-"));
    roots.push(root);
    const ids = Array.from({ length: 1200 }, (_, index) => `count_asset_${String(index).padStart(4, "0")}`);
    const matches = ids.slice(0, 247);
    let searchRequests = 0;
    const searchMinimumDpis: number[] = [];
    const searchMaximumDpis: number[] = [];
    let hydrationRequests = 0;
    const hydrationBatchSizes: number[] = [];
    let originalsOrPreviews = 0;
    let activeHydrations = 0;
    let peakHydrations = 0;
    const mpcFetchImpl: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/sources/") {
        return Response.json({ results: { "41": { pk: 41, sourceType: "Google Drive", name: "Synthetic source" } } });
      }
      if (url.pathname === "/3/editorSearch/") {
        searchRequests += 1;
        const body = JSON.parse(String(init.body)) as {
          queries: Record<string, unknown>;
          searchSettings: { filterSettings: { minimumDPI: number; maximumDPI: number } };
        };
        searchMinimumDpis.push(body.searchSettings.filterSettings.minimumDPI);
        searchMaximumDpis.push(body.searchSettings.filterSettings.maximumDPI);
        const resultIds = body.searchSettings.filterSettings.minimumDPI >= 500 ? matches : ids;
        return Response.json({ results: { [Object.keys(body.queries)[0]!]: resultIds } });
      }
      if (url.pathname === "/2/cards/") {
        hydrationRequests += 1;
        activeHydrations += 1;
        peakHydrations = Math.max(peakHydrations, activeHydrations);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const body = JSON.parse(String(init.body)) as { cardIdentifiers: string[] };
        hydrationBatchSizes.push(body.cardIdentifiers.length);
        const results = Object.fromEntries(body.cardIdentifiers.map((identifier) => [identifier, {
          identifier,
          cardType: "CARD",
          name: identifier,
          sourceId: 41,
          sourceType: "Google Drive",
          extension: "png",
          size: 8000,
          dpi: matches.includes(identifier) ? 800 : 300,
          language: "en",
        }]));
        activeHydrations -= 1;
        return Response.json({ results });
      }
      originalsOrPreviews += 1;
      throw new Error(`Unexpected MPC original/preview request: ${url.pathname}`);
    };
    const workbench = await createCardWorkbench({ dataDirectory: root, mpcFetchImpl, minIntervalMs: 0 });
    workbenches.push(workbench);
    const request = () => new Request("http://localhost/api/cards/test-identity/artworks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faceId: "front", source: "mpc", mpcFilters: { minimumDpi: 500 } }),
    });

    const response = await handleArtworkList(request(), "scryfall:oracle:test", workbench);
    const body = await response.json() as { candidates: ArtworkCandidateView[]; catalogTotal: number };
    expect(response.status).toBe(200);
    expect(body.catalogTotal).toBe(1200);
    expect(body.candidates).toHaveLength(247);
    expect(hydrationRequests).toBe(13);
    expect(hydrationBatchSizes.every((size) => size <= 20)).toBe(true);
    expect(peakHydrations).toBeLessThanOrEqual(3);
    expect(searchMinimumDpis).toEqual([500, 0]);
    expect(searchMaximumDpis).toEqual([1500, 10_000]);
    expect(originalsOrPreviews).toBe(0);

    const markup = renderToStaticMarkup(createElement(ArtworkCandidateGrid, {
      candidates: body.candidates,
      windowLimit: 60,
      catalogTotal: body.catalogTotal,
      filterTotal: body.candidates.length,
      catalogLabel: "MPC Autofill",
      cardName: "Sol Ring",
      onSelect: () => undefined,
      onLoadMore: () => undefined,
    }));
    expect(markup).toContain("60 de 1200 exibidas");
    expect(markup).toContain("247 de 1200 correspondem ao filtro");
    expect([...markup.matchAll(/class="artwork-candidate/g)]).toHaveLength(60);

    const cachedResponse = await handleArtworkList(request(), "scryfall:oracle:test", workbench);
    const cached = await cachedResponse.json() as { candidates: ArtworkCandidateView[]; catalogTotal: number };
    expect(cached.catalogTotal).toBe(1200);
    expect(cached.candidates).toHaveLength(247);
    expect(searchRequests).toBe(2);
    expect(hydrationRequests).toBe(13);
    expect(originalsOrPreviews).toBe(0);
  }, 30_000);
});
