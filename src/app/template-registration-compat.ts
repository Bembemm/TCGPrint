import { createDefaultRegistrationConfig, type RegistrationConfig } from "../../core/registration";
import type { CardFormat, PaperFormat, TemplateLayoutGeometryMm } from "../../core/geometry";
import type { TemplateVersionRecord } from "../../persistence/templates/repository";
import type { TemplateSelection } from "../../templates/types";
import { templatePhysicalFormats } from "../../templates/physical-formats";
import type { TemplateSelectionInspection } from "../../services/template-library";

export type TemplateRegistrationDefaults =
  | {
    readonly physicalFormatUnconfigured: true;
    readonly registration?: RegistrationConfig;
    readonly registrationUnconfigured?: true;
  }
  | {
    readonly physicalFormatUnconfigured?: false;
    readonly pageOrientation: "portrait" | "landscape";
    readonly cardOrientation: "portrait" | "landscape";
    readonly paperFormat: PaperFormat;
    readonly cardFormat: CardFormat;
    readonly registration?: RegistrationConfig;
    readonly registrationUnconfigured?: true;
    readonly templateGeometry?: TemplateLayoutGeometryMm;
  };

export type TemplateRegistrationStatus =
  | "unselected"
  | "checking"
  | "configured"
  | "legacy-custom-unconfigured"
  | "legacy-physical-format-unconfigured"
  | "unavailable";

export function registrationDefaultsForTemplate(version: TemplateVersionRecord): TemplateRegistrationDefaults {
  const registration = version.registrationConfig
    ?? (version.registrationType === "custom"
      ? undefined
      : createDefaultRegistrationConfig(version.registrationType, "portrait"));
  const registrationDefaults = registration ? { registration } : { registrationUnconfigured: true as const };
  if (!version.templateGeometry && (version.paper === "custom" || version.cardFormat === "custom")) {
    return { physicalFormatUnconfigured: true, ...registrationDefaults };
  }
  const formats = templatePhysicalFormats(version);
  return {
    pageOrientation: version.orientation,
    cardOrientation: version.templateGeometry?.cardOrientation ?? "portrait",
    paperFormat: formats.paper,
    cardFormat: formats.card,
    ...registrationDefaults,
    ...(version.templateGeometry === undefined ? {} : { templateGeometry: version.templateGeometry }),
  };
}

export function templateRegistrationLabel(version: TemplateVersionRecord): string {
  if (!version.templateGeometry && (version.paper === "custom" || version.cardFormat === "custom")) {
    return `${version.registrationType} · legado, dimensões físicas não configuradas`;
  }
  return version.registrationType === "custom" && version.registrationConfig === undefined
    ? "custom · legado, geometria física não configurada"
    : version.registrationType;
}

function sameSelection(left: TemplateSelection, right: TemplateSelection): boolean {
  return left.templateId === right.templateId && left.version === right.version && left.packageHash === right.packageHash;
}

export function resolveTemplateRegistrationStatus(
  selection: TemplateSelection | null,
  inspection: TemplateSelectionInspection | null,
): TemplateRegistrationStatus {
  if (selection === null) return "unselected";
  if (inspection === null || !sameSelection(selection, inspection.selection)) return "checking";
  const version = inspection.version;
  if (!version || version.templateId !== selection.templateId || version.version !== selection.version
    || version.packageHash !== selection.packageHash || inspection.status === "hash-mismatch") {
    return "unavailable";
  }
  if (!version.templateGeometry && (version.paper === "custom" || version.cardFormat === "custom")) {
    return "legacy-physical-format-unconfigured";
  }
  if (version.registrationType === "custom" && version.registrationConfig === undefined) {
    return "legacy-custom-unconfigured";
  }
  return "configured";
}

export function templateRegistrationRequiresUserChoice(status: TemplateRegistrationStatus): boolean {
  return status === "checking" || status === "legacy-custom-unconfigured"
    || status === "legacy-physical-format-unconfigured" || status === "unavailable";
}

export function applyProjectRegistrationOverride(
  status: TemplateRegistrationStatus,
  registrationOverride: boolean,
): TemplateRegistrationStatus {
  return registrationOverride && status === "legacy-custom-unconfigured" ? "configured" : status;
}
