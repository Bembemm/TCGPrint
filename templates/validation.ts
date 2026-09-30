import { createHash } from "node:crypto";
import { parseSafeXml } from "../import-engine/importers/xml";
import { IMPORT_LIMITS } from "../import-engine/limits";
import { sanitizeRelativeImportPath } from "../import-engine/source-path";
import type {
  TemplateCardFormat,
  TemplateFileExtension,
  TemplateMetadata,
  TemplatePackageHashFile,
  TemplatePaper,
  TemplateOrientation,
  TemplateRegistrationType,
  ValidatedTemplateFile,
} from "./types";

export const MAX_TEMPLATE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TEMPLATE_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_TEMPLATE_JSON_BYTES = 8 * 1024 * 1024;

const METADATA_FIELDS = new Set([
  "name", "source", "version", "paper", "cardFormat", "orientation", "recommendedBleedMm", "registrationType",
]);
const EXTENSIONS = new Set<TemplateFileExtension>(["studio3", "dxf", "svg", "json", "zip"]);
const PAPERS = new Set<TemplatePaper>(["a4", "a3", "letter", "legal", "tabloid", "custom"]);
const CARD_FORMATS = new Set<TemplateCardFormat>(["standard", "poker", "bridge", "tarot", "custom"]);
const ORIENTATIONS = new Set<TemplateOrientation>(["portrait", "landscape"]);
const REGISTRATION_TYPES = new Set<TemplateRegistrationType>(["three-point", "four-point", "custom", "none"]);
const BINARY_DXF_SIGNATURE = new TextEncoder().encode("AutoCAD Binary DXF\r\n\u001a\0");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type TemplateValidationCode =
  | "TEMPLATE_METADATA_INVALID"
  | "TEMPLATE_FILE_NAME_INVALID"
  | "TEMPLATE_FILE_TYPE_UNSUPPORTED"
  | "TEMPLATE_FILE_TOO_LARGE"
  | "TEMPLATE_FILE_INVALID"
  | "TEMPLATE_PACKAGE_INVALID";

export class TemplateValidationError extends Error {
  constructor(readonly code: TemplateValidationCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TemplateValidationError";
  }
}

function invalidMetadata(message: string): never {
  throw new TemplateValidationError("TEMPLATE_METADATA_INVALID", message);
}

function cleanMetadataText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") invalidMetadata(`Template metadata ${field} must be text.`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    invalidMetadata(`Template metadata ${field} must be non-empty and at most ${maximum} characters.`);
  }
  return normalized;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: ReadonlySet<T>): T {
  if (typeof value !== "string") invalidMetadata(`Template metadata ${field} has an unsupported value.`);
  const normalized = value.trim().toLowerCase() as T;
  if (!allowed.has(normalized)) invalidMetadata(`Template metadata ${field} has an unsupported value.`);
  return normalized;
}

/** Strictly validates and normalizes the metadata stored with an immutable template version. */
export function parseTemplateMetadata(value: unknown): TemplateMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidMetadata("Template metadata must be an object.");
  const source = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string" || !METADATA_FIELDS.has(key)) invalidMetadata(`Template metadata contains unsupported field ${String(key)}.`);
  }
  const required = ["name", "source", "version", "paper", "cardFormat", "orientation", "registrationType"];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) invalidMetadata(`Template metadata is missing ${field}.`);
  }
  const bleed = source.recommendedBleedMm;
  if (bleed !== undefined && (typeof bleed !== "number" || !Number.isFinite(bleed) || bleed < 0 || bleed > 3)) {
    invalidMetadata("Template metadata recommendedBleedMm must be a finite number between 0 and 3.");
  }
  return {
    name: cleanMetadataText(source.name, "name", 160),
    source: cleanMetadataText(source.source, "source", 240),
    version: cleanMetadataText(source.version, "version", 80),
    paper: enumValue(source.paper, "paper", PAPERS),
    cardFormat: enumValue(source.cardFormat, "cardFormat", CARD_FORMATS),
    orientation: enumValue(source.orientation, "orientation", ORIENTATIONS),
    ...(bleed !== undefined ? { recommendedBleedMm: bleed } : {}),
    registrationType: enumValue(source.registrationType, "registrationType", REGISTRATION_TYPES),
  };
}

function safeTemplateFileName(value: string): string {
  if (typeof value !== "string" || !value || value.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(value)
    || value === "." || value === "..") {
    throw new TemplateValidationError("TEMPLATE_FILE_NAME_INVALID", "Template file name must be a safe basename of at most 255 characters.");
  }
  return value.normalize("NFC");
}

