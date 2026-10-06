import { describe, expect, it } from "vitest";
import { calculateCompositorScale } from "../../src/app/compositor-zoom";

const pageCases = [
  { name: "portrait", page: { widthMm: 210, heightMm: 297 } },
  { name: "landscape", page: { widthMm: 297, heightMm: 210 } },
] as const;

describe("physical compositor zoom", () => {
  it.each(pageCases)("fits a $name page inside a wide and short viewport", ({ page }) => {
    const viewport = { widthPx: 1_000, heightPx: 420 };
    const scale = calculateCompositorScale(viewport, page);
    const renderedWidth = page.widthMm * 96 / 25.4 * scale;
    const renderedHeight = page.heightMm * 96 / 25.4 * scale;

    expect(renderedWidth).toBeLessThanOrEqual(viewport.widthPx - 32);
    expect(renderedHeight).toBeLessThanOrEqual(viewport.heightPx - 32);
  });

  it.each(pageCases)("fits a $name page inside a narrow and tall viewport", ({ page }) => {
    const viewport = { widthPx: 390, heightPx: 900 };
    const scale = calculateCompositorScale(viewport, page);
    const renderedWidth = page.widthMm * 96 / 25.4 * scale;
    const renderedHeight = page.heightMm * 96 / 25.4 * scale;

    expect(renderedWidth).toBeLessThanOrEqual(viewport.widthPx - 32);
    expect(renderedHeight).toBeLessThanOrEqual(viewport.heightPx - 32);
  });

  it("uses scale 1 before a real viewport measurement is available", () => {
    const page = { widthMm: 210, heightMm: 297 };
    expect(calculateCompositorScale({ widthPx: 0, heightPx: 0 }, page)).toBe(1);
    expect(calculateCompositorScale({ widthPx: 840, heightPx: 0 }, page)).toBe(1);
  });
});
