import { CalibrationError } from "../core/calibration";
import type { PrinterProfile } from "../core/calibration";
import { PrinterProfileRepository } from "../persistence/printer-profiles/repository";
import { generateCalibrationSheet, generateVerificationSheet, type CalibrationSheetRequest, type VerificationSheetRequest } from "./calibration-sheet";

const MAX_PROFILE_BODY_BYTES = 64 * 1024;
const MAX_SHEET_BODY_BYTES = 8 * 1024;

function errorResponse(error: unknown): Response {
  if (error instanceof CalibrationError) {
    const status = error.code === "PROFILE_NOT_FOUND" ? 404
      : error.code === "PROFILE_VERSION_MISMATCH" || error.code === "PROFILE_REVISION_CONFLICT" || error.code === "PROFILE_INCOMPATIBLE" ? 409
        : error.code === "PROFILE_ID_EXISTS" ? 409
          : error.code === "PROFILE_IMPORT_TOO_LARGE" ? 413 : 400;
    return Response.json({ code: error.code, message: error.message }, { status, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ code: "INTERNAL_ERROR", message: "Printer profile request failed." }, { status: 500, headers: { "Cache-Control": "no-store" } });
}

async function requestText(request: Request, maximum: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new CalibrationError("PROFILE_IMPORT_TOO_LARGE", `Request exceeds ${maximum} bytes.`);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maximum) throw new CalibrationError("PROFILE_IMPORT_TOO_LARGE", `Request exceeds ${maximum} bytes.`);
  return text;
}

async function requestJson(request: Request, maximum: number): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(await requestText(request, maximum)); }
  catch (error) {
    if (error instanceof CalibrationError) throw error;
    throw new CalibrationError("PROFILE_IMPORT_INVALID", "Request body must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CalibrationError("PROFILE_IMPORT_INVALID", "Request body must be a plain JSON object.");
  }
  return value as Record<string, unknown>;
}

function profileIdentifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new CalibrationError("PROFILE_NOT_FOUND", "Printer profile ID is invalid.");
  return value;
}

function parseVersion(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[1-9]\d{0,14}$/.test(value)) throw new CalibrationError("PROFILE_VERSION_MISMATCH", "Profile version query parameter must be a positive integer.");
  return Number(value);
}

function pdfResponse(artifact: Awaited<ReturnType<typeof generateCalibrationSheet>>): Response {
  const manifest = Buffer.from(JSON.stringify(artifact.manifest), "utf8").toString("base64url");
  return new Response(Uint8Array.from(artifact.pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="tcgprint-${artifact.manifest.kind}-${artifact.manifest.side}.pdf"`,
      "Cache-Control": "no-store",
      "X-TCGPrint-Calibration-Manifest": manifest,
    },
  });
}

export async function handlePrinterProfileCollection(request: Request, repository: PrinterProfileRepository): Promise<Response> {
  try {
    if (request.method === "GET") return Response.json({ profiles: repository.list() }, { headers: { "Cache-Control": "no-store" } });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
    const body = await requestJson(request, MAX_PROFILE_BODY_BYTES);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "profile")) throw new CalibrationError("PROFILE_IMPORT_INVALID", "Create request must contain only the profile object.");
    const profile = repository.create(body.profile as PrinterProfile);
    return Response.json({ profile }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function handlePrinterProfileDetail(request: Request, id: string, repository: PrinterProfileRepository): Promise<Response> {
  try {
    const profileId = profileIdentifier(id);
    if (request.method === "GET") {
      const version = parseVersion(new URL(request.url).searchParams.get("version"));
      return Response.json({ profile: repository.open(profileId, version) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method !== "PATCH") return new Response(null, { status: 405, headers: { Allow: "GET, PATCH" } });
    const body = await requestJson(request, MAX_PROFILE_BODY_BYTES);
    if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "expectedVersion") || !Object.hasOwn(body, "profile")
      || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
      throw new CalibrationError("PROFILE_IMPORT_INVALID", "Update request requires a positive expectedVersion and full profile values.");
    }
    const profile = repository.update(profileId, body.expectedVersion as number, body.profile as PrinterProfile);
    return Response.json({ profile }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function handlePrinterProfileVerification(request: Request, id: string, repository: PrinterProfileRepository): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const profileId = profileIdentifier(id);
    const body = await requestJson(request, MAX_PROFILE_BODY_BYTES);
    if (Object.keys(body).length !== 4 || !Object.hasOwn(body, "expectedVersion") || !Object.hasOwn(body, "sessionId")
      || !Object.hasOwn(body, "measurements") || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1
      || typeof body.sessionId !== "string" || !Array.isArray(body.measurements) || body.attestPhysicalMeasurements !== true) {
      throw new CalibrationError("PROFILE_IMPORT_INVALID", "Physical verification requires expectedVersion, a fixture session ID, measured residuals, and explicit user attestation.");
    }
    const profile = repository.recordPhysicalVerification(profileId, body.expectedVersion as number, body.sessionId, body.measurements);
    return Response.json({ profile }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function handlePrinterProfileDuplicate(request: Request, id: string, repository: PrinterProfileRepository): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const profileId = profileIdentifier(id);
    const body = await requestJson(request, 1_024);
    if (Object.keys(body).some((key) => key !== "version")) throw new CalibrationError("PROFILE_IMPORT_INVALID", "Duplicate request contains unsupported fields.");
    const version = body.version;
    if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) throw new CalibrationError("PROFILE_VERSION_MISMATCH", "Duplicate source revision is invalid.");
    const profile = repository.duplicate(profileId, version as number | undefined);
    return Response.json({ profile }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function handlePrinterProfileExport(request: Request, id: string, repository: PrinterProfileRepository): Promise<Response> {
  try {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const profileId = profileIdentifier(id);
    const version = parseVersion(new URL(request.url).searchParams.get("version"));
    const json = repository.export(profileId, version);
    return new Response(json, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="printer-profile-${profileId}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) { return errorResponse(error); }
}

export async function handlePrinterProfileImport(request: Request, repository: PrinterProfileRepository): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const json = await requestText(request, MAX_PROFILE_BODY_BYTES);
    const profile = repository.import(json, {
      acceptPhysicalVerification: request.headers.get("x-tcgprint-accept-physical-verification") === "true",
    });
    return Response.json({ profile }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

async function sheetRequest(request: Request): Promise<Record<string, unknown>> {
  return requestJson(request, MAX_SHEET_BODY_BYTES);
}

export async function handleCalibrationSheet(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const body = await sheetRequest(request);
    return pdfResponse(await generateCalibrationSheet(body as unknown as CalibrationSheetRequest));
  } catch (error) { return errorResponse(error); }
}

export async function handleVerificationSheet(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const body = await sheetRequest(request);
    return pdfResponse(await generateVerificationSheet(body as unknown as VerificationSheetRequest));
  } catch (error) { return errorResponse(error); }
}
