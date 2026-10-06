// @vitest-environment jsdom
import { Profiler } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import RegistrationLayoutPreview from "../../src/app/registration-layout-preview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("compositor automatic fit interactions", () => {
  it("keeps fit-page stable for duplicate observer callbacks and recalculates after viewport changes", async () => {
    let layoutWidthPx = 820;
    let layoutHeightPx = 500;
    const notifications: Array<(width: number, height: number) => void> = [];
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const notify = (width: number, height: number) => {
          layoutWidthPx = Math.round(width);
          layoutHeightPx = Math.round(height);
          this.callback([{
            target,
            contentRect: { width, height } as DOMRectReadOnly,
          } as ResizeObserverEntry], this as unknown as ResizeObserver);
        };
        notifications.push(notify);
        notify(layoutWidthPx, layoutHeightPx);
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("compositor-sheet-scroll") ? layoutWidthPx : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("compositor-sheet-scroll") ? layoutHeightPx : 0;
    });

    const onSelectPage = vi.fn();
    const onToggleSkippedSlot = vi.fn();
    const commits: number[] = [];
    render(<Profiler id="compositor" onRender={(_id, _phase, _actual, _base, _start, commitTime) => commits.push(commitTime)}>
      <RegistrationLayoutPreview
        settings={{ ...DEFAULT_PROJECT_SETTINGS, pageOrientation: "portrait", layout: { skippedSlotIndices: [] } }}
        cardCount={0}
        cards={[]}
        selectedPageNumber={1}
        onSelectPage={onSelectPage}
        onToggleSkippedSlot={onToggleSkippedSlot}
      />
    </Profiler>);

    const sheet = screen.getByRole("group", { name: /Compositor live/ });
    const scale = () => Number(sheet.getAttribute("data-compositor-zoom-scale"));
    const baseWidthPx = 210 * 96 / 25.4;
    const baseHeightPx = 297 * 96 / 25.4;
    const fitPage = (width: number, height: number) => Math.min((width - 32) / baseWidthPx, (height - 32) / baseHeightPx);

    await waitFor(() => expect(scale()).toBeCloseTo(fitPage(820, 500), 8));
    const notify = notifications[0];
    act(() => notify(820, 500));
    expect(scale()).toBeCloseTo(fitPage(820, 500), 8);
    const stableCommits = commits.length;
    for (const [width, height] of [[820, 500], [820.1, 500], [820, 500]]) {
      act(() => notify(width, height));
      expect(scale()).toBeCloseTo(fitPage(820, 500), 8);
      expect(commits).toHaveLength(stableCommits);
    }

    act(() => notify(610, 500));
    expect(scale()).toBeCloseTo(fitPage(610, 500), 8);
    act(() => notify(820, 900));
    expect(scale()).toBeCloseTo(fitPage(820, 900), 8);
    act(() => notify(390, 520));
    expect(scale()).toBeCloseTo(fitPage(390, 520), 8);
    expect(sheet).toHaveAttribute("data-compositor-zoom-mode", "fit-page");
    expect(screen.queryAllByRole("button", { name: /Fit Page|Fit Width|100%|Reduzir zoom|Aumentar zoom/i })).toHaveLength(0);
    expect(onSelectPage).not.toHaveBeenCalled();
    expect(onToggleSkippedSlot).not.toHaveBeenCalled();
  });

  it("keeps page proportions while fitting every measured viewport automatically", async () => {
    let widthPx = 820;
    let heightPx = 500;
    const observers: Array<{ target: Element; notify: () => void }> = [];
    class TestResizeObserver {
      private readonly callback: ResizeObserverCallback;
      private target: Element | null = null;
      constructor(callback: ResizeObserverCallback) { this.callback = callback; }
      observe(target: Element) {
        this.target = target;
        const notify = () => this.callback([{
          target,
          contentRect: { width: widthPx, height: heightPx } as DOMRectReadOnly,
        } as ResizeObserverEntry], this as unknown as ResizeObserver);
        observers.push({ target, notify });
        notify();
      }
      disconnect() { this.target = null; }
      unobserve() { this.target = null; }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("compositor-sheet-scroll") ? widthPx : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("compositor-sheet-scroll") ? heightPx : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("compositor-sheet-scroll")) {
        return { width: widthPx, height: heightPx, top: 0, left: 0, right: widthPx, bottom: heightPx, x: 0, y: 0, toJSON() {} } as DOMRect;
      }
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });

    const onSelectPage = vi.fn();
    const onToggleSkippedSlot = vi.fn();
    render(<RegistrationLayoutPreview
      settings={{ ...DEFAULT_PROJECT_SETTINGS, pageOrientation: "portrait", layout: { skippedSlotIndices: [] } }}
      cardCount={0}
      cards={[]}
      selectedPageNumber={1}
      onSelectPage={onSelectPage}
      onToggleSkippedSlot={onToggleSkippedSlot}
    />);
    const sheet = screen.getByRole("group", { name: /Compositor live/ });
    const scale = () => Number(sheet.getAttribute("data-compositor-zoom-scale"));
    const fitPageScale = (width: number, height: number) => Math.min(
      (width - 32) / (210 * 96 / 25.4),
      (height - 32) / (297 * 96 / 25.4),
    );

    await waitFor(() => expect(scale()).toBeCloseTo(fitPageScale(widthPx, heightPx), 8));
    expect(sheet).toHaveAttribute("data-compositor-zoom-mode", "fit-page");
    widthPx = 420;
    heightPx = 850;
    act(() => observers.forEach(({ notify }) => notify()));
    await waitFor(() => expect(scale()).toBeCloseTo(fitPageScale(widthPx, heightPx), 8));
    widthPx = 390;
    heightPx = 520;
    act(() => observers.forEach(({ notify }) => notify()));
    await waitFor(() => expect(scale()).toBeCloseTo(fitPageScale(widthPx, heightPx), 8));

    const width = Number.parseFloat(sheet.getAttribute("style")?.match(/width:\s*([0-9.]+)px/)?.[1] ?? "0");
    const height = Number.parseFloat(sheet.getAttribute("style")?.match(/height:\s*([0-9.]+)px/)?.[1] ?? "0");
    expect(width / height).toBeCloseTo(210 / 297, 8);
    expect(sheet.getAttribute("viewBox")).toBe("0 0 210 297");
    expect(screen.queryAllByRole("button", { name: /Fit Page|Fit Width|100%|Reduzir zoom|Aumentar zoom/i })).toHaveLength(0);
    expect(onSelectPage).not.toHaveBeenCalled();
    expect(onToggleSkippedSlot).not.toHaveBeenCalled();
  });
});
