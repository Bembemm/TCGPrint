import type { PrinterProfileSnapshot } from "./types";

export interface PrinterProfileCompatibilityRequest {
  readonly paperSize: string;
  readonly paperWidthMm: number;
  readonly paperHeightMm: number;
  readonly pageOrientation: "portrait" | "landscape";
  readonly duplexMode: PrinterProfileSnapshot["duplexMode"];
  readonly duplexFlipMode?: "long-edge" | "short-edge";
  readonly exportSides: readonly ("front" | "back")[];
}

export type PrinterProfileCompatibilityReason =
  | "paper-size-mismatch"
  | "paper-dimensions-mismatch"
  | "orientation-mismatch"
  | "duplex-mode-mismatch"
  | "duplex-edge-mismatch"
  | "single-sided-profile-has-back";

export interface PrinterProfileCompatibility {
  readonly compatible: boolean;
  readonly reasons: readonly PrinterProfileCompatibilityReason[];
}

/** Front-only export intentionally ignores a duplex-mode mismatch; all other physical fields remain strict. */
export function checkPrinterProfileCompatibility(
  profile: PrinterProfileSnapshot,
  request: PrinterProfileCompatibilityRequest,
): PrinterProfileCompatibility {
  const reasons: PrinterProfileCompatibilityReason[] = [];
  if (profile.paperSize.trim().toLocaleLowerCase() !== request.paperSize.trim().toLocaleLowerCase()) reasons.push("paper-size-mismatch");
  if (Math.abs(profile.paperWidthMm - request.paperWidthMm) > 0.001 || Math.abs(profile.paperHeightMm - request.paperHeightMm) > 0.001) {
    reasons.push("paper-dimensions-mismatch");
  }
  if (profile.pageOrientation !== request.pageOrientation) reasons.push("orientation-mismatch");
  const hasBack = request.exportSides.includes("back");
  if (hasBack && profile.duplexMode !== request.duplexMode) reasons.push("duplex-mode-mismatch");
  if (hasBack && profile.duplexMode === "single-sided") reasons.push("single-sided-profile-has-back");
  if (hasBack && profile.duplexMode !== "single-sided" && request.duplexFlipMode
    && !profile.duplexMode.endsWith(request.duplexFlipMode)) reasons.push("duplex-edge-mismatch");
  return Object.freeze({ compatible: reasons.length === 0, reasons: Object.freeze(reasons) });
}
