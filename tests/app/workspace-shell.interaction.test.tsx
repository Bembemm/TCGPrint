// @vitest-environment jsdom
import { useState } from "react";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkingCard } from "../../core/cards/types";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import RegistrationLayoutPreview from "../../src/app/registration-layout-preview";
import WorkspaceShell, { WORKSPACE_SECTIONS, type WorkspaceSection } from "../../src/app/workspace-shell";

afterEach(cleanup);

function DraftField({ label }: { readonly label: string }) {
  const [value, setValue] = useState("");
  return <label>{label}<input value={value} onChange={(event) => setValue(event.currentTarget.value)} /></label>;
}

function workspace() {
  const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, <DraftField key={id} label={`${id} draft`} />])) as Record<WorkspaceSection, ReactNode>;
  return <WorkspaceShell sections={sections} preview={<DraftField label="preview draft" />} hasCards />;
}

function previewCard(id: string, order: number): WorkingCard {
  return {
    id,
    quantity: 1,
    order,
    section: "Mainboard",
    importSource: { sourceId: `deck:${id}`, importKind: "text", entryKind: "deck-card" },
    identityHints: { name: id },
    identity: null,
    identityResolution: { status: "unresolved", candidates: [], confirmed: false },
    faces: [{ id: "front", side: "front", name: id }],
    selectedArtworkByFace: {},
    backMode: "project-default",
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
}

describe("workspace shell interactions", () => {
  it("orders all sidebar sections with Cartas first and exposes the selected tab", () => {
    render(workspace());

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(WORKSPACE_SECTIONS.map(({ label }) => label));
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("complementary", { name: "Painel lateral" })).toBeInTheDocument();
  });

  it("switches sections with arrow keys and keeps hidden section drafts mounted", async () => {
    const user = userEvent.setup();
    render(workspace());

    const cardsTab = screen.getByRole("tab", { name: "Cartas" });
    cardsTab.focus();
    await user.keyboard("{ArrowRight}");
    const artworkTab = screen.getByRole("tab", { name: "Artwork" });
    expect(artworkTab).toHaveAttribute("aria-selected", "true");
    expect(artworkTab).toHaveFocus();

    const draft = screen.getByLabelText("artwork draft");
    await user.type(draft, "selected card draft");
    await user.click(screen.getByRole("tab", { name: "Projeto" }));
    await user.click(artworkTab);

    expect(screen.getByLabelText("artwork draft")).toHaveValue("selected card draft");
    expect(draft.isConnected).toBe(true);
    const previewDraft = screen.getByLabelText("preview draft");
    await user.type(previewDraft, "physical preview stays mounted");
    await user.click(screen.getByRole("tab", { name: "Corte" }));
    expect(screen.getByLabelText("preview draft")).toHaveValue("physical preview stays mounted");
  });

  it("keeps skipped-slot editing active through the selected-copy action while navigating", async () => {
    const user = userEvent.setup();
    const cards = [previewCard("Island", 0), previewCard("Mountain", 1)];
    const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, <p key={id}>{id}</p>])) as Record<WorkspaceSection, ReactNode>;
    function PreviewHarness() {
      const [skippedSlotIndices, setSkippedSlotIndices] = useState<readonly number[]>([]);
      return <WorkspaceShell
        sections={sections}
        hasCards
        preview={<RegistrationLayoutPreview
          settings={{ ...DEFAULT_PROJECT_SETTINGS, layout: { rows: 1, columns: 2, skippedSlotIndices } }}
          cardCount={2}
          cards={cards}
          selectedPageNumber={1}
          onSelectPage={() => undefined}
          onToggleSkippedSlot={(index) => setSkippedSlotIndices((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index])}
        />}
      />;
    }
    render(<PreviewHarness />);

    expect(screen.getByRole("main", { name: "Preview e compositor atual" })).toContainElement(screen.getByRole("region", { name: "Compositor live" }));
    const firstSlot = screen.getByRole("button", { name: /Slot 1 · carta física 1/ });
    await user.click(firstSlot);
    expect(firstSlot).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Desativar slot da carta selecionada" }));
    expect(screen.getByText("SKIP 1")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Artwork" }));
    expect(screen.getByRole("button", { name: "Slot 1 desativado" })).toHaveAttribute("aria-pressed", "true");
  });

  it("collapses and reopens the desktop sidebar without changing its active section", async () => {
    const user = userEvent.setup();
    render(workspace());
    await user.click(screen.getByRole("tab", { name: "PDF" }));

    await user.click(screen.getByRole("button", { name: "Recolher painel" }));
    expect(screen.getByRole("complementary", { name: "Painel lateral" })).toHaveAttribute("data-collapsed", "true");
    await user.click(screen.getByTestId("workspace-reopen"));

    expect(screen.getByRole("tab", { name: "PDF" })).toHaveAttribute("aria-selected", "true");
  });

  it("opens Cartas from the empty state and restores a collapsed sidebar", async () => {
    const user = userEvent.setup();
    const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, <DraftField key={id} label={`${id} draft`} />])) as Record<WorkspaceSection, ReactNode>;
    render(<WorkspaceShell sections={sections} preview={<div />} hasCards={false} />);

    await user.click(screen.getByRole("tab", { name: "PDF" }));
    await user.click(screen.getByRole("button", { name: "Recolher painel" }));
    await user.click(screen.getByRole("button", { name: "Abrir Cartas" }));

    expect(screen.getByRole("tab", { name: "Cartas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("complementary", { name: "Painel lateral" })).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByLabelText("cards draft")).toBeInTheDocument();
  });

  it("opens a right drawer, keeps clicks inside open, closes with Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(workspace());
    const trigger = screen.getByTestId("workspace-mobile-open");

    await user.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "Painel lateral" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("tab", { name: "Cartas" })).toHaveFocus();

    await user.click(within(drawer).getByRole("tab", { name: "Artwork" }));
    expect(drawer).toHaveAttribute("data-drawer-open", "true");
    expect(screen.getByRole("tab", { name: "Artwork" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(drawer).toHaveAttribute("data-drawer-open", "false");
    expect(trigger).toHaveFocus();
  });

  it("opens the mobile drawer after a desktop collapse and clears the collapsed state", async () => {
    const user = userEvent.setup();
    render(workspace());
    await user.click(screen.getByRole("button", { name: "Recolher painel" }));
    await user.click(screen.getByTestId("workspace-mobile-open"));

    expect(screen.getByRole("dialog", { name: "Painel lateral" })).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("tab", { name: "Cartas" })).toHaveFocus();
  });

  it("closes from backdrop or close button and returns focus to the opener", async () => {
    const user = userEvent.setup();
    render(workspace());
    const trigger = screen.getByTestId("workspace-mobile-open");

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Fechar painel pelo fundo" }));
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Fechar painel" }));
    expect(trigger).toHaveFocus();
  });

  it("keeps keyboard focus inside the mobile dialog and skips hidden desktop actions", async () => {
    const user = userEvent.setup();
    const sections = Object.fromEntries(WORKSPACE_SECTIONS.map(({ id }) => [id, id === "cards"
      ? <><DraftField label="cards draft" /><details><summary>Filtros MPC avançados</summary><label>Filtro oculto<input /></label></details></>
      : <DraftField key={id} label={`${id} draft`} />])) as Record<WorkspaceSection, ReactNode>;
    render(<WorkspaceShell sections={sections} preview={<DraftField label="preview draft" />} hasCards />);
    await user.click(screen.getByTestId("workspace-mobile-open"));
    screen.getByRole("button", { name: "Recolher painel" }).style.display = "none";

    const close = screen.getByRole("button", { name: "Fechar painel" });
    const cardDraft = screen.getByLabelText("cards draft");
    const advancedSummary = screen.getByText("Filtros MPC avançados");
    close.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(advancedSummary).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(cardDraft).toHaveFocus();
    await user.tab();
    expect(advancedSummary).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it("defines desktop, tablet, and mobile drawer layouts without horizontal page overflow", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+380px/);
    expect(css).toContain("@media (min-width: 701px) and (max-width: 1024px)");
    expect(css).toContain("@media (max-width: 700px)");
    expect(css).toMatch(/\.workspace-sidebar \{[^}]*position:\s*fixed;[^}]*right:\s*0;[^}]*width:\s*min\(420px,\s*100vw\)/s);
    expect(css).toContain(".workspace-shell[data-drawer-open=\"true\"] .workspace-backdrop");
    expect(css).toContain("html, body { width: 100%; height: 100%; overflow: hidden; }");
  });
});
