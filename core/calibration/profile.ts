import { CalibrationError } from "./errors";
import { parseSideCalibration } from "./transform";
import type {
  PhysicalVerificationMeasurement,
  PhysicalVerificationRecord,
  PhysicalValidationStatus,
  PrinterDuplexMode,
  PrinterProfile,
  PrinterProfileSnapshot,
} from "./types";

const PROFILE_KEYS = new Set([
  "id", "name", "front", "back", "paperSize", "paperWidthMm", "paperHeightMm", "pageOrientation",
  "duplexMode", "mediaType", "printQualityProfile", "feedSource", "notes", "physicalValidationStatus", "physicalVerification",
]);
const SNAPSHOT_KEYS = new Set([...PROFILE_KEYS, "version", "profileHash"]);
const DUPLEX_MODES = new Set<PrinterDuplexMode>([
  "manual-long-edge", "manual-short-edge", "automatic-long-edge", "automatic-short-edge", "single-sided",
]);
const VALIDATION_STATUSES = new Set<PhysicalValidationStatus>([
  "software-only", "physically-verified",
]);
const MAX_PROFILE_EXPORT_BYTES = 64 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string, code: "PROFILE_IMPORT_INVALID" | "INVALID_CALIBRATION" = "INVALID_CALIBRATION"): never {
  throw new CalibrationError(code, message);
}

function validateKeys(value: Record<string, unknown>, keys: Set<string>, label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.has(key)) invalid(`${label} contains unsupported property ${String(key)}.`);
  }
}

