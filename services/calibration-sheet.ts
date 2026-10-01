import {
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  PDFDocument,
  rgb,
  StandardFonts,
} from "@pdfme/pdf-lib";
import {
  CalibrationError,
  createPrintCalibrationTransform,
  getCalibrationTargetPoints,
  parseSideCalibration,
  type CalibrationSide,
  type PrinterDuplexMode,
  type SideCalibration,
} from "../core/calibration";
import type { CalibrationPointId, CalibrationPointMm } from "../core/calibration";
import type { PageOrientation, PaperFormat } from "../core/geometry";
import { mmToPoints } from "../core/units";

export interface CalibrationSheetRequest {
  readonly sessionId: string;
  readonly draftProfileId: string;
  readonly paperFormat: PaperFormat;
  readonly pageOrientation: PageOrientation;
  readonly duplexMode: PrinterDuplexMode;
  readonly side: CalibrationSide;
  readonly generatedAt?: string;
}

export interface VerificationSheetRequest extends CalibrationSheetRequest {
  readonly calibration: SideCalibration;
}

export interface CalibrationSheetManifest {
  readonly schemaVersion: 1;
  readonly softwareSchemaVersion: "phase-13-v1";
  readonly kind: "calibration" | "verification";
  readonly sessionId: string;
  readonly draftProfileId: string;
  readonly pageFormat: {
    readonly paperSize: string;
    readonly pageOrientation: PageOrientation;
    readonly widthMm: number;
    readonly heightMm: number;
  };
  readonly duplexMode: PrinterDuplexMode;
  readonly side: CalibrationSide;
  readonly targetPointsMm: Readonly<Record<CalibrationPointId, CalibrationPointMm>>;
  readonly generatedAt?: string;
  readonly calibration?: SideCalibration;
  readonly transform?: ReturnType<typeof createPrintCalibrationTransform>["matrix"];
}

export interface CalibrationSheetArtifact {
  readonly pdfBytes: Uint8Array;
  readonly manifest: CalibrationSheetManifest;
}

const DUPLEX_MODES = new Set<PrinterDuplexMode>([
  "manual-long-edge", "manual-short-edge", "automatic-long-edge", "automatic-short-edge", "single-sided",
]);

function invalid(message: string): never {
  throw new CalibrationError("INVALID_CALIBRATION", message);
}

function identifier(value: unknown, key: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    invalid(`${key} must be a bounded safe identifier.`);
  }
  return value;
}

function validateRequest(request: CalibrationSheetRequest, allowCalibration: boolean): { paper: PaperFormat; widthMm: number; heightMm: number } {
  if (!request || typeof request !== "object" || Array.isArray(request)) invalid("Calibration sheet request must be an object.");
  const allowedKeys = new Set(["sessionId", "draftProfileId", "paperFormat", "pageOrientation", "duplexMode", "side", "generatedAt", ...(allowCalibration ? ["calibration"] : [])]);
  if (Reflect.ownKeys(request).some((key) => typeof key !== "string" || !allowedKeys.has(key))) invalid("Calibration sheet request contains an unsupported property such as an arbitrary matrix.");
  identifier(request.sessionId, "sessionId");
  identifier(request.draftProfileId, "draftProfileId");
  if (request.pageOrientation !== "portrait" && request.pageOrientation !== "landscape") invalid("pageOrientation must be portrait or landscape.");
  if (!DUPLEX_MODES.has(request.duplexMode)) invalid("duplexMode is unsupported.");
  if (request.side !== "front" && request.side !== "back") invalid("side must be front or back.");
  if (request.generatedAt !== undefined && (!Number.isFinite(Date.parse(request.generatedAt)) || request.generatedAt.length > 40)) invalid("generatedAt must be a bounded timestamp.");
  const paper = request.paperFormat;
  if (!paper || typeof paper.name !== "string" || !paper.name.trim() || paper.name.length > 80
    || !Number.isFinite(paper.widthMm) || !Number.isFinite(paper.heightMm)
    || paper.widthMm <= 0 || paper.heightMm <= 0 || paper.widthMm > 2_000 || paper.heightMm > 2_000) {
    invalid("paperFormat must contain a name and finite dimensions between 0 and 2000 mm.");
  }
  const baseLandscape = paper.widthMm > paper.heightMm;
  const shouldLandscape = request.pageOrientation === "landscape";
  const widthMm = baseLandscape === shouldLandscape ? paper.widthMm : paper.heightMm;
  const heightMm = baseLandscape === shouldLandscape ? paper.heightMm : paper.widthMm;
  if (widthMm < 120 || heightMm < 150) invalid("Calibration sheet paper dimensions must be at least 120 × 150 mm to fit its reference bars.");
  return { paper, widthMm, heightMm };
}

