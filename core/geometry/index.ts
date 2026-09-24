export interface PhysicalFormat {
  readonly id: string;
  readonly name: string;
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface CardFormat extends PhysicalFormat {
  readonly cornerRadiusMm?: number;
}

export interface PaperFormat extends PhysicalFormat {}

export const MAGIC_STANDARD_CARD: CardFormat = Object.freeze({
  id: "magic-standard",
  name: "Magic Standard",
  widthMm: 63.5,
  heightMm: 88.9,
});

export const PAPER_FORMATS = Object.freeze({
  A4: Object.freeze({ id: "a4", name: "A4", widthMm: 210, heightMm: 297 }),
  A3: Object.freeze({ id: "a3", name: "A3", widthMm: 297, heightMm: 420 }),
  LETTER: Object.freeze({ id: "letter", name: "Letter", widthMm: 215.9, heightMm: 279.4 }),
  LEGAL: Object.freeze({ id: "legal", name: "Legal", widthMm: 215.9, heightMm: 355.6 }),
  TABLOID: Object.freeze({ id: "tabloid", name: "Tabloid", widthMm: 279.4, heightMm: 431.8 }),
} satisfies Record<string, PaperFormat>);

function assertPositiveDimension(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than zero.`);
  }
}

export function createCustomPaperFormat(widthMm: number, heightMm: number): PaperFormat {
  assertPositiveDimension(widthMm, "Paper width");
  assertPositiveDimension(heightMm, "Paper height");

  return Object.freeze({
    id: "custom",
    name: "Custom",
    widthMm,
    heightMm,
  });
}
