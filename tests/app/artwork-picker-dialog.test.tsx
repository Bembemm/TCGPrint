// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { useCallback, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArtworkPickerDialog, { type FocusableElement } from "../../src/app/artwork-picker-dialog";
import { ArtworkCandidateGrid, filterAndSortArtworkCandidates, sliceArtworkPage, type ArtworkCandidateView } from "../../src/app/artwork-candidate-grid";

afterEach(cleanup);

const candidates: ArtworkCandidateView[] = Array.from({ length: 1_200 }, (_, index) => ({
  id: `scryfall:printing-${index + 1}:front`,
  source: "scryfall",
  identityId: "scryfall:oracle:island",
  faceId: "front",
  faceName: `Printing ${index + 1}`,
  previewUri: `/api/cards/artworks/printing-${index + 1}/preview`,
  releasedAt: new Date(Date.UTC(2000 + (index % 20), 0, 1)).toISOString(),
  ...(index === 1099 ? { effectiveDpi: 1_200 } : { effectiveDpi: 300 + (index % 200) }),
  metadata: {
    providerRank: 1_200 - index,
    ...(index === 0 ? { imageStatus: "verified", tags: ["watercolor"], originalFormat: "png", byteLength: 120_000, fullArt: true } : {}),
  },
  originalAvailable: true,
}));

function DialogHarness() {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <div data-testid="background" inert={open || undefined} aria-hidden={open || undefined}>
      <button ref={openerRef} type="button" onClick={() => setOpen(true)}>Abrir picker</button>
    </div>
    {open && <ArtworkPickerDialog title="Island picker" onClose={close} restoreFocusRef={openerRef}>
      <input data-picker-initial-focus aria-label="Buscar arte" />
      <button type="button">Ação final</button>
    </ArtworkPickerDialog>}
  </>;
}

function PagedGridHarness() {
  const [pageIndex, setPageIndex] = useState(0);
  return <ArtworkCandidateGrid
    candidates={candidates}
    windowLimit={60}
    pageIndex={pageIndex}
    pageSize={60}
    onPageChange={setPageIndex}
    catalogTotal={candidates.length}
    filterTotal={candidates.length}
    catalogLabel="Scryfall"
    cardName="Island"
    onSelect={vi.fn()}
    onLoadMore={vi.fn()}
  />;
}

function SvgOpenerHarness() {
  const [open, setOpen] = useState(false);
  const [targetPresent, setTargetPresent] = useState(true);
  const openerRef = useRef<FocusableElement | null>(null);
  const fallbackRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <svg aria-label="Carta">
      {targetPresent && <rect
        ref={(element) => { openerRef.current = element; }}
        role="button"
        tabIndex={0}
        aria-label="Abrir picker da carta"
        width="30"
        height="40"
        onClick={() => setOpen(true)}
      />}
    </svg>
    <button ref={fallbackRef} type="button">Compositor</button>
    <button type="button" onClick={() => setTargetPresent(false)}>Remover carta</button>
    {open && <ArtworkPickerDialog title="Carta picker" onClose={close} restoreFocusRef={openerRef} fallbackFocusRef={fallbackRef}>
      <input data-picker-initial-focus aria-label="Buscar carta" />
    </ArtworkPickerDialog>}
  </>;
}

describe("M6 Artwork Picker dialog", () => {
  it("has an accessible modal, traps focus, closes with Escape, and restores the opener focus", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Abrir picker" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Island picker" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("background")).toHaveAttribute("inert");
    expect(screen.getByTestId("background")).toHaveAttribute("aria-hidden", "true");
    const search = within(dialog).getByRole("textbox", { name: "Buscar arte" });
    const close = within(dialog).getByRole("button", { name: "Fechar seletor de arte" });
    const last = within(dialog).getByRole("button", { name: "Ação final" });
    expect(document.activeElement).toBe(search);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(search);
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Island picker" })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
    expect(screen.getByTestId("background")).not.toHaveAttribute("inert");
  });

  it("restores focus to a connected SVG opener and safely falls back if its card was removed", async () => {
    const user = userEvent.setup();
    render(<SvgOpenerHarness />);

    const opener = screen.getByRole("button", { name: "Abrir picker da carta" });
    await user.click(opener);
    expect(await screen.findByRole("dialog", { name: "Carta picker" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fechar seletor de arte" }));
    expect(document.activeElement).toBe(opener);

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Remover carta" }));
    await user.click(screen.getByRole("button", { name: "Fechar seletor de arte" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Compositor" }));
  });

  it("filters and ranks the full 1200-item catalog and jumps to result 1100 with at most 60 cards mounted", async () => {
    const byName = filterAndSortArtworkCandidates(candidates, "Printing 1100", "recommended");
    const byDpi = filterAndSortArtworkCandidates(candidates, "", "dpi");
    const byProvider = filterAndSortArtworkCandidates(candidates, "", "provider");
    expect(byName).toHaveLength(1);
    expect(byName[0]?.id).toBe(candidates[1099]?.id);
    expect(byDpi[0]?.id).toBe(candidates[1099]?.id);
    expect(byProvider[0]?.id).toBe(candidates[1199]?.id);
    expect(sliceArtworkPage(candidates, 18, 60)).toContain(candidates[1099]);

    const user = userEvent.setup();
    render(<PagedGridHarness />);
    expect(document.querySelectorAll(".artwork-candidate")).toHaveLength(60);
    const firstCandidate = document.querySelector('.artwork-candidate[data-candidate-rank="1"]');
    expect(firstCandidate).toHaveTextContent("DPI efetivo · verificado");
    expect(firstCandidate).toHaveTextContent("Validação da imagem no provider: verified");
    expect(firstCandidate).toHaveTextContent("Tags: watercolor");
    expect(firstCandidate?.querySelector("img")).toHaveAttribute("loading", "lazy");
    const jump = screen.getByRole("spinbutton", { name: "Ir para resultado do catálogo" });
    await user.type(jump, "1100");
    await user.click(screen.getByRole("button", { name: "Ir" }));

    await waitFor(() => expect(document.querySelector('[data-candidate-rank="1100"]')).toBeInTheDocument());
    expect(document.querySelectorAll(".artwork-candidate")).toHaveLength(60);
    expect(document.querySelector('[data-candidate-rank="1"]')).not.toBeInTheDocument();
  });

  it("shows provider-reported MPC DPI separately when an effective DPI is already known", () => {
    const mpcCandidate: ArtworkCandidateView = {
      ...candidates[0]!,
      id: `mpc:${"1".repeat(64)}`,
      source: "mpc",
      effectiveDpi: 450,
      metadata: { dpi: 820, originalFormat: "png" },
    };
    render(<ArtworkCandidateGrid
      candidates={[mpcCandidate]} windowLimit={60} catalogTotal={1} filterTotal={1} catalogLabel="MPC" cardName="Island"
      onSelect={vi.fn()} onLoadMore={vi.fn()}
    />);

    expect(screen.getByText(/450 DPI efetivo · verificado.*820 DPI informado pelo MPC/)).toBeInTheDocument();
  });
});
