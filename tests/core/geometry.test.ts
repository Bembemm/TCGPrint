import { describe, expect, it } from "vitest";
import {
  createCustomPaperFormat,
  MAGIC_STANDARD_CARD,
  PAPER_FORMATS,
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
    expect(createCustomPaperFormat(216.025, 303.5)).toMatchObject({
      widthMm: 216.025,
      heightMm: 303.5,
    });
  });

  it("rejects invalid custom paper dimensions", () => {
    expect(() => createCustomPaperFormat(0, 297)).toThrow(RangeError);
    expect(() => createCustomPaperFormat(210, Number.NaN)).toThrow(RangeError);
  });
});
