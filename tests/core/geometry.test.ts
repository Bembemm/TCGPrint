import { describe, expect, it } from "vitest";
import {
  createPageConfiguration,
  createCustomPaperFormat,
  MAGIC_STANDARD_CARD,
  PAPER_FORMATS,
  type PageOrientation,
} from "../../core/geometry";

describe("physical formats", () => {
  it("defines Magic Standard at its specified trim size", () => {
    expect(MAGIC_STANDARD_CARD).toMatchObject({
      widthMm: 63.5,
      heightMm: 88.9,
    });
  });

  it("defines the initial paper formats in millimeters", () => {
    expect(PAPER_FORMATS.A4).toMatchObject({ widthMm: 210, heightMm: 297 });
    expect(PAPER_FORMATS.A3).toMatchObject({ widthMm: 297, heightMm: 420 });
    expect(PAPER_FORMATS.LETTER).toMatchObject({ widthMm: 215.9, heightMm: 279.4 });
    expect(PAPER_FORMATS.LEGAL).toMatchObject({ widthMm: 215.9, heightMm: 355.6 });
    expect(PAPER_FORMATS.TABLOID).toMatchObject({ widthMm: 279.4, heightMm: 431.8 });
  });

  it("preserves decimal dimensions in a custom paper format", () => {
    const paper = createCustomPaperFormat(216.025, 303.5);

    expect(paper).toMatchObject({
      widthMm: 216.025,
      heightMm: 303.5,
    });
    expect(paper).not.toHaveProperty("id");
  });

  it("rejects invalid custom paper dimensions", () => {
    expect(() => createCustomPaperFormat(0, 297)).toThrow(RangeError);
    expect(() => createCustomPaperFormat(Number.POSITIVE_INFINITY, 297)).toThrow(RangeError);
    expect(() => createCustomPaperFormat(210, Number.NaN)).toThrow(RangeError);
  });

  it("keeps page orientation independent of the paper's physical dimensions", () => {
    const page = createPageConfiguration(PAPER_FORMATS.A4, "landscape", {
      top: 12.25,
      right: 8.5,
      bottom: 13.75,
      left: 9.125,
    });

    expect(page).toMatchObject({
      paper: { widthMm: 210, heightMm: 297 },
      orientation: "landscape",
      marginsMm: { top: 12.25, right: 8.5, bottom: 13.75, left: 9.125 },
    });
    expect(page.paper.widthMm).toBe(210);
    expect(page.paper.heightMm).toBe(297);
  });

  it.each(["portrait", "landscape"] as const)("accepts %s page orientation", (orientation) => {
    expect(createPageConfiguration(PAPER_FORMATS.A4, orientation, {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    }).orientation).toBe(orientation);
  });

  it.each(["top", "right", "bottom", "left"] as const)(
    "rejects a negative %s page margin",
    (side) => {
      expect(() => createPageConfiguration(PAPER_FORMATS.A4, "portrait", {
        top: 1,
        right: 1,
        bottom: 1,
        left: 1,
        [side]: -0.25,
      })).toThrow(RangeError);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-finite page margins (%s)",
    (invalidMargin) => {
      expect(() => createPageConfiguration(PAPER_FORMATS.A4, "portrait", {
        top: invalidMargin,
        right: 0,
        bottom: 0,
        left: 0,
      })).toThrow(RangeError);
    },
  );

  it("rejects an unsupported page orientation at runtime", () => {
    expect(() => createPageConfiguration(
      PAPER_FORMATS.A4,
      "diagonal" as PageOrientation,
      { top: 0, right: 0, bottom: 0, left: 0 },
    )).toThrow(RangeError);
  });
});