function requiredString(value: unknown, key: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    invalid(`${key} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function optionalString(value: unknown, key: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length > max || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    invalid(`${key} must be at most ${max} characters.`);
  }
  return value.trim();
}

function paperDimension(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_000) {
    invalid(`${key} must be a finite paper dimension greater than 0 and no greater than 2000 mm.`);
  }
  return value;
}

const VERIFICATION_POINT_IDS = new Set(["center", "top-left", "top-right", "bottom-left", "bottom-right"]);

export function parsePhysicalVerificationRecord(value: unknown): PhysicalVerificationRecord {
  if (!isPlainObject(value)) invalid("Physical verification record must be a plain object.");
  validateKeys(value, new Set(["sessionId", "verifiedAt", "measurements", "residualSummaryMm"]), "Physical verification record");
  const sessionId = requiredString(value.sessionId, "physicalVerification.sessionId", 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) invalid("physicalVerification.sessionId must be a safe session identifier.");
  const verifiedAt = requiredString(value.verifiedAt, "physicalVerification.verifiedAt", 1, 40);
  if (!Number.isFinite(Date.parse(verifiedAt))) invalid("physicalVerification.verifiedAt must be a timestamp.");
  if (!Array.isArray(value.measurements) || value.measurements.length < 1 || value.measurements.length > 5) {
    invalid("physicalVerification.measurements must contain one through five measured targets.");
  }
  const seen = new Set<string>();
  const measurements = value.measurements.map((entry, index) => {
    if (!isPlainObject(entry)) invalid(`physicalVerification.measurements[${index}] must be an object.`);
    validateKeys(entry, new Set(["pointId", "residualXUm", "residualYUm"]), `physicalVerification.measurements[${index}]`);
    if (typeof entry.pointId !== "string" || !VERIFICATION_POINT_IDS.has(entry.pointId)) invalid(`physicalVerification.measurements[${index}].pointId is unsupported.`);
    const pointId = entry.pointId as PhysicalVerificationMeasurement["pointId"];
    if (seen.has(pointId)) invalid(`physicalVerification target ${pointId} is duplicated.`);
    seen.add(pointId);
    for (const key of ["residualXUm", "residualYUm"] as const) {
      if (!Number.isSafeInteger(entry[key]) || Math.abs(entry[key] as number) > 10_000) invalid(`physicalVerification.measurements[${index}].${key} must be integer micrometers within ±10000.`);
    }
    return Object.freeze({ pointId, residualXUm: entry.residualXUm as number, residualYUm: entry.residualYUm as number }) satisfies PhysicalVerificationMeasurement;
  });
  const magnitudes = measurements.map(({ residualXUm, residualYUm }) => Math.hypot(residualXUm, residualYUm) / 1_000);
  const residualSummaryMm = {
    mean: magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length,
    minimum: Math.min(...magnitudes),
    maximum: Math.max(...magnitudes),
  };
  if (!isPlainObject(value.residualSummaryMm)) invalid("physicalVerification.residualSummaryMm must be an object.");
  validateKeys(value.residualSummaryMm, new Set(["mean", "minimum", "maximum"]), "Physical verification residual summary");
  for (const key of ["mean", "minimum", "maximum"] as const) {
    const received = value.residualSummaryMm[key];
    if (typeof received !== "number" || !Number.isFinite(received) || Math.abs(received - residualSummaryMm[key]) > 1e-12) {
      invalid(`physicalVerification.residualSummaryMm.${key} does not match its measured residuals.`);
    }
  }
  return Object.freeze({ sessionId, verifiedAt, measurements: Object.freeze(measurements), residualSummaryMm: Object.freeze(residualSummaryMm) });
}

export function parsePrinterProfile(value: unknown): PrinterProfile {
  if (!isPlainObject(value)) invalid("Printer profile must be a plain object.");
  validateKeys(value, PROFILE_KEYS, "Printer profile");
  for (const key of ["id", "name", "front", "back", "paperSize", "paperWidthMm", "paperHeightMm", "pageOrientation", "duplexMode", "physicalValidationStatus"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(`Printer profile is missing ${key}.`);
  }
  if (typeof value.pageOrientation !== "string" || !["portrait", "landscape"].includes(value.pageOrientation)) {
    invalid("pageOrientation must be portrait or landscape.");
  }
  if (typeof value.duplexMode !== "string" || !DUPLEX_MODES.has(value.duplexMode as PrinterDuplexMode)) {
    invalid("duplexMode is unsupported.");
  }
  if (typeof value.physicalValidationStatus !== "string" || !VALIDATION_STATUSES.has(value.physicalValidationStatus as PhysicalValidationStatus)) {
    invalid("physicalValidationStatus is unsupported.");
  }
  const id = requiredString(value.id, "id", 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) invalid("id must be a safe opaque identifier without path separators.");
  const profile = {
    id,
    name: requiredString(value.name, "name", 1, 160),
    front: parseSideCalibration(value.front),
    back: parseSideCalibration(value.back),
    paperSize: requiredString(value.paperSize, "paperSize", 1, 80),
    paperWidthMm: paperDimension(value.paperWidthMm, "paperWidthMm"),
    paperHeightMm: paperDimension(value.paperHeightMm, "paperHeightMm"),
    pageOrientation: value.pageOrientation as "portrait" | "landscape",
    duplexMode: value.duplexMode as PrinterDuplexMode,
    ...(optionalString(value.mediaType, "mediaType", 160) !== undefined ? { mediaType: optionalString(value.mediaType, "mediaType", 160) } : {}),
    ...(optionalString(value.printQualityProfile, "printQualityProfile", 160) !== undefined ? { printQualityProfile: optionalString(value.printQualityProfile, "printQualityProfile", 160) } : {}),
    ...(optionalString(value.feedSource, "feedSource", 160) !== undefined ? { feedSource: optionalString(value.feedSource, "feedSource", 160) } : {}),
    ...(optionalString(value.notes, "notes", 2_000) !== undefined ? { notes: optionalString(value.notes, "notes", 2_000) } : {}),
    physicalValidationStatus: value.physicalValidationStatus as PhysicalValidationStatus,
    physicalVerification: value.physicalVerification === undefined || value.physicalVerification === null
      ? null
      : parsePhysicalVerificationRecord(value.physicalVerification),
  } satisfies PrinterProfile;
  if ((profile.physicalValidationStatus === "physically-verified") !== (profile.physicalVerification !== null)) {
    invalid("physically-verified profiles must include measured residual evidence, and other statuses must not claim it.");
  }
  return Object.freeze(profile);
}

export function parsePrinterProfileSnapshot(value: unknown): PrinterProfileSnapshot {
  if (!isPlainObject(value)) invalid("Printer profile snapshot must be a plain object.", "PROFILE_IMPORT_INVALID");
  validateKeys(value, SNAPSHOT_KEYS, "Printer profile snapshot");
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) invalid("Profile version must be a positive safe integer.", "PROFILE_IMPORT_INVALID");
  if (typeof value.profileHash !== "string" || !/^[a-f0-9]{64}$/.test(value.profileHash)) invalid("Profile hash must be a lowercase SHA-256 digest.", "PROFILE_IMPORT_INVALID");
  return Object.freeze({ ...parsePrinterProfile(Object.fromEntries(Object.entries(value).filter(([key]) => PROFILE_KEYS.has(key)))), version: value.version as number, profileHash: value.profileHash });
}

export function parsePrinterProfileImport(value: unknown): PrinterProfileSnapshot {
  if (!isPlainObject(value)) invalid("Printer profile import must be a plain object.", "PROFILE_IMPORT_INVALID");
  validateKeys(value, new Set(["schemaVersion", "profile"]), "Printer profile import");
  if (value.schemaVersion !== 1) invalid("Printer profile import schema version is not supported.", "PROFILE_IMPORT_INVALID");
  return parsePrinterProfileSnapshot(value.profile);
}

export function serializePrinterProfileExport(snapshot: PrinterProfileSnapshot): string {
  const value = { schemaVersion: 1, profile: parsePrinterProfileSnapshot(snapshot) };
  const json = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(json).byteLength > MAX_PROFILE_EXPORT_BYTES) {
    throw new CalibrationError("PROFILE_IMPORT_TOO_LARGE", "Printer profile export exceeds the 64 KiB limit.");
  }
  return json;
}

export function parsePrinterProfileImportJson(json: string): PrinterProfileSnapshot {
  if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > MAX_PROFILE_EXPORT_BYTES) {
    throw new CalibrationError("PROFILE_IMPORT_TOO_LARGE", "Printer profile import exceeds the 64 KiB limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    invalid("Printer profile import must contain valid JSON.", "PROFILE_IMPORT_INVALID");
  }
  return parsePrinterProfileImport(parsed);
}
