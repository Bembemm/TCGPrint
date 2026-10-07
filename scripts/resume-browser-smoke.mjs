import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const baseURL = process.env.TCGPRINT_BASE_URL ?? "http://127.0.0.1:3101";
const artifactDir = process.env.TCGPRINT_BROWSER_ARTIFACTS ?? "artifacts/resume-browser-smoke";
await fs.mkdir(artifactDir, { recursive: true });

const providerHealth = {
  scryfall: { available: true, degraded: false },
  upload: { available: true, degraded: false },
  mpc: { available: true, degraded: false },
};

function card(id, name, order) {
  return {
    id,
    quantity: 1,
    order,
    section: "Mainboard",
    importSource: { sourceId: `deck:${id}`, importKind: "text", entryKind: "deck-card" },
    identityHints: { name },
    identity: { id, provider: "scryfall", name, resolutionMethod: "name", confidence: 1 },
    identityResolution: { status: "resolved", candidates: [], confirmed: true, method: "name", confidence: 1, query: name },
    faces: [{ id: "front", side: "front", name }],
    selectedArtworkByFace: {},
    backMode: "project-default",
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
}

function candidate(cardValue, source = "scryfall") {
  return {
    id: `${source}:${cardValue.id}-front`,
    source,
    identityId: cardValue.identity.id,
    faceId: "front",
    faceName: `${cardValue.identity.name} · ${source}`,
    previewUri: `/api/cards/artworks/${encodeURIComponent(source + ":" + cardValue.id + "-front")}/preview`,
    effectiveDpi: source === "mpc" ? 600 : 300,
    resolutionQuality: "good",
    qualityStatus: "verified",
    widthPx: source === "mpc" ? 1500 : 750,
    heightPx: source === "mpc" ? 2100 : 1050,
    originalAvailable: true,
    originalCached: true,
    metadata: {
      originalFormat: "png",
      byteLength: 120000,
      ...(source === "mpc" ? { dpi: 600, sourceName: "Smoke fixture", metadataFreshness: "fresh" } : {}),
    },
  };
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQx8AAAAASUVORK5CYII=", "base64");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function installRoutes(page) {
  let cards = [card("island-card", "Island", 0), card("mountain-card", "Mountain", 1)];
  const projects = [];
  let projectCounter = 0;

  page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/cards/import" && method === "POST") {
      return json(route, { workingCards: cards, report: { summary: {}, sources: [], selectedImporters: [], warnings: [], errors: [], pairings: [] }, providerHealth });
    }

    if (path === "/api/cards/resolve" && method === "POST") {
      const body = request.postDataJSON();
      if (Array.isArray(body.cards)) cards = body.cards;
      if (body.action === "apply-artwork-scope" && body.targetCardId && body.faceId && body.candidateId) {
        cards = cards.map((item) => item.id === body.targetCardId
          ? {
            ...item,
            selectedArtworkByFace: {
              ...item.selectedArtworkByFace,
              [body.faceId]: {
                candidateId: body.candidateId,
                source: String(body.candidateId).startsWith("mpc:") ? "mpc" : "scryfall",
                identityId: item.identity?.id ?? null,
                faceId: body.faceId,
                selectionPolicy: "user-selected",
              },
            },
          }
          : item);
      }
      return json(route, { workingCards: cards, providerHealth });
    }

    if (path === "/api/back-library" && method === "GET") return json(route, { assets: [] });
    if (path === "/api/templates" && method === "GET") return json(route, { templates: [] });
    if (path === "/api/printer-profiles" && method === "GET") return json(route, { profiles: [] });
    if (path === "/api/cards/artworks/mpc-catalogs") return json(route, { catalogs: { sources: [], dpi: [], layouts: [], languages: [], tags: [] } });

    const identityMatch = /^\/api\/cards\/([^/]+)$/.exec(path);
    if (identityMatch && method === "GET") {
      const target = cards.find((item) => item.id === decodeURIComponent(identityMatch[1]));
      return target
        ? json(route, { identity: { ...target.identity, relatedCards: [] } })
        : json(route, { message: "Not found" }, 404);
    }

    const artworkMatch = /^\/api\/cards\/([^/]+)\/artworks$/.exec(path);
    if (artworkMatch && method === "POST") {
      const target = cards.find((item) => item.id === decodeURIComponent(artworkMatch[1])) ?? cards[0];
      const body = request.postDataJSON();
      const source = body.source === "mpc" ? "mpc" : "scryfall";
      const item = candidate(target, source);
      return json(route, {
        candidates: [item],
        catalogTotal: 1,
        catalogTotalComplete: true,
        providerHealth,
        ...(source === "mpc" ? {
          mpcDiagnostic: {
            available: true,
            degraded: false,
            capabilities: { search: true, filters: { dpi: true, sources: true, languages: true, tags: true } },
            fallbackV2Used: false,
            lastProtocolConfirmed: "v3",
          },
        } : {}),
      });
    }

    const prepareMatch = /^\/api\/cards\/artworks\/(.+)\/prepare$/.exec(path);
    if (prepareMatch && method === "POST") {
      const id = decodeURIComponent(prepareMatch[1]);
      const target = cards.find((item) => id.includes(item.id)) ?? cards[0];
      return json(route, { candidate: candidate(target, id.startsWith("mpc:") ? "mpc" : "scryfall") });
    }

    if (/^\/api\/cards\/artworks\/.+\/(?:preview|display)$/.test(path)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }

    if (path === "/api/projects" && method === "GET") {
      return json(route, { projects: projects.map(({ snapshot, templateSelection, ...metadata }) => metadata) });
    }
    if (path === "/api/projects" && method === "POST") {
      const body = request.postDataJSON();
      projectCounter += 1;
      const now = "2026-10-07T15:00:00.000Z";
      const project = {
        id: `browser-smoke-${projectCounter}`,
        name: `Browser smoke ${projectCounter}`,
        projectSchemaVersion: 6,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        snapshot: body.snapshot,
        templateSelection: body.templateSelection ?? null,
      };
      projects.push(project);
      return json(route, project);
    }

    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (projectMatch && method === "GET") {
      const project = projects.find((item) => item.id === projectMatch[1]);
      return project ? json(route, { ...project, recovery: null }) : json(route, { message: "Not found" }, 404);
    }
    if (projectMatch && method === "PUT") {
      const project = projects.find((item) => item.id === projectMatch[1]);
      if (!project) return json(route, { message: "Not found" }, 404);
      const body = request.postDataJSON();
      project.revision += 1;
      project.snapshot = body.snapshot ?? project.snapshot;
      project.templateSelection = body.templateSelection ?? project.templateSelection;
      return json(route, project);
    }

    const recoveryMatch = /^\/api\/projects\/([^/]+)\/recovery$/.exec(path);
    if (recoveryMatch && method === "POST") {
      const project = projects.find((item) => item.id === recoveryMatch[1]);
      if (!project) return json(route, { message: "Not found" }, 404);
      const body = request.postDataJSON();
      project.__pendingRecovery = body;
      return json(route, { recovery: { baseRevision: project.revision } });
    }
    const promoteMatch = /^\/api\/projects\/([^/]+)\/recovery\/promote$/.exec(path);
    if (promoteMatch && method === "POST") {
      const project = projects.find((item) => item.id === promoteMatch[1]);
      if (!project || !project.__pendingRecovery) return json(route, { message: "Not found" }, 404);
      project.revision += 1;
      project.snapshot = project.__pendingRecovery.snapshot ?? project.snapshot;
      project.templateSelection = project.__pendingRecovery.templateSelection ?? project.templateSelection;
      delete project.__pendingRecovery;
      return json(route, project);
    }

    if (path === "/api/cut/preview" && method === "POST") {
      return json(route, { projectRevision: 1, source: "trim", paths: [], warnings: [] });
    }

    if (path === "/api/cards/export" && method === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/pdf",
        headers: { "content-disposition": 'attachment; filename="tcgprint-browser-smoke.pdf"' },
        body: pdf,
      });
    }

    return json(route, { message: `Browser smoke route not mocked: ${method} ${path}` }, 404);
  });
}