function topPoint(xMm: number, yMm: number, pageHeightMm: number) {
  return { x: mmToPoints(xMm), y: mmToPoints(pageHeightMm - yMm) };
}

function drawLineTop(
  page: ReturnType<PDFDocument["addPage"]>,
  pageHeightMm: number,
  x1Mm: number,
  y1Mm: number,
  x2Mm: number,
  y2Mm: number,
  color = rgb(0, 0, 0),
  thickness = 0.35,
): void {
  page.drawLine({ start: topPoint(x1Mm, y1Mm, pageHeightMm), end: topPoint(x2Mm, y2Mm, pageHeightMm), color, thickness });
}

function drawTarget(page: ReturnType<PDFDocument["addPage"]>, widthMm: number, heightMm: number, xMm: number, yMm: number, id: string, side: CalibrationSide): void {
  const center = topPoint(xMm, yMm, heightMm);
  const radius = mmToPoints(3.5);
  drawLineTop(page, heightMm, xMm - 6, yMm, xMm + 6, yMm, rgb(0, 0, 0), 0.55);
  drawLineTop(page, heightMm, xMm, yMm - 6, xMm, yMm + 6, rgb(0, 0, 0), 0.55);
  if (side === "front") {
    page.drawCircle({ x: center.x, y: center.y, size: radius, borderColor: rgb(0, 0, 0), borderWidth: 0.55 });
  } else {
    const square = radius * 0.78;
    page.drawRectangle({ x: center.x - square, y: center.y - square, width: square * 2, height: square * 2, borderColor: rgb(0, 0, 0), borderWidth: 0.55 });
    page.drawCircle({ x: center.x, y: center.y, size: radius * 1.25, borderColor: rgb(0, 0, 0), borderWidth: 0.35 });
  }
  const labelX = Math.max(2, Math.min(widthMm - 12, xMm + 5));
  const labelY = Math.max(3, Math.min(heightMm - 4, yMm - 4));
  page.drawText(id, { x: mmToPoints(labelX), y: mmToPoints(heightMm - labelY), size: 7, color: rgb(0, 0, 0) });
}

