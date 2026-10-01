import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  CalibrationError,
  parsePhysicalVerificationRecord,
  parsePrinterProfile,
  parsePrinterProfileSnapshot,
  serializePrinterProfileExport,
  type PrinterProfile,
  type PrinterProfileSnapshot,
} from "../../core/calibration";
import {
  computePrinterProfileHash,
  parsePrinterProfileImportJson,
  verifyPrinterProfileSnapshot,
} from "./hash";

interface ProfileRow {
  readonly profile_id: string;
  readonly version: number;
  readonly profile_hash: string;
  readonly profile_json: string;
  readonly created_at: string;
}

interface CurrentProfileRow {
  readonly id: string;
  readonly name: string;
  readonly current_version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PrinterProfileRepositoryOptions {
  readonly idFactory?: () => string;
  readonly now?: () => string;
}

function repositoryError(code: ConstructorParameters<typeof CalibrationError>[0], message: string): never {
  throw new CalibrationError(code, message);
}

function snapshotJson(snapshot: PrinterProfileSnapshot): string {
  const json = JSON.stringify(parsePrinterProfileSnapshot(snapshot));
  if (new TextEncoder().encode(json).byteLength > 64 * 1024) {
    repositoryError("PROFILE_IMPORT_TOO_LARGE", "Printer profile revision exceeds the 64 KiB storage limit.");
  }
  return json;
}

export class PrinterProfileRepository {
  private readonly idFactory: () => string;
  private readonly now: () => string;

