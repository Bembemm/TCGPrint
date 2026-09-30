export type TemplatePaper = "a4" | "a3" | "letter" | "legal" | "tabloid" | "custom";
export type TemplateCardFormat = "standard" | "poker" | "bridge" | "tarot" | "custom";
export type TemplateOrientation = "portrait" | "landscape";
export type TemplateRegistrationType = "three-point" | "four-point" | "custom" | "none";
export type TemplateFileExtension = "studio3" | "dxf" | "svg" | "json" | "zip";
import type { RegistrationConfig } from "../core/registration";
import type { TemplateLayoutGeometryMm } from "../core/geometry";

export interface TemplateMetadata {
  readonly name: string;
  readonly source: string;
  readonly version: string;
  readonly paper: TemplatePaper;
  readonly cardFormat: TemplateCardFormat;
  readonly orientation: TemplateOrientation;
  readonly recommendedBleedMm?: number;
  readonly registrationType: TemplateRegistrationType;
  /** Optional immutable per-version geometry; absent means use the explicit generic type preset. */
  readonly registrationConfig?: RegistrationConfig;
  /** Optional explicit slot coordinates; never inferred from opaque .studio3 bytes. */
  readonly templateGeometry?: TemplateLayoutGeometryMm;
}

export interface TemplateSelection {
  readonly templateId: string;
  readonly version: string;
  readonly packageHash: string;
}

export interface TemplateFileInput {
  readonly relativePath: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface ValidatedTemplateFile {
  readonly fileName: string;
  readonly extension: TemplateFileExtension;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface TemplatePackageHashFile {
  readonly relativePath: string;
  readonly contentHash: string;
  readonly byteLength: number;
}
