import { describe, expect, it } from "vitest";
import { createCalibrationVerificationSheetKey, createIdentitySideCalibration } from "../../core/calibration";

const base = {
  sessionId: "session-a",
  profileId: "printer-a4",
  profileVersion: 2,
  profileHash: "a".repeat(64),
  side: "back" as const,
  calibration: createIdentitySideCalibration(),
  paperSize: "A4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  pageOrientation: "portrait" as const,
  duplexMode: "manual-long-edge" as const,
};

describe("verification sheet session binding", () => {
  it("produces a stable key for the same exact session, profile revision, side, and parameters", () => {
    expect(createCalibrationVerificationSheetKey(base)).toBe(createCalibrationVerificationSheetKey({ ...base }));
  });

  it.each([
    { sessionId: "session-b" },
    { profileId: "printer-other" },
    { profileVersion: 3 },
    { profileHash: "b".repeat(64) },
    { side: "front" as const },
    { calibration: { ...base.calibration, offsetYUm: 1 } },
    { paperSize: "Letter" },
    { paperWidthMm: 216 },
    { pageOrientation: "landscape" as const },
    { duplexMode: "manual-short-edge" as const },
  ])("changes the key when the verification context changes", (change) => {
    expect(createCalibrationVerificationSheetKey({ ...base, ...change })).not.toBe(createCalibrationVerificationSheetKey(base));
  });
});
