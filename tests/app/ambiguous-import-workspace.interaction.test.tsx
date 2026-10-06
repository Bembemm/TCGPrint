// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportPreview } from "../../import-engine/types";
import HomePage from "../../src/app/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sourceId = "text:decklist";
const preview = {
  sources: [{ id: sourceId, kind: "text", filename: "decklist.txt", order: 0, sizeBytes: 8 }],
  detections: [{
    sourceId,
    status: "ambiguous",
    candidates: [
      { kind: "csv", confidence: 0.52, reasons: ["CSV structure"] },
      { kind: "tsv", confidence: 0.48, reasons: ["TSV structure"] },
    ],
    reasons: ["More than one importer is plausible."],
  }],
  entries: [],
  report: {
    summary: { totalInputs: 1, recognizedInputs: 0, recognizedEntries: 0, customCards: 0, deckEntries: 0, assets: 0, warnings: 0, errors: 0, ambiguousDetections: 1, unknownInputs: 0 },
    selectedImporters: [],
    detections: [],
    warnings: [],
    errors: [],
    mappings: [],
    pairings: [],
  },
} as ImportPreview;

describe("ambiguous importer choice in the Cards workspace", () => {
  it("shows only ambiguous choices in Cartas and sends the chosen kind through addCards", async () => {
    const user = userEvent.setup();
    let receivedSelections: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/import/preview") return Response.json(preview);
      if (url === "/api/cards/import") {
        receivedSelections = (init?.body as FormData).get("selections") as string;
        return Response.json({
          workingCards: [],
          report: {
            summary: preview.report.summary,
            sources: [{ id: sourceId, kind: "text", sizeBytes: 8 }],
            selectedImporters: [{ sourceId, kind: "csv" }],
            warnings: [],
            errors: [],
            pairings: [],
          },
          providerHealth: {},
        });
      }
      if (url === "/api/cards/resolve") return Response.json({ workingCards: [], providerHealth: {} });
      if (url === "/api/projects") return Response.json({ projects: [] });
      if (url === "/api/templates") return Response.json({ templates: [] });
      if (url === "/api/back-library") return Response.json({ assets: [] });
      if (url === "/api/printer-profiles") return Response.json({ profiles: [] });
      if (url === "/api/cards/artworks/mpc-catalogs") return Response.json({ catalogs: { sources: [], dpi: [], layouts: [], languages: [] } });
      return Response.json({ message: `Rota não simulada: ${url}` }, { status: 404 });
    }));

    render(<HomePage />);
    await user.type(screen.getByRole("textbox", { name: "Cole uma decklist ou URL" }), "1 Island");
    await user.click(screen.getByText("Opções de importação"));
    await user.click(screen.getByRole("button", { name: "Analisar importação" }));

    const cardsPanel = screen.getByRole("tabpanel", { name: "Cartas" });
    const importer = await within(cardsPanel).findByRole("combobox", { name: "Importer para decklist.txt" });
    expect(importer).toHaveValue("");
    await user.selectOptions(importer, "csv");
    await user.click(within(cardsPanel).getByRole("button", { name: "Adicionar cartas" }));

    await waitFor(() => expect(receivedSelections).toBe(JSON.stringify({ [sourceId]: "csv" })));
    await user.click(screen.getByLabelText("Mais opções"));
    await user.click(screen.getByText("Developer"));
    await user.click(screen.getByRole("button", { name: "Diagnóstico" }));
    const diagnostics = screen.getByRole("region", { name: "Developer · Diagnóstico" });
    expect(within(diagnostics).getByText("ImportReport da adição de cartas")).toBeInTheDocument();
    expect(within(diagnostics).queryByRole("combobox", { name: /Importer para/ })).not.toBeInTheDocument();
  });
});