async function addCards(page) {
  await page.getByRole("textbox", { name: "Cole uma decklist ou URL" }).fill("1 Island\n1 Mountain");
  await page.getByRole("button", { name: "Adicionar cartas" }).click();
  await page.getByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" }).waitFor();
}

async function chooseFrontArtworkForVisibleCard(page) {
  const body = page.locator("[data-compositor-card-body='true']").first();
  await body.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /Escolher visualmente/ }).first().click();
  await dialog.getByText(/Atual · Scryfall/i).waitFor();
  await dialog.getByRole("button", { name: "Fechar seletor de arte" }).click();
}

async function desktopSmoke(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  installRoutes(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: "networkidle" });

  for (const tab of ["Cartas", "Configurações", "Exportar"]) await page.getByRole("tab", { name: tab }).waitFor();
  await addCards(page);

  const bodies = page.locator("[data-compositor-card-body='true']");
  assert.equal(await bodies.count(), 2, "desktop compositor should render two physical cards");

  await chooseFrontArtworkForVisibleCard(page);
  await bodies.nth(1).click();
  const secondPicker = page.getByRole("dialog");
  await secondPicker.getByRole("button", { name: /Escolher visualmente/ }).first().click();
  await secondPicker.getByText(/Atual · Scryfall/i).waitFor();
  await secondPicker.getByRole("button", { name: "MPC Autofill" }).click();
  await secondPicker.getByText(/Mountain · mpc/).waitFor();
  await secondPicker.getByRole("button", { name: /Escolher visualmente/ }).first().click();
  await secondPicker.getByText(/Atual · MPC Autofill/i).waitFor();
  await secondPicker.getByRole("button", { name: "Fechar seletor de arte" }).click();

  await page.getByRole("checkbox", { name: "Selecionar Island, cópia 1 de 1" }).click();
  await page.getByRole("checkbox", { name: "Selecionar Mountain, cópia 1 de 1" }).click();
  await page.getByRole("button", { name: "Desmarcar" }).click();

  const beforeOrder = await page.locator("[data-physical-instance-id]").evaluateAll((nodes) =>
    [...new Set(nodes.map((node) => node.getAttribute("data-physical-instance-id")).filter(Boolean))]
  );
  const source = page.locator("[data-physical-instance-id='instance-2'] [data-compositor-card-body='true']");
  const target = page.locator("[data-physical-instance-id='instance-1'] [data-compositor-card-body='true']");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert(sourceBox && targetBox, "drag targets must have browser layout boxes");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + sourceBox.height / 2, { steps: 3 });
  await page.mouse.move(targetBox.x + 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const afterOrder = await page.locator("[data-physical-instance-id]").evaluateAll((nodes) =>
    [...new Set(nodes.map((node) => node.getAttribute("data-physical-instance-id")).filter(Boolean))]
  );
  assert.notDeepEqual(afterOrder, beforeOrder, "pointer drag should change the canonical physical order");

  await page.getByRole("button", { name: "Salvar como projeto" }).click();
  await page.getByLabel("Estado do salvamento").filter({ hasText: "Salvo" }).waitFor();
  await page.getByRole("button", { name: "Abrir menu do Project" }).click();
  await page.getByRole("button", { name: "Abrir projeto" }).click();
  const openDialog = page.getByRole("dialog", { name: "Abrir projeto" });
  await openDialog.getByRole("button", { name: /Abrir Browser smoke 1/ }).click();
  await page.getByLabel("Estado do salvamento").filter({ hasText: "Salvo" }).waitFor();

  await page.getByRole("tab", { name: "Configurações" }).click();
  await page.getByText("Bleed & Cantos", { exact: true }).waitFor();
  await page.getByText("Guias", { exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Modo de exportação" }).count(), 0, "output mode must not live in settings");

  await page.getByRole("tab", { name: "Exportar" }).click();
  await page.getByRole("combobox", { name: "Modo de exportação" }).waitFor();
  await page.getByRole("button", { name: "Gerar PDF final" }).click();
  await page.getByRole("link", { name: "Baixar tcgprint-browser-smoke.pdf" }).waitFor();
  await page.getByRole("button", { name: "Conferir PDF final" }).click();
  await page.getByRole("dialog", { name: "Conferir PDF final" }).waitFor();

  await page.screenshot({ path: `${artifactDir}/desktop-final.png`, fullPage: true });
  assert.deepEqual(errors, [], `desktop page errors: ${errors.join(" | ")}`);
  await context.close();
}

async function mobileSmoke(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  installRoutes(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: "networkidle" });

  await page.getByTestId("workspace-mobile-open").waitFor();
  await page.getByTestId("workspace-mobile-open").click();
  await page.getByRole("button", { name: "Fechar painel" }).waitFor();
  await page.getByRole("button", { name: "Fechar painel" }).click();

  await addCards(page);
  await page.getByRole("button", { name: "Ajustes" }).click();
  await page.getByText("Bleed & Cantos", { exact: true }).waitFor();
  await page.screenshot({ path: `${artifactDir}/mobile-settings.png`, fullPage: true });

  const viewportMetrics = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(viewportMetrics.scrollWidth <= viewportMetrics.width + 2, `mobile horizontal overflow: ${JSON.stringify(viewportMetrics)}`);

  await page.getByRole("button", { name: "Ajustes" }).click();
  await page.getByRole("button", { name: "Cartas" }).click();
  await page.locator("[data-compositor-card-body='true']").first().click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: `${artifactDir}/mobile-picker.png`, fullPage: true });

  assert.deepEqual(errors, [], `mobile page errors: ${errors.join(" | ")}`);
  await context.close();
}

const browser = await chromium.launch({ headless: true });
try {
  await desktopSmoke(browser);
  await mobileSmoke(browser);
  console.log("Browser smoke passed: desktop + mobile + picker + reorder + Project reopen + export/proof.");
} finally {
  await browser.close();
}
