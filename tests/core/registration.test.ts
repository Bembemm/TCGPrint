import { describe, expect, it } from "vitest";
import {
  createDefaultRegistrationConfig,
  generateRegistrationGeometry,
  parseRegistrationConfig,
  type RegistrationConfig,
  type RegistrationPrimitive,
} from "../../core/registration";

const portraitPage = { widthMm: 210, heightMm: 297 };
const landscapePage = { widthMm: 297, heightMm: 210 };

describe("registration geometry", () => {
  it("none produces no marks or reserved zones", () => {
    const config = parseRegistrationConfig({ type: "none", orientation: "landscape" });

    expect(generateRegistrationGeometry(config, portraitPage)).toEqual({ marks: [], reservedZones: [] });
  });

  it("places three-point marks deterministically in portrait registration orientation", () => {
    const geometry = generateRegistrationGeometry(
      createDefaultRegistrationConfig("three-point", "portrait"),
      portraitPage,
    );

    expect(geometry.marks).toHaveLength(3);
    expect(geometry.marks.map(({ kind, bounds }) => ({ kind, bounds }))).toEqual([
      { kind: "corner", bounds: { xMm: 9.5, yMm: 9.5, widthMm: 6, heightMm: 6 } },
      { kind: "square", bounds: { xMm: 7, yMm: 284, widthMm: 6, heightMm: 6 } },
      { kind: "corner", bounds: { xMm: 194.5, yMm: 281.5, widthMm: 6, heightMm: 6 } },
    ]);
    expect(geometry.reservedZones).toHaveLength(3);
  });

  it("places four-point marks through the same geometry engine", () => {
    const geometry = generateRegistrationGeometry(
      createDefaultRegistrationConfig("four-point", "landscape"),
      landscapePage,
    );

    expect(geometry.marks).toHaveLength(4);
    expect(geometry.marks.map(({ bounds }) => bounds)).toEqual([
      { xMm: 9.5, yMm: 9.5, widthMm: 6, heightMm: 6 },
      { xMm: 281.5, yMm: 9.5, widthMm: 6, heightMm: 6 },
      { xMm: 281.5, yMm: 194.5, widthMm: 6, heightMm: 6 },
      { xMm: 9.5, yMm: 194.5, widthMm: 6, heightMm: 6 },
    ]);
  });

  it("rotates registration geometry onto a portrait page without rotating the page", () => {
    const portraitRegistration = generateRegistrationGeometry(
      createDefaultRegistrationConfig("three-point", "portrait"),
      portraitPage,
    );
    const landscapeRegistration = generateRegistrationGeometry(
      createDefaultRegistrationConfig("three-point", "landscape"),
      portraitPage,
    );

    expect(landscapeRegistration.marks.map(({ kind, bounds }) => ({ kind, bounds }))).toEqual([
      { kind: "corner", bounds: { xMm: 9.5, yMm: 281.5, widthMm: 6, heightMm: 6 } },
      { kind: "square", bounds: { xMm: 7, yMm: 7, widthMm: 6, heightMm: 6 } },
      { kind: "corner", bounds: { xMm: 194.5, yMm: 9.5, widthMm: 6, heightMm: 6 } },
    ]);
    expect(landscapeRegistration.marks).not.toEqual(portraitRegistration.marks);
  });

  it("rotates custom primitives from their declared orientation and keeps their physical stroke width", () => {
    const config: RegistrationConfig = {
      type: "custom",
      orientation: "landscape",
      marks: [[{ type: "line", x1Mm: 10, y1Mm: 10, x2Mm: 20, y2Mm: 10, strokeWidthMm: 1 }]],
      reservedZones: [{ xMm: 8, yMm: 8, widthMm: 14, heightMm: 4 }],
    };

    const geometry = generateRegistrationGeometry(config, portraitPage);

    expect(geometry.marks[0]?.primitives[0]).toEqual({
      type: "line", x1Mm: 10, y1Mm: 287, x2Mm: 10, y2Mm: 277, strokeWidthMm: 1,
    });
    expect(geometry.reservedZones).toContainEqual({ xMm: 8, yMm: 275, widthMm: 4, heightMm: 14 });
  });

  it("keeps deterministic output for repeated built-in and custom calculations", () => {
    const config = createDefaultRegistrationConfig("four-point", "landscape");

    expect(generateRegistrationGeometry(config, landscapePage))
      .toEqual(generateRegistrationGeometry(config, landscapePage));
  });

  it.each([
    { type: "custom", orientation: "portrait", marks: [], reservedZones: [] },
    { type: "custom", orientation: "sideways", marks: [[{ type: "line", x1Mm: 1, y1Mm: 1, x2Mm: 2, y2Mm: 2, strokeWidthMm: 1 }]], reservedZones: [] },
    { type: "three-point", orientation: "portrait", insetXMm: Number.NaN },
    { type: "four-point", orientation: "portrait", insetYMm: Number.POSITIVE_INFINITY },
    { type: "three-point", orientation: "portrait", insetXMm: -1 },
    { type: "three-point", orientation: "portrait", armLengthMm: 0 },
    { type: "three-point", orientation: "portrait", squareSizeMm: 2_001 },
    { type: "none", orientation: "portrait", marks: [[{ type: "line" }]] },
  ])("rejects malformed or out-of-limit configuration $type", (value) => {
    expect(() => parseRegistrationConfig(value)).toThrow();
  });

  it("rejects oversized custom primitive collections and malformed coordinates", () => {
    const line: RegistrationPrimitive = { type: "line", x1Mm: 1, y1Mm: 1, x2Mm: 2, y2Mm: 2, strokeWidthMm: 0.2 };
    const tooManyMarks = {
      type: "custom",
      orientation: "portrait",
      marks: Array.from({ length: 33 }, () => [line]),
      reservedZones: [],
    };

    expect(() => parseRegistrationConfig(tooManyMarks)).toThrow(/marks/i);
    expect(() => parseRegistrationConfig({
      type: "custom", orientation: "portrait",
      marks: [[{ ...line, x2Mm: Number.NEGATIVE_INFINITY }]], reservedZones: [],
    })).toThrow(/finite/i);
  });

  it("rejects cyclic, oversized, and accessor-backed external registration data without invoking getters", () => {
    const cyclic: Record<string, unknown> = { type: "custom", orientation: "portrait", marks: [], reservedZones: [] };
    cyclic.unexpected = cyclic;
    let getterCalled = false;
    const getterBacked = { type: "none" } as Record<string, unknown>;
    Object.defineProperty(getterBacked, "orientation", { enumerable: true, get: () => { getterCalled = true; return "portrait"; } });

    expect(() => parseRegistrationConfig(cyclic)).toThrow(/cyclic|nodes|unsupported/i);
    expect(() => parseRegistrationConfig(getterBacked)).toThrow(/data fields/i);
    expect(getterCalled).toBe(false);
    expect(() => parseRegistrationConfig({
      type: "custom", orientation: "portrait", marks: [[{ type: "line", x1Mm: 1, y1Mm: 1, x2Mm: 2, y2Mm: 2, strokeWidthMm: 0.2 }]],
      reservedZones: [],
      padding: "x".repeat(70_000),
    })).toThrow(/serialized bytes/i);
  });

  it("rejects mark and zone bounds outside the physical page", () => {
    const outsideCustom = {
      type: "custom",
      orientation: "portrait",
      marks: [[{ type: "rect", xMm: 205, yMm: 20, widthMm: 10, heightMm: 5, fill: true, strokeWidthMm: 0 }]],
      reservedZones: [],
    };

    expect(() => generateRegistrationGeometry(parseRegistrationConfig(outsideCustom), portraitPage)).toThrow(/page bounds/i);
    expect(() => generateRegistrationGeometry(
      createDefaultRegistrationConfig("three-point", "portrait", { insetXMm: 300 }),
      portraitPage,
    )).toThrow(/page bounds/i);
  });
});