  constructor(private readonly database: Database.Database, options: PrinterProfileRepositoryOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  create(input: PrinterProfile): PrinterProfileSnapshot {
    const profile = parsePrinterProfile(input);
    if (profile.physicalValidationStatus !== "software-only" || profile.physicalVerification !== null) {
      repositoryError("INVALID_CALIBRATION", "Physical verification can only be recorded through the explicit verification operation.");
    }
    const version = 1;
    const profileHash = computePrinterProfileHash(profile, version);
    const snapshot = parsePrinterProfileSnapshot({ ...profile, version, profileHash });
    return this.database.transaction(() => {
      if (this.database.prepare("SELECT id FROM printer_profiles WHERE id = ?").get(profile.id)) {
        repositoryError("PROFILE_ID_EXISTS", `Printer profile ${profile.id} already exists.`);
      }
      const createdAt = this.timestamp();
      this.database.prepare("INSERT INTO printer_profiles (id, name, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(profile.id, profile.name, version, createdAt, createdAt);
      this.insertVersion(snapshot, createdAt);
      return snapshot;
    }).immediate();
  }

  list(): PrinterProfileSnapshot[] {
    const rows = this.database.prepare("SELECT id, name, current_version, created_at, updated_at FROM printer_profiles ORDER BY updated_at DESC, id ASC")
      .all() as CurrentProfileRow[];
    return rows.map((row) => this.open(row.id, row.current_version));
  }

  open(profileId: string, version?: number): PrinterProfileSnapshot {
    const current = this.database.prepare("SELECT id, name, current_version, created_at, updated_at FROM printer_profiles WHERE id = ?")
      .get(profileId) as CurrentProfileRow | undefined;
    if (!current) repositoryError("PROFILE_NOT_FOUND", `Printer profile ${profileId} was not found.`);
    const selectedVersion = version ?? current.current_version;
    if (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1) {
      repositoryError("PROFILE_VERSION_MISMATCH", "Requested printer profile version is invalid.");
    }
    const row = this.database.prepare(`
      SELECT profile_id, version, profile_hash, profile_json, created_at
      FROM printer_profile_versions WHERE profile_id = ? AND version = ?
    `).get(profileId, selectedVersion) as ProfileRow | undefined;
    if (!row) repositoryError("PROFILE_VERSION_MISMATCH", `Printer profile ${profileId} has no revision ${selectedVersion}.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.profile_json);
    } catch {
      repositoryError("PROFILE_VERSION_MISMATCH", `Printer profile ${profileId} revision ${selectedVersion} contains invalid JSON.`);
    }
    const snapshot = verifyPrinterProfileSnapshot(parsed);
    if (snapshot.id !== row.profile_id || snapshot.version !== row.version || snapshot.profileHash !== row.profile_hash) {
      repositoryError("PROFILE_VERSION_MISMATCH", `Printer profile ${profileId} revision metadata does not match its stored values.`);
    }
    return snapshot;
  }

  rename(profileId: string, expectedVersion: number, name: string): PrinterProfileSnapshot {
    const current = this.open(profileId);
    return this.update(profileId, expectedVersion, { ...current, name });
  }

  update(profileId: string, expectedVersion: number, candidate: PrinterProfile): PrinterProfileSnapshot {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      repositoryError("PROFILE_VERSION_MISMATCH", "Expected printer profile revision must be a positive safe integer.");
    }
    const supplied = parsePrinterProfile(this.profileValues(candidate));
    if (supplied.id !== profileId) repositoryError("INVALID_CALIBRATION", "A printer profile revision cannot change its profile identity.");
    return this.database.transaction(() => {
      const currentRow = this.database.prepare("SELECT id, name, current_version, created_at, updated_at FROM printer_profiles WHERE id = ?")
        .get(profileId) as CurrentProfileRow | undefined;
      if (!currentRow) repositoryError("PROFILE_NOT_FOUND", `Printer profile ${profileId} was not found.`);
      if (currentRow.current_version !== expectedVersion) {
        repositoryError("PROFILE_REVISION_CONFLICT", `Printer profile ${profileId} revision conflict: expected ${expectedVersion}, current ${currentRow.current_version}.`);
      }
      const previous = this.open(profileId, expectedVersion);
      if (expectedVersion === Number.MAX_SAFE_INTEGER) repositoryError("PROFILE_VERSION_MISMATCH", "Printer profile revision counter is exhausted.");
      const physicalSettingsChanged = previous.paperSize !== supplied.paperSize
        || previous.paperWidthMm !== supplied.paperWidthMm || previous.paperHeightMm !== supplied.paperHeightMm
        || previous.pageOrientation !== supplied.pageOrientation || previous.duplexMode !== supplied.duplexMode
        || JSON.stringify(previous.front) !== JSON.stringify(supplied.front)
        || JSON.stringify(previous.back) !== JSON.stringify(supplied.back)
        || previous.mediaType !== supplied.mediaType
        || previous.printQualityProfile !== supplied.printQualityProfile
        || previous.feedSource !== supplied.feedSource;
      const verificationChanged = JSON.stringify(previous.physicalVerification ?? null) !== JSON.stringify(supplied.physicalVerification ?? null);
      if (verificationChanged) {
        repositoryError("INVALID_CALIBRATION", "Physical verification evidence can only be recorded through the verification operation.");
      }
      if (supplied.physicalValidationStatus !== previous.physicalValidationStatus
        && supplied.physicalValidationStatus !== "software-only") {
        repositoryError("INVALID_CALIBRATION", "Physical validation status can only be changed by recording real verification measurements.");
      }
      const profile = parsePrinterProfile({
        ...supplied,
        physicalValidationStatus: physicalSettingsChanged ? "software-only" : previous.physicalValidationStatus,
        physicalVerification: physicalSettingsChanged ? null : previous.physicalVerification ?? null,
      });
      const version = expectedVersion + 1;
      const snapshot = parsePrinterProfileSnapshot({ ...profile, version, profileHash: computePrinterProfileHash(profile, version) });
      const updatedAt = this.timestamp();
      this.insertVersion(snapshot, updatedAt);
      const update = this.database.prepare(`
        UPDATE printer_profiles SET name = ?, current_version = ?, updated_at = ?
        WHERE id = ? AND current_version = ?
      `).run(profile.name, version, updatedAt, profileId, expectedVersion);
      if (update.changes !== 1) repositoryError("PROFILE_REVISION_CONFLICT", `Printer profile ${profileId} changed during recalibration.`);
      return snapshot;
    }).immediate();
  }

  recordPhysicalVerification(profileId: string, expectedVersion: number, sessionId: string, measurements: unknown): PrinterProfileSnapshot {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      repositoryError("PROFILE_VERSION_MISMATCH", "Expected printer profile revision must be a positive safe integer.");
    }
    if (!Array.isArray(measurements) || measurements.length < 1 || measurements.length > 5) {
      repositoryError("INVALID_CALIBRATION", "Physical verification requires one through five measured target residuals.");
    }
    const normalizedMeasurements = measurements.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) repositoryError("INVALID_CALIBRATION", "Physical verification measurement must be an object.");
      const row = value as Record<string, unknown>;
      if (typeof row.residualXUm !== "number" || !Number.isSafeInteger(row.residualXUm)
        || typeof row.residualYUm !== "number" || !Number.isSafeInteger(row.residualYUm)) {
        repositoryError("INVALID_CALIBRATION", "Physical verification residuals must be integer micrometers.");
      }
      return { pointId: row.pointId, residualXUm: row.residualXUm, residualYUm: row.residualYUm };
    });
    const magnitudes = normalizedMeasurements.map(({ residualXUm, residualYUm }) => Math.hypot(Number(residualXUm), Number(residualYUm)) / 1_000);
    const residualSummaryMm = {
      mean: magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length,
      minimum: Math.min(...magnitudes),
      maximum: Math.max(...magnitudes),
    };
    return this.database.transaction(() => {
      const previous = this.open(profileId);
      if (previous.version !== expectedVersion) {
        repositoryError("PROFILE_REVISION_CONFLICT", `Printer profile ${profileId} revision conflict: expected ${expectedVersion}, current ${previous.version}.`);
      }
      const verification = parsePhysicalVerificationRecord({
        sessionId,
        verifiedAt: this.timestamp(),
        measurements: normalizedMeasurements,
        residualSummaryMm,
      });
      const profile = parsePrinterProfile({
        ...this.profileValues(previous),
        physicalValidationStatus: "physically-verified",
        physicalVerification: verification,
      });
      if (expectedVersion === Number.MAX_SAFE_INTEGER) repositoryError("PROFILE_VERSION_MISMATCH", "Printer profile revision counter is exhausted.");
      const version = expectedVersion + 1;
      const snapshot = parsePrinterProfileSnapshot({ ...profile, version, profileHash: computePrinterProfileHash(profile, version) });
      const updatedAt = this.timestamp();
      this.insertVersion(snapshot, updatedAt);
      const update = this.database.prepare(`
        UPDATE printer_profiles SET name = ?, current_version = ?, updated_at = ?
        WHERE id = ? AND current_version = ?
      `).run(profile.name, version, updatedAt, profileId, expectedVersion);
      if (update.changes !== 1) repositoryError("PROFILE_REVISION_CONFLICT", `Printer profile ${profileId} changed during physical verification.`);
      return snapshot;
    }).immediate();
  }

  duplicate(profileId: string, version?: number): PrinterProfileSnapshot {
    const source = this.open(profileId, version);
    const id = this.idFactory();
    const duplicate = parsePrinterProfile({
      ...this.profileValues(source),
      id,
      name: `${source.name} (cópia)`,
      physicalValidationStatus: "software-only",
      physicalVerification: null,
    });
    return this.create(duplicate);
  }

  import(json: string, options: { readonly acceptPhysicalVerification?: boolean } = {}): PrinterProfileSnapshot {
    const snapshot = parsePrinterProfileImportJson(json);
    if (snapshot.physicalValidationStatus === "physically-verified" && options.acceptPhysicalVerification !== true) {
      repositoryError("INVALID_CALIBRATION", "Imported physical verification evidence requires explicit user acceptance.");
    }
    return this.database.transaction(() => {
      if (this.database.prepare("SELECT id FROM printer_profiles WHERE id = ?").get(snapshot.id)) {
        repositoryError("PROFILE_ID_EXISTS", `Imported printer profile ${snapshot.id} already exists; duplicate it to create a new identity.`);
      }
      const createdAt = this.timestamp();
      this.database.prepare("INSERT INTO printer_profiles (id, name, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(snapshot.id, snapshot.name, snapshot.version, createdAt, createdAt);
      this.insertVersion(snapshot, createdAt);
      return snapshot;
    }).immediate();
  }

  export(profileId: string, version?: number): string {
    return serializePrinterProfileExport(this.open(profileId, version));
  }

  private insertVersion(snapshot: PrinterProfileSnapshot, createdAt: string): void {
    this.database.prepare(`
      INSERT INTO printer_profile_versions (profile_id, version, profile_hash, profile_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.id, snapshot.version, snapshot.profileHash, snapshotJson(snapshot), createdAt);
  }

  private profileValues(value: PrinterProfile): PrinterProfile {
    const { version: _version, profileHash: _profileHash, ...profile } = value as PrinterProfileSnapshot;
    return profile;
  }

  private timestamp(): string {
    const value = this.now();
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      repositoryError("INVALID_CALIBRATION", "Printer profile timestamp must be a valid date string.");
    }
    return value;
  }
}
