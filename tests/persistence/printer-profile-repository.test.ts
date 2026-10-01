import { afterEach, describe, expect, it } from "vitest";
import { openProjectDatabase } from "../../persistence/projects/database";
import { PrinterProfileRepository } from "../../persistence/printer-profiles/repository";
import type { PrinterProfile } from "../../core/calibration";

const profile: PrinterProfile = {
  id: "laser-a4",
  name: "Laser A4",
  front: { offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 },
  back: { offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1, scaleY: 1 },
  paperSize: "A4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  pageOrientation: "portrait",
  duplexMode: "manual-long-edge",
  physicalValidationStatus: "software-only",
};

describe("SQLite printer profile version library", () => {
  let database: ReturnType<typeof openProjectDatabase> | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function repository() {
    database = openProjectDatabase(":memory:");
    return new PrinterProfileRepository(database, { idFactory: () => "generated-id", now: () => "2026-10-01T12:00:00.000Z" });
  }

  it("creates, lists, and reopens revision one with its verified hash", () => {
    const profiles = repository();
    const created = profiles.create(profile);
    expect(created.version).toBe(1);
    expect(created.profileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(profiles.list()).toEqual([created]);
    expect(profiles.open(profile.id)).toEqual(created);
  });

  it("renames and recalibrates by appending revisions while old revisions remain immutable", () => {
    const profiles = repository();
    const v1 = profiles.create(profile);
    const v2 = profiles.rename(profile.id, 1, "Laser A4 recalibrada");
    expect(v2.version).toBe(2);
    expect(v2.name).toBe("Laser A4 recalibrada");
    expect(profiles.open(profile.id, 1)).toEqual(v1);
    const v3 = profiles.update(profile.id, 2, { ...v2, back: { ...v2.back, offsetXUm: -700 } });
    expect(v3.version).toBe(3);
    expect(profiles.open(profile.id, 2)).toEqual(v2);
    expect(profiles.open(profile.id)).toEqual(v3);
    expect(database?.prepare("SELECT version FROM printer_profile_versions WHERE profile_id = ? ORDER BY version").all(profile.id))
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });

  it("duplicates into a new identity and supports hash-checked JSON import/export", () => {
    const profiles = repository();
    const original = profiles.create(profile);
    const duplicate = profiles.duplicate(original.id);
    expect(duplicate.id).toBe("generated-id");
    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.version).toBe(1);
    expect(duplicate.profileHash).not.toBe(original.profileHash);
    const json = profiles.export(original.id);
    database?.close();
    database = openProjectDatabase(":memory:");
    const imported = new PrinterProfileRepository(database, { idFactory: () => "generated-import-id", now: () => "2026-10-01T12:00:00.000Z" }).import(json);
    expect(imported).toEqual(original);
    expect(new PrinterProfileRepository(database, { now: () => "2026-10-01T12:00:00.000Z" }).export(original.id, 1)).toBe(json);
  });

  it("records explicit physical residual measurements in a new immutable revision", () => {
    const profiles = repository();
    const v1 = profiles.create(profile);
    const v2 = profiles.recordPhysicalVerification(v1.id, v1.version, "session-verified-1", [
      { pointId: "center", residualXUm: -120, residualYUm: 240 },
      { pointId: "top-left", residualXUm: 50, residualYUm: -50 },
    ]);
    expect(v2.version).toBe(2);
    expect(v2.physicalValidationStatus).toBe("physically-verified");
    expect(v2.physicalVerification).toMatchObject({
      sessionId: "session-verified-1",
      measurements: [
        { pointId: "center", residualXUm: -120, residualYUm: 240 },
        { pointId: "top-left", residualXUm: 50, residualYUm: -50 },
      ],
      residualSummaryMm: { mean: expect.any(Number), minimum: expect.any(Number), maximum: expect.any(Number) },
    });
    expect(v2.physicalVerification?.residualSummaryMm.minimum).toBeCloseTo(Math.sqrt(0.005), 12);
    expect(v2.physicalVerification?.residualSummaryMm.maximum).toBeCloseTo(Math.sqrt(0.072), 12);
    expect(profiles.open(v1.id, 1)).toEqual(v1);
    const duplicate = profiles.duplicate(v2.id);
    expect(duplicate).toMatchObject({ physicalValidationStatus: "software-only", physicalVerification: null });
    const recalibrated = profiles.update(v1.id, 2, { ...v2, back: { ...v2.back, offsetYUm: 248 } });
    expect(recalibrated).toMatchObject({ version: 3, physicalValidationStatus: "software-only", physicalVerification: null });
    expect(profiles.open(v1.id, 2)).toEqual(v2);
    expect(() => profiles.recordPhysicalVerification(v1.id, 2, "stale", [{ pointId: "center", residualXUm: 0, residualYUm: 0 }]))
      .toThrow(/revision conflict/i);
  });

  it("does not let create bypass the physical verification operation", () => {
    const profiles = repository();
    const forged = {
      ...profile,
      physicalValidationStatus: "physically-verified" as const,
      physicalVerification: {
        sessionId: "unverified-session",
        verifiedAt: "2026-10-01T12:00:00.000Z",
        measurements: [{ pointId: "center" as const, residualXUm: 0, residualYUm: 0 }],
        residualSummaryMm: { mean: 0, minimum: 0, maximum: 0 },
      },
    };

    expect(() => profiles.create(forged)).toThrow(/verification operation/i);
  });

  it("does not let an update add physical evidence while changing or preserving parameters", () => {
    const profiles = repository();
    const created = profiles.create(profile);
    const forged = {
      ...created,
      physicalValidationStatus: "physically-verified" as const,
      physicalVerification: {
        sessionId: "unverified-session",
        verifiedAt: "2026-10-01T12:00:00.000Z",
        measurements: [{ pointId: "center" as const, residualXUm: 0, residualYUm: 0 }],
        residualSummaryMm: { mean: 0, minimum: 0, maximum: 0 },
      },
    };

    expect(() => profiles.update(created.id, 1, forged)).toThrow(/verification operation/i);
    expect(() => profiles.update(created.id, 1, { ...forged, back: { ...forged.back, offsetXUm: 1 } }))
      .toThrow(/verification operation/i);
  });

  it("requires explicit acceptance before importing a physically verified profile", () => {
    const source = repository();
    const v1 = source.create(profile);
    const verified = source.recordPhysicalVerification(v1.id, 1, "import-session", [
      { pointId: "center", residualXUm: -120, residualYUm: 240 },
    ]);
    const json = source.export(verified.id, verified.version);

    database?.close();
    database = openProjectDatabase(":memory:");
    const target = new PrinterProfileRepository(database, { now: () => "2026-10-01T12:00:00.000Z" });
    expect(() => target.import(json)).toThrow(/explicit user acceptance/i);
    expect(target.import(json, { acceptPhysicalVerification: true })).toEqual(verified);
  });

  it("rejects corrupt import, missing historical version, duplicate identity, and CAS conflicts", () => {
    const profiles = repository();
    const created = profiles.create(profile);
    expect(() => profiles.open(profile.id, 9)).toThrow(/revision|version/i);
    expect(() => profiles.create(profile)).toThrow(/already exists/i);
    expect(() => profiles.update(profile.id, 8, { ...created, name: "lost update" })).toThrow(/revision conflict/i);
    expect(() => profiles.import(JSON.stringify({ schemaVersion: 1, profile: { ...created, name: "Tampered" } }))).toThrow(/hash/i);
  });

  it("keeps every prior version row immutable at the database boundary", () => {
    const profiles = repository();
    profiles.create(profile);
    expect(() => database?.prepare("UPDATE printer_profile_versions SET profile_json = '{}' WHERE profile_id = ? AND version = 1").run(profile.id))
      .toThrow(/immutable/i);
    expect(() => database?.prepare("DELETE FROM printer_profile_versions WHERE profile_id = ? AND version = 1").run(profile.id))
      .toThrow(/immutable/i);
  });
});
