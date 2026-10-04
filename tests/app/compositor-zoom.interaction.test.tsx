// @vitest-environment jsdom
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
    const sheet = screen.getByRole("img", { name: /Compositor live/ });
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