function mediaType(extension: TemplateFileExtension): string {
  switch (extension) {
    case "studio3": return "application/octet-stream";
    case "dxf": return "application/dxf";
    case "svg": return "image/svg+xml";
    case "json": return "application/json";
    case "zip": return "application/zip";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

function invalidFile(message: string, cause?: unknown): never {
  throw new TemplateValidationError("TEMPLATE_FILE_INVALID", message, cause);
}

function validateSvg(bytes: Uint8Array): void {
  try {
    const document = parseSafeXml(bytes, {
      maxXmlBytes: IMPORT_LIMITS.maxSvgBytes,
      maxXmlDepth: IMPORT_LIMITS.maxXmlDepth,
      maxXmlNodes: IMPORT_LIMITS.maxXmlNodes,
    });
    if (document.documentElement?.localName !== "svg") invalidFile("SVG template files must have an <svg> root element.");
  } catch (error) {
    if (error instanceof TemplateValidationError) throw error;
    invalidFile(`SVG template is not safe, valid UTF-8 XML. ${error instanceof Error ? error.message : "XML parser error."}`, error);
  }
}

function validateJson(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new TemplateValidationError("TEMPLATE_FILE_TOO_LARGE", `JSON template file exceeds ${MAX_TEMPLATE_JSON_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    invalidFile("JSON template file must be valid UTF-8 JSON.", error);
  }
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > IMPORT_LIMITS.maxJsonNodes) invalidFile(`JSON template file exceeds ${IMPORT_LIMITS.maxJsonNodes} nodes.`);
    if (current.depth > IMPORT_LIMITS.maxJsonDepth) invalidFile(`JSON template file exceeds depth ${IMPORT_LIMITS.maxJsonDepth}.`);
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") invalidFile("JSON template file contains a reserved property name.");
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength < right.byteLength) return false;
  for (let index = 0; index < right.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function validateDxf(bytes: Uint8Array): void {
  if (equalBytes(bytes, BINARY_DXF_SIGNATURE)) return;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch (error) {
    invalidFile("DXF template must be an ASCII/UTF-8 text DXF or a recognized binary DXF.", error);
  }
  const lines = (text as string).split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  if (lines.length < 4 || lines.length % 2 !== 0) invalidFile("DXF template does not contain complete group-code/value pairs.");
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < lines.length; index += 2) {
    const code = lines[index]?.trim() ?? "";
    const numericCode = Number(code);
    if (!/^-?\d{1,4}$/.test(code) || !Number.isInteger(numericCode) || numericCode < -5 || numericCode > 1071) {
      invalidFile(`DXF template has an invalid group code on line ${index + 1}.`);
    }
    pairs.push([code, lines[index + 1] ?? ""]);
  }
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  if (first?.[0] !== "0" || first[1].trim().toUpperCase() !== "SECTION"
    || last?.[0] !== "0" || last[1].trim().toUpperCase() !== "EOF"
    || !pairs.some(([code, value]) => code === "0" && value.trim().toUpperCase() === "ENDSEC")) {
    invalidFile("DXF template must contain a SECTION, ENDSEC, and final EOF marker.");
  }
}

function validateZip(bytes: Uint8Array): void {
  const signature = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08));
  if (!signature) invalidFile("ZIP template file does not have a valid ZIP signature.");
}

/** Validates the name, bounded content shape, and SHA-256 without transforming the supplied bytes. */
export function validateTemplateFile(
  fileName: string,
  bytes: Uint8Array,
  options: { readonly maxFileBytes?: number } = {},
): ValidatedTemplateFile {
  const safeName = safeTemplateFileName(fileName);
  const lastDot = safeName.lastIndexOf(".");
  const rawExtension = lastDot > 0 ? safeName.slice(lastDot + 1).toLowerCase() : "";
  if (!EXTENSIONS.has(rawExtension as TemplateFileExtension)) {
    throw new TemplateValidationError("TEMPLATE_FILE_TYPE_UNSUPPORTED", "Template files must use .studio3, .dxf, .svg, .json, or .zip.");
  }
  const extension = rawExtension as TemplateFileExtension;
  const maximum = options.maxFileBytes ?? MAX_TEMPLATE_FILE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError("Template file limit must be a positive safe integer.");
  if (bytes.byteLength === 0) invalidFile("Template file is empty.");
  if (bytes.byteLength > maximum) {
    throw new TemplateValidationError("TEMPLATE_FILE_TOO_LARGE", `Template file exceeds the ${maximum} byte limit.`);
  }
  if (extension === "svg") validateSvg(bytes);
  if (extension === "dxf") validateDxf(bytes);
  if (extension === "json") validateJson(bytes);
  if (extension === "zip") validateZip(bytes);
  // .studio3 is an official opaque format. Its content is never parsed or rewritten.
  return {
    fileName: safeName,
    extension,
    mediaType: mediaType(extension),
    byteLength: bytes.byteLength,
    contentHash: digest(bytes),
  };
}

function normalizeTemplatePath(value: string): string {
  if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TemplateValidationError("TEMPLATE_PACKAGE_INVALID", "Template package path must be a safe relative path of at most 1024 characters.");
  }
  let normalized: string | undefined;
  try { normalized = sanitizeRelativeImportPath(value.normalize("NFC")); }
  catch (error) { throw new TemplateValidationError("TEMPLATE_PACKAGE_INVALID", "Template package contains an unsafe relative path.", error); }
  if (!normalized) throw new TemplateValidationError("TEMPLATE_PACKAGE_INVALID", "Template package path cannot be empty.");
  return normalized;
}

/** Hashes normalized metadata and the sorted per-file hashes/paths, independent of upload order. */
export function calculateTemplatePackageHash(
  metadataInput: TemplateMetadata,
  files: readonly TemplatePackageHashFile[],
): string {
  const metadata = parseTemplateMetadata(metadataInput);
  const normalizedFiles = files.map((file) => {
    const relativePath = normalizeTemplatePath(file.relativePath);
    if (!SHA256_PATTERN.test(file.contentHash) || !Number.isSafeInteger(file.byteLength) || file.byteLength <= 0) {
      throw new TemplateValidationError("TEMPLATE_PACKAGE_INVALID", `Template package file ${relativePath} has invalid hash or size metadata.`);
    }
    return { relativePath, contentHash: file.contentHash, byteLength: file.byteLength };
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const uniquePaths = new Set(normalizedFiles.map(({ relativePath }) => relativePath.toLocaleLowerCase("en-US")));
  if (uniquePaths.size !== normalizedFiles.length) {
    throw new TemplateValidationError("TEMPLATE_PACKAGE_INVALID", "Template package contains duplicate file paths.");
  }
  const canonical = JSON.stringify({
    schema: 1,
    metadata,
    files: normalizedFiles,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
