// @vitest-environment jsdom
import { Profiler } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import RegistrationLayoutPreview from "../../src/app/registration-layout-preview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("compositor zoom interactions", () => {
  it("keeps fit scales stable for duplicate and subpixel observer callbacks while the sidebar changes width", async () => {
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

    const commits: number[] = [];
    const user = userEvent.setup();
    render(<Profiler id="compositor" onRender={(_id, _phase, _actual, _base, _start, commitTime) => commits.push(commitTime)}>
      <RegistrationLayoutPreview
        settings={{ ...DEFAULT_PROJECT_SETTINGS, pageOrientation: "portrait", layout: { skippedSlotIndices: [] } }}
        cardCount={0}
        cards={[]}
        selectedPageNumber={1}
        onSelectPage={vi.fn()}
        onToggleSkippedSlot={vi.fn()}
      />
    </Profiler>);

    const sheet = screen.getByRole("group", { name: /Compositor live/ });
    const scale = () => Number(sheet.getAttribute("data-compositor-zoom-scale"));
    const baseWidthPx = 210 * 96 / 25.4;
    const baseHeightPx = 297 * 96 / 25.4;
    const fitWidth = (width: number) => (width - 32) / baseWidthPx;
    const fitPage = (width: number, height: number) => Math.min(fitWidth(width), (height - 32) / baseHeightPx);

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

    await user.click(screen.getByRole("button", { name: "Fit Width" }));
    expect(scale()).toBeCloseTo(fitWidth(820), 8);
    act(() => notify(610, 500));
    expect(scale()).toBeCloseTo(fitWidth(610), 8);
    act(() => notify(820, 500));
    expect(scale()).toBeCloseTo(fitWidth(820), 8);

    await user.click(screen.getByRole("button", { name: "Fit Page" }));
    act(() => notify(820, 900));
    expect(scale()).toBeCloseTo(fitPage(820, 900), 8);
    act(() => notify(610, 900));
    expect(scale()).toBeCloseTo(fitPage(610, 900), 8);
    act(() => notify(820, 900));
    expect(scale()).toBeCloseTo(fitPage(820, 900), 8);

    const settledScales: number[] = [];
    act(() => notify(820, 900));
    settledScales.push(scale());
    act(() => notify(820, 900));
    settledScales.push(scale());
    const settledCommits = commits.length;
    for (const [width, height] of [[820.1, 900], [820, 900], [820, 900]]) {
      act(() => notify(width, height));
      settledScales.push(scale());
    }
    expect(new Set(settledScales)).toEqual(new Set([fitPage(820, 900)]));
    expect(commits).toHaveLength(settledCommits);
  });

  it("fits its measured viewport, follows resize in fit modes, and keeps manual scale", async () => {
    const user = userEvent.setup();
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

    render(<RegistrationLayoutPreview
      settings={{ ...DEFAULT_PROJECT_SETTINGS, pageOrientation: "portrait", layout: { skippedSlotIndices: [] } }}
      cardCount={0}
      cards={[]}
      selectedPageNumber={1}
      onSelectPage={vi.fn()}
      onToggleSkippedSlot={vi.fn()}
    />);
    const sheet = screen.getByRole("group", { name: /Compositor live/ });
    const scale = () => Number(sheet.getAttribute("data-compositor-zoom-scale"));
    const fitWidthScale = (width: number) => (width - 32) / (210 * 96 / 25.4);

    await waitFor(() => expect(scale()).toBeGreaterThan(0));
    const fitPageSize = { width: 210 * 96 / 25.4 * scale(), height: 297 * 96 / 25.4 * scale() };
    expect(fitPageSize.width).toBeLessThanOrEqual(widthPx - 32);
    expect(fitPageSize.height).toBeLessThanOrEqual(heightPx - 32);

    await user.click(screen.getByRole("button", { name: "Fit Width" }));
    expect(scale()).toBeCloseTo(fitWidthScale(widthPx), 8);
    widthPx = 420;
    heightPx = 850;
    act(() => observers.forEach(({ notify }) => notify()));
    await waitFor(() => expect(scale()).toBeCloseTo(fitWidthScale(widthPx), 8));

    await user.click(screen.getByRole("button", { name: "Fit Page" }));
    widthPx = 390;
    heightPx = 520;
    act(() => observers.forEach(({ notify }) => notify()));
    const fitPageScale = Math.min((widthPx - 32) / (210 * 96 / 25.4), (heightPx - 32) / (297 * 96 / 25.4));
    await waitFor(() => expect(scale()).toBeCloseTo(fitPageScale, 8));

    await user.click(screen.getByRole("button", { name: "100%" }));
    expect(scale()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Aumentar zoom" }));
    expect(scale()).toBe(1.1);
    widthPx = 340;
    heightPx = 600;
    act(() => observers.forEach(({ notify }) => notify()));
    expect(scale()).toBe(1.1);
    expect(sheet.getAttribute("viewBox")).toBe("0 0 210 297");
  });
});
