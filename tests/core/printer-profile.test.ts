import { describe, expect, it } from "vitest";
import {
  CalibrationError,
  checkPrinterProfileCompatibility,
  parsePrinterProfile,
  parsePrinterProfileImport,
  serializePrinterProfileExport,
} from "../../core/calibration";
import { computePrinterProfileHash, parsePrinterProfileImportJson } from "../../persistence/printer-profiles/hash";

const validProfile = {
  id: "profile-a4-long-edge",
  name: "Laser A4 frente/verso",
  front: { offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 },
  back: { offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1.00012, scaleY: 0.99987 },
  paperSize: "A4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  pageOrientation: "portrait" as const,
  duplexMode: "manual-long-edge" as const,
  mediaType: "Matte 300 gsm",
  printQualityProfile: "High quality",
  feedSource: "Manual tray",
  notes: "Measured at 100% size.",
  physicalValidationStatus: "software-only" as const,
  physicalVerification: null,
};

describe("immutable printer profile model", () => {
  it("strictly parses bounded profile metadata and calibration values", () => {
    expect(parsePrinterProfile(validProfile)).toEqual(validProfile);
    expect(() => parsePrinterProfile({ ...validProfile, unknown: true })).toThrow(CalibrationError);
    expect(() => parsePrinterProfile({ ...validProfile, name: "  " })).toThrow(CalibrationError);
    expect(() => parsePrinterProfile({ ...validProfile, notes: "x".repeat(2_001) })).toThrow(CalibrationError);
    expect(() => parsePrinterProfile({ ...validProfile, paperWidthMm: Number.NaN })).toThrow(CalibrationError);
    expect(() => parsePrinterProfile({ ...validProfile, id: "../printer.json" })).toThrow(CalibrationError);
  });

  it("hashes immutable revisions deterministically and includes version", () => {
    const hashV1 = computePrinterProfileHash(validProfile, 1);
    expect(hashV1).toMatch(/^[a-f0-9]{64}$/);
    expect(computePrinterProfileHash(validProfile, 1)).toBe(hashV1);
    expect(computePrinterProfileHash(validProfile, 2)).not.toBe(hashV1);
    const snapshot = { ...validProfile, version: 1, profileHash: hashV1 };
    expect(parsePrinterProfileImport({ schemaVersion: 1, profile: snapshot })).toMatchObject(snapshot);
  });

  it("exports an immutable revision without paths, artwork, or host-specific fields", () => {
    const profile = { ...validProfile, version: 1, profileHash: computePrinterProfileHash(validProfile, 1) };
    const json = serializePrinterProfileExport(profile);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toEqual({ schemaVersion: 1, profile });
    expect(json).not.toMatch(/path|artwork|host|secret/i);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(64 * 1024);
  });

  it("rejects future schemas, malformed hashes, extra import properties, and imports over 64 KiB", () => {
    const valid = { ...validProfile, version: 1, profileHash: computePrinterProfileHash(validProfile, 1) };
    expect(() => parsePrinterProfileImport({ schemaVersion: 2, profile: valid })).toThrow(CalibrationError);
    expect(() => parsePrinterProfileImport({ schemaVersion: 1, profile: { ...valid, profileHash: "bad" } })).toThrow(CalibrationError);
    expect(() => parsePrinterProfileImport({ schemaVersion: 1, profile: { ...valid, localPath: "/tmp/private" } })).toThrow(CalibrationError);
    expect(() => parsePrinterProfileImportJson(" ".repeat(64 * 1024 + 1))).toThrow(CalibrationError);
    const tampered = { schemaVersion: 1, profile: { ...valid, name: "Tampered" } };
    expect(() => parsePrinterProfileImportJson(JSON.stringify(tampered))).toThrow(CalibrationError);
  });

  it("reports exact compatibility reasons and permits front-only duplex-mode variation", () => {
    const profile = { ...validProfile, version: 1, profileHash: computePrinterProfileHash(validProfile, 1) };
    const compatible = checkPrinterProfileCompatibility(profile, {
      paperSize: "A4", paperWidthMm: 210, paperHeightMm: 297, pageOrientation: "portrait",
      duplexMode: "manual-long-edge", exportSides: ["front", "back"],
    });
    expect(compatible).toEqual({ compatible: true, reasons: [] });
    expect(checkPrinterProfileCompatibility(profile, {
      paperSize: "Letter", paperWidthMm: 215.9, paperHeightMm: 279.4, pageOrientation: "portrait",
      duplexMode: "manual-long-edge", exportSides: ["front"],
    }).reasons).toContain("paper-size-mismatch");
    expect(checkPrinterProfileCompatibility(profile, {
      paperSize: "A4", paperWidthMm: 210, paperHeightMm: 297, pageOrientation: "landscape",
      duplexMode: "automatic-short-edge", exportSides: ["front", "back"],
      duplexFlipMode: "short-edge",
    }).reasons).toEqual(expect.arrayContaining(["orientation-mismatch", "duplex-mode-mismatch", "duplex-edge-mismatch"]));
    expect(checkPrinterProfileCompatibility(profile, {
      paperSize: "A4", paperWidthMm: 210, paperHeightMm: 297, pageOrientation: "portrait",
      duplexMode: "automatic-short-edge", exportSides: ["front"],
    })).toEqual({ compatible: true, reasons: [] });
    const single = { ...profile, duplexMode: "single-sided" as const };
    expect(checkPrinterProfileCompatibility(single, {
      paperSize: "A4", paperWidthMm: 210, paperHeightMm: 297, pageOrientation: "portrait",
      duplexMode: "single-sided", exportSides: ["front", "back"],
    }).reasons).toContain("single-sided-profile-has-back");
  });
});