function drawSheetGeometry(
  page: ReturnType<PDFDocument["addPage"]>,
  widthMm: number,
  heightMm: number,
  side: CalibrationSide,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  duplexMode: PrinterDuplexMode,
  sessionId: string,
  draftProfileId: string,
): void {
  const light = rgb(0.84, 0.86, 0.88);
  const muted = rgb(0.37, 0.39, 0.42);
  const targets = getCalibrationTargetPoints({ widthMm, heightMm });
  const targetCoordinates = [
    { id: "CENTER", point: targets.center },
    { id: "TOP-LEFT", point: targets["top-left"] },
    { id: "TOP-RIGHT", point: targets["top-right"] },
    { id: "BOTTOM-LEFT", point: targets["bottom-left"] },
    { id: "BOTTOM-RIGHT", point: targets["bottom-right"] },
  ] as const;

  page.drawText(`TCGPrint precision calibration · ${side.toUpperCase()}`, {
    x: mmToPoints(10), y: mmToPoints(heightMm - 12), size: 14, font, color: rgb(0, 0, 0),
  });
  page.drawText(`SESSION ${sessionId}   DRAFT ${draftProfileId}`, {
    x: mmToPoints(10), y: mmToPoints(heightMm - 19), size: 6, font, color: muted,
  });

  for (let x = 10; x < widthMm - 9; x += 10) drawLineTop(page, heightMm, x, 25, x, heightMm - 55, light, 0.18);
  for (let y = 25; y < heightMm - 54; y += 10) drawLineTop(page, heightMm, 10, y, widthMm - 10, y, light, 0.18);

  const rulerY = 31;
  drawLineTop(page, heightMm, 10, rulerY, widthMm - 10, rulerY, rgb(0, 0, 0), 0.45);
  for (let x = 10; x <= widthMm - 10; x += 10) {
    const major = x % 50 === 0;
    drawLineTop(page, heightMm, x, rulerY - (major ? 3 : 1.5), x, rulerY + 1.5, rgb(0, 0, 0), 0.35);
    if (major) page.drawText(`${x}`, { x: mmToPoints(x - 1.5), y: mmToPoints(heightMm - rulerY + 3.5), size: 5, font, color: muted });
  }
  const rulerX = 15;
  drawLineTop(page, heightMm, rulerX, 40, rulerX, heightMm - 56, rgb(0, 0, 0), 0.45);
  for (let y = 40; y <= heightMm - 56; y += 10) {
    const major = y % 50 === 0;
    drawLineTop(page, heightMm, rulerX - (major ? 3 : 1.5), y, rulerX + 1.5, y, rgb(0, 0, 0), 0.35);
    if (major) page.drawText(`${y}`, { x: mmToPoints(rulerX + 2), y: mmToPoints(heightMm - y - 1.5), size: 5, font, color: muted });
  }

  for (const target of targetCoordinates) drawTarget(page, widthMm, heightMm, target.point.xMm, heightMm - target.point.yMm, target.id, side);

  // A longer asymmetric angle marker makes clockwise/counter-clockwise drift observable.
  const cx = widthMm / 2;
  const cy = heightMm / 2;
  drawLineTop(page, heightMm, cx - 18, cy, cx + 18, cy, rgb(0, 0, 0), 0.75);
  drawLineTop(page, heightMm, cx + 10, cy - 1.2, cx + 10, cy + 1.2, rgb(0, 0, 0), 0.75);
  drawLineTop(page, heightMm, cx + 17, cy - 1.8, cx + 17, cy + 1.8, rgb(0, 0, 0), 0.75);
  page.drawText("ROTATION 0°  /  +1°", { x: mmToPoints(cx - 17), y: mmToPoints(heightMm - cy - 8), size: 6, font, color: muted });

  const bars = [
    { length: 10, y: heightMm - 41 },
    { length: 50, y: heightMm - 33 },
    { length: 100, y: heightMm - 25 },
  ];
  for (const { length, y } of bars) {
    const x = 10;
    drawLineTop(page, heightMm, x, y, x + length, y, rgb(0, 0, 0), 1.2);
    drawLineTop(page, heightMm, x, y - 1.5, x, y + 1.5, rgb(0, 0, 0), 0.75);
    drawLineTop(page, heightMm, x + length, y - 1.5, x + length, y + 1.5, rgb(0, 0, 0), 0.75);
    page.drawText(`${length} mm`, { x: mmToPoints(x + length + 2), y: mmToPoints(heightMm - y - 1.5), size: 6, font, color: rgb(0, 0, 0) });
  }

  const instructionY = heightMm - 61;
  page.drawText("Print at 100% / Actual Size. Fit OFF; Shrink OFF.", {
    x: mmToPoints(10), y: mmToPoints(heightMm - instructionY), size: 7, font, color: rgb(0, 0, 0),
  });
  page.drawText("Borderless expansion OFF; driver scaling OFF.", {
    x: mmToPoints(10), y: mmToPoints(heightMm - instructionY - 8), size: 7, font, color: rgb(0, 0, 0),
  });
  const modeInstruction = duplexMode === "single-sided"
    ? "Single-sided profile: no reverse pass is used."
    : duplexMode.startsWith("manual-")
      ? `Manual duplex: print FRONT first, then flip/reinsert for BACK (${duplexMode.endsWith("long-edge") ? "turn like a book at the long edge" : "turn like a calendar at the short edge"}).`
      : `Automatic duplex: use the driver's ${duplexMode.endsWith("long-edge") ? "long-edge" : "short-edge"} binding; do not reinsert manually.`;
  page.drawText(modeInstruction, {
    x: mmToPoints(10), y: mmToPoints(heightMm - instructionY - 16), size: 6, font, color: rgb(0, 0, 0),
  });
  if (duplexMode.startsWith("manual-")) {
    // The arrows show the selected sheet turn in a diagram that survives grayscale printing.
    const arrowY = instructionY + 3;
    if (duplexMode.endsWith("short-edge")) {
      const arrowX = widthMm - 20;
      drawLineTop(page, heightMm, arrowX, arrowY - 7, arrowX, arrowY + 7, rgb(0, 0, 0), 0.6);
      drawLineTop(page, heightMm, arrowX - 3, arrowY + 3, arrowX, arrowY + 7, rgb(0, 0, 0), 0.6);
      drawLineTop(page, heightMm, arrowX + 3, arrowY + 3, arrowX, arrowY + 7, rgb(0, 0, 0), 0.6);
    } else {
      drawLineTop(page, heightMm, widthMm - 27, arrowY, widthMm - 13, arrowY, rgb(0, 0, 0), 0.6);
      drawLineTop(page, heightMm, widthMm - 15, arrowY - 3, widthMm - 13, arrowY, rgb(0, 0, 0), 0.6);
      drawLineTop(page, heightMm, widthMm - 15, arrowY + 3, widthMm - 13, arrowY, rgb(0, 0, 0), 0.6);
    }
  }
}

