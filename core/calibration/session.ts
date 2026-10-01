import { CalibrationError } from "./errors";
import { parseSideCalibration } from "./transform";
import type { CalibrationSide, PrinterDuplexMode, PrinterProfileSnapshot, SideCalibration } from "./types";

export interface CalibrationVerificationContext {
  readonly sessionId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileHash: string;
  readonly side: CalibrationSide;
  readonly calibration: SideCalibration;
  readonly paperSize: string;
  readonly paperWidthMm: number;
  readonly paperHeightMm: number;
  readonly pageOrientation: "portrait" | "landscape";
  readonly duplexMode: PrinterDuplexMode;
}

/** Identifies the exact generated verification sheet eligible for a measurement attestation. */
export function createCalibrationVerificationSheetKey(context: CalibrationVerificationContext): string {
  if (!context || typeof context.sessionId !== "string" || !context.sessionId
    || typeof context.profileId !== "string" || !context.profileId
    || !Number.isSafeInteger(context.profileVersion) || context.profileVersion < 1
    || typeof context.profileHash !== "string" || !/^[a-f0-9]{64}$/.test(context.profileHash)
    || (context.side !== "front" && context.side !== "back")
    || typeof context.paperSize !== "string" || !context.paperSize.trim() || context.paperSize.length > 80
    || !Number.isFinite(context.paperWidthMm) || context.paperWidthMm <= 0
    || !Number.isFinite(context.paperHeightMm) || context.paperHeightMm <= 0
    || (context.pageOrientation !== "portrait" && context.pageOrientation !== "landscape")
    || !["manual-long-edge", "manual-short-edge", "automatic-long-edge", "automatic-short-edge", "single-sided"].includes(context.duplexMode)) {
    throw new CalibrationError("INVALID_CALIBRATION", "Verification session identity must include a session, exact profile revision/hash, side, paper, orientation, and duplex mode.");
  }
  const calibration = parseSideCalibration(context.calibration);
  return JSON.stringify({
    sessionId: context.sessionId,
    profileId: context.profileId,
    profileVersion: context.profileVersion,
    profileHash: context.profileHash,
    side: context.side,
    calibration,
    paperSize: context.paperSize,
    paperWidthMm: context.paperWidthMm,
    paperHeightMm: context.paperHeightMm,
    pageOrientation: context.pageOrientation,
    duplexMode: context.duplexMode,
  });
}

export function createProfileVerificationContextKey(
  sessionId: string,
  profile: Pick<PrinterProfileSnapshot, "id" | "version" | "profileHash">,
  side: CalibrationSide,
  calibration: SideCalibration,
  paper: { readonly name: string; readonly widthMm: number; readonly heightMm: number },
  pageOrientation: "portrait" | "landscape",
  duplexMode: PrinterDuplexMode,
): string {
  return createCalibrationVerificationSheetKey({
    sessionId,
    profileId: profile.id,
    profileVersion: profile.version,
    profileHash: profile.profileHash,
    side,
    calibration,
    paperSize: paper.name,
    paperWidthMm: paper.widthMm,
    paperHeightMm: paper.heightMm,
    pageOrientation,
    duplexMode,
  });
}
