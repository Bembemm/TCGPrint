import { describe, expect, it } from "vitest";
import { calculateCompositorScale, stepCompositorScale, type CompositorZoomMode } from "../../src/app/compositor-zoom";

const pageCases = [
  { name: "portrait", page: { widthMm: 210, heightMm: 297 } },
  { name: "landscape", page: { widthMm: 297, heightMm: 210 } },
] as const;

describe("physical compositor zoom", () => {
  it.each(pageCases)("fits a $name page inside a wide and short viewport", ({ page }) => {
    const viewport = { widthPx: 1_000, heightPx: 420 };
    const scale = calculateCompositorScale("fit-page", viewport, page);
    const renderedWidth = page.widthMm * 96 / 25.4 * scale;
    const renderedHeight = page.heightMm * 96 / 25.4 * scale;

    expect(renderedWidth).toBeLessThanOrEqual(viewport.widthPx - 32);
    expect(renderedHeight).toBeLessThanOrEqual(viewport.heightPx - 32);
  });

  it.each(pageCases)("fits a $name page inside a narrow and tall viewport", ({ page }) => {
    const viewport = { widthPx: 390, heightPx: 900 };
    const scale = calculateCompositorScale("fit-page", viewport, page);
    const renderedWidth = page.widthMm * 96 / 25.4 * scale;
    const renderedHeight = page.heightMm * 96 / 25.4 * scale;

    expect(renderedWidth).toBeLessThanOrEqual(viewport.widthPx - 32);
    expect(renderedHeight).toBeLessThanOrEqual(viewport.heightPx - 32);
  });

  it.each(pageCases)("fits the full useful width at $name Fit Width", ({ page }) => {
    const viewport = { widthPx: 840, heightPx: 260 };
    const scale = calculateCompositorScale("fit-width", viewport, page);

    expect(page.widthMm * 96 / 25.4 * scale).toBeCloseTo(viewport.widthPx - 32, 8);
  });

  it("defines 100% as scale 1 and steps manual zoom deterministically within limits", () => {
    const page = { widthMm: 210, heightMm: 297 };
    expect(calculateCompositorScale("100%", { widthPx: 200, heightPx: 100 }, page)).toBe(1);
    expect(stepCompositorScale(1, 1)).toBe(1.1);
    expect(stepCompositorScale(1, -1)).toBe(0.9);
    expect(stepCompositorScale(3.95, 1)).toBe(4);
    expect(stepCompositorScale(0.26, -1)).toBe(0.25);
  });

  it("uses scale 1 before a real viewport measurement is available", () => {
    const page = { widthMm: 210, heightMm: 297 };
    for (const mode of ["fit-page", "fit-width", "100%"] satisfies readonly CompositorZoomMode[]) {
      expect(calculateCompositorScale(mode, { widthPx: 0, heightPx: 0 }, page)).toBe(1);
    }
    expect(calculateCompositorScale("fit-width", { widthPx: 840, heightPx: 0 }, page))
      .toBeCloseTo((840 - 32) / (210 * 96 / 25.4), 8);
  });
});