async function generate(request: CalibrationSheetRequest, kind: "calibration" | "verification", calibration?: SideCalibration): Promise<CalibrationSheetArtifact> {
  const { paper, widthMm, heightMm } = validateRequest(request, kind === "verification");
  const checkedCalibration = calibration === undefined ? undefined : parseSideCalibration(calibration);
  if (kind === "verification" && checkedCalibration === undefined) invalid("Verification sheet requires validated side calibration parameters.");
  const transform = checkedCalibration === undefined ? undefined : createPrintCalibrationTransform({ widthMm, heightMm }, checkedCalibration, request.side);
  const targetPointsMm = getCalibrationTargetPoints({ widthMm, heightMm });
  const pdf = await PDFDocument.create();
  pdf.setTitle(`TCGPrint ${kind} sheet ${request.side.toUpperCase()}`);
  pdf.setSubject(`session:${request.sessionId}; draft:${request.draftProfileId}; ${paper.name}; ${request.pageOrientation}; ${request.duplexMode}`);
  pdf.setCreator("TCGPrint Phase 13 calibration sheet generator");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([mmToPoints(widthMm), mmToPoints(heightMm)]);
  if (transform && !transform.isIdentity) {
    const { a, b, c, d, e, f } = transform.matrix;
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, mmToPoints(e), mmToPoints(f)));
  }
  drawSheetGeometry(page, widthMm, heightMm, request.side, font, request.duplexMode, request.sessionId, request.draftProfileId);
  if (transform && !transform.isIdentity) page.pushOperators(popGraphicsState());
  const manifest: CalibrationSheetManifest = {
    schemaVersion: 1,
    softwareSchemaVersion: "phase-13-v1",
    kind,
    sessionId: request.sessionId,
    draftProfileId: request.draftProfileId,
    pageFormat: { paperSize: paper.name, pageOrientation: request.pageOrientation, widthMm, heightMm },
    duplexMode: request.duplexMode,
    side: request.side,
    targetPointsMm,
    ...(request.generatedAt ? { generatedAt: request.generatedAt } : {}),
    ...(checkedCalibration ? { calibration: checkedCalibration } : {}),
    ...(transform ? { transform: transform.matrix } : {}),
  };
  return { pdfBytes: new Uint8Array(await pdf.save()), manifest: Object.freeze(manifest) };
}

export function generateCalibrationSheet(request: CalibrationSheetRequest): Promise<CalibrationSheetArtifact> {
  return generate(request, "calibration");
}

export function generateVerificationSheet(request: VerificationSheetRequest): Promise<CalibrationSheetArtifact> {
  return generate(request, "verification", request.calibration);
}
