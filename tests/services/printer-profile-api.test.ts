import { afterEach, describe, expect, it } from "vitest";
import { openProjectDatabase } from "../../persistence/projects/database";
import { PrinterProfileRepository } from "../../persistence/printer-profiles/repository";
import {
  handleCalibrationSheet,
  handlePrinterProfileCollection,
  handlePrinterProfileDetail,
  handlePrinterProfileDuplicate,
  handlePrinterProfileExport,
  handlePrinterProfileImport,
  handlePrinterProfileVerification,
  handleVerificationSheet,
} from "../../services/printer-profile-api";

const profile = {
  id: "laser-a4",
  name: "Laser A4",
  front: { offsetXUm: 0, offsetYUm: 0, rotationDeg: 0, scaleX: 1, scaleY: 1 },
  back: { offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1.00012, scaleY: 0.99987 },
  paperSize: "A4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  pageOrientation: "portrait" as const,
  duplexMode: "manual-long-edge" as const,
  physicalValidationStatus: "software-only" as const,
};

describe("printer profile and calibration sheet API", () => {
  let database: ReturnType<typeof openProjectDatabase> | undefined;
  afterEach(() => { database?.close(); database = undefined; });

  function setup() {
    database = openProjectDatabase(":memory:");
    const repository = new PrinterProfileRepository(database, { idFactory: () => "duplicate-id", now: () => "2026-10-01T12:00:00.000Z" });
    return { repository, request: (method: string, body?: unknown) => new Request("http://localhost/api/printer-profiles", {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }) };
  }

  it("supports create, list, open, rename, duplicate, export, and import", async () => {
    const { repository, request } = setup();
    const createdResponse = await handlePrinterProfileCollection(request("POST", { profile }), repository);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { profile: { id: string; version: number; profileHash: string } };
    expect(created.profile).toMatchObject({ id: "laser-a4", version: 1 });
    const listResponse = await handlePrinterProfileCollection(request("GET"), repository);
    expect(await listResponse.json()).toMatchObject({ profiles: [created.profile] });
    expect((await handlePrinterProfileDetail(request("GET"), "laser-a4", repository)).status).toBe(200);
    const renamed = await handlePrinterProfileDetail(request("PATCH", { expectedVersion: 1, profile: { ...profile, name: "Laser renamed" } }), "laser-a4", repository);
    expect(await renamed.json()).toMatchObject({ profile: { version: 2, name: "Laser renamed" } });
    const duplicate = await handlePrinterProfileDuplicate(request("POST", { version: 1 }), "laser-a4", repository);
    expect(await duplicate.json()).toMatchObject({ profile: { id: "duplicate-id", version: 1 } });
    const exported = await handlePrinterProfileExport(request("GET"), "laser-a4", repository);
    expect(exported.headers.get("content-type")).toContain("application/json");
    const exportedJson = await exported.text();
    expect(exportedJson).toContain('"schemaVersion": 1');
    database?.close();
    database = openProjectDatabase(":memory:");
    const freshRepository = new PrinterProfileRepository(database, { now: () => "2026-10-01T12:00:00.000Z" });
    const imported = await handlePrinterProfileImport(new Request("http://localhost/api/printer-profiles/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: exportedJson,
    }), freshRepository);
    expect(imported.status).toBe(201);
  });

  it("rejects a client-created physically verified profile and requires confirmation for verified imports", async () => {
    const { repository, request } = setup();
    const v1 = repository.create(profile);
    const verified = repository.recordPhysicalVerification(v1.id, v1.version, "import-session", [
      { pointId: "center", residualXUm: -120, residualYUm: 240 },
    ]);
    const exported = repository.export(verified.id, verified.version);
    const forgedProfile = {
      ...profile,
      physicalValidationStatus: "physically-verified" as const,
      physicalVerification: verified.physicalVerification,
    };

    const create = await handlePrinterProfileCollection(request("POST", { profile: forgedProfile }), repository);
    expect(create.status).toBe(400);
    expect(await create.json()).toMatchObject({ code: "INVALID_CALIBRATION" });

    database?.close();
    database = openProjectDatabase(":memory:");
    const target = new PrinterProfileRepository(database, { now: () => "2026-10-01T12:00:00.000Z" });
    const unconfirmed = await handlePrinterProfileImport(new Request("http://localhost/api/printer-profiles/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: exported,
    }), target);
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({ code: "INVALID_CALIBRATION" });

    const confirmed = await handlePrinterProfileImport(new Request("http://localhost/api/printer-profiles/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TCGPrint-Accept-Physical-Verification": "true" },
      body: exported,
    }), target);
    expect(confirmed.status).toBe(201);
    expect(await confirmed.json()).toMatchObject({ profile: verified });
  });

  it("returns explicit conflict and strict JSON import errors", async () => {
    const { repository, request } = setup();
    repository.create(profile);
    repository.rename("laser-a4", 1, "first tab");
    const stale = await handlePrinterProfileDetail(request("PATCH", { expectedVersion: 1, profile: { ...profile, name: "other tab" } }), "laser-a4", repository);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "PROFILE_REVISION_CONFLICT" });
    const future = await handlePrinterProfileImport(new Request("http://localhost/api/printer-profiles/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: 99, profile }),
    }), repository);
    expect(future.status).toBe(400);
    expect(await future.json()).toMatchObject({ code: "PROFILE_IMPORT_INVALID" });
    const tooLarge = await handlePrinterProfileImport(new Request("http://localhost/api/printer-profiles/import", {
      method: "POST", body: " ".repeat(64 * 1024 + 1),
    }), repository);
    expect(tooLarge.status).toBe(413);
  });

  it("records only supplied physical residuals and returns an immutable verified revision", async () => {
    const { repository, request } = setup();
    repository.create(profile);
    const response = await handlePrinterProfileVerification(request("POST", {
      expectedVersion: 1,
      sessionId: "verify-session-1",
      attestPhysicalMeasurements: true,
      measurements: [{ pointId: "center", residualXUm: -120, residualYUm: 247 }],
    }), "laser-a4", repository);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile: {
        version: 2,
        physicalValidationStatus: "physically-verified",
        physicalVerification: {
          sessionId: "verify-session-1",
          measurements: [{ pointId: "center", residualXUm: -120, residualYUm: 247 }],
          residualSummaryMm: { mean: expect.any(Number), minimum: expect.any(Number), maximum: expect.any(Number) },
        },
      },
    });
    const stale = await handlePrinterProfileVerification(request("POST", {
      expectedVersion: 1, sessionId: "verify-session-2", attestPhysicalMeasurements: true, measurements: [{ pointId: "center", residualXUm: 0, residualYUm: 0 }],
    }), "laser-a4", repository);
    expect(stale.status).toBe(409);

    const missingAttestation = await handlePrinterProfileVerification(request("POST", {
      expectedVersion: 2,
      sessionId: "verify-session-3",
      measurements: [{ pointId: "center", residualXUm: -120, residualYUm: 247 }],
    }), "laser-a4", repository);
    expect(missingAttestation.status).toBe(400);
    expect(await missingAttestation.json()).toMatchObject({ code: "PROFILE_IMPORT_INVALID" });
  });

  it("generates vector sheet and solved verification responses with bounded manifests", async () => {
    const { repository, request } = setup();
    const input = {
      sessionId: "session-123", draftProfileId: "draft-a4",
      paperFormat: { name: "A4", widthMm: 210, heightMm: 297 },
      pageOrientation: "portrait", duplexMode: "manual-long-edge", side: "back",
    };
    const sheet = await handleCalibrationSheet(request("POST", input));
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("content-type")).toBe("application/pdf");
    expect(sheet.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(Buffer.from(sheet.headers.get("x-tcgprint-calibration-manifest")!, "base64url").toString("utf8")))
      .toMatchObject({ kind: "calibration", side: "back", sessionId: "session-123" });
    const verification = await handleVerificationSheet(request("POST", {
      ...input,
      calibration: { offsetXUm: -683, offsetYUm: 247, rotationDeg: 0.031, scaleX: 1, scaleY: 1 },
    }));
    expect(verification.status).toBe(200);
    expect(JSON.parse(Buffer.from(verification.headers.get("x-tcgprint-calibration-manifest")!, "base64url").toString("utf8")))
      .toMatchObject({ kind: "verification", calibration: { offsetXUm: -683, offsetYUm: 247 } });
    const arbitrary = await handleVerificationSheet(request("POST", { ...input, matrix: [1, 0, 0, 1, 0, 0] }));
    expect(arbitrary.status).toBe(400);
    expect(await arbitrary.json()).toMatchObject({ code: "INVALID_CALIBRATION" });
    expect(repository.list()).toEqual([]);
  });
});
