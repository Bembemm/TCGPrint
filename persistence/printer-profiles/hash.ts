import { createHash } from "node:crypto";
import { CalibrationError } from "../../core/calibration/errors";
import { parsePrinterProfile, parsePrinterProfileImport, parsePrinterProfileImportJson as parseProfileImportJson, parsePrinterProfileSnapshot } from "../../core/calibration/profile";
import type { PrinterProfile, PrinterProfileSnapshot } from "../../core/calibration/types";

/** Canonical bounded serialization used for hashes and import tamper detection. */
export function canonicalPrinterProfileJson(profileValue: PrinterProfile, version: number): string {
  const profile = parsePrinterProfile(Object.fromEntries(
    Object.entries(profileValue).filter(([key]) => key !== "version" && key !== "profileHash"),
  ));
  if (!Number.isSafeInteger(version) || version < 1) throw new CalibrationError("PROFILE_IMPORT_INVALID", "Profile revision must be a positive safe integer.");
  return JSON.stringify({
    id: profile.id,
    version,
    name: profile.name,
    front: profile.front,
    back: profile.back,
    paperSize: profile.paperSize,
    paperWidthMm: profile.paperWidthMm,
    paperHeightMm: profile.paperHeightMm,
    pageOrientation: profile.pageOrientation,
    duplexMode: profile.duplexMode,
    mediaType: profile.mediaType ?? null,
    printQualityProfile: profile.printQualityProfile ?? null,
    feedSource: profile.feedSource ?? null,
    notes: profile.notes ?? null,
    physicalValidationStatus: profile.physicalValidationStatus,
    physicalVerification: profile.physicalVerification ?? null,
  });
}

export function computePrinterProfileHash(profile: PrinterProfile, version: number): string {
  return createHash("sha256").update(canonicalPrinterProfileJson(profile, version), "utf8").digest("hex");
}

export function verifyPrinterProfileSnapshot(snapshotValue: unknown): PrinterProfileSnapshot {
  const snapshot = parsePrinterProfileSnapshot(snapshotValue);
  if (computePrinterProfileHash(snapshot, snapshot.version) !== snapshot.profileHash) {
    throw new CalibrationError("PROFILE_VERSION_MISMATCH", "Printer profile revision hash does not match its immutable values.");
  }
  return snapshot;
}

export function parsePrinterProfileImportJson(json: string): PrinterProfileSnapshot {
  const snapshot = parseProfileImportJson(json);
  return verifyPrinterProfileSnapshot(snapshot);
}
