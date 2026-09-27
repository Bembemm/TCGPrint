import type { BleedModePreference } from "../../image-engine/bleed";
import type { CutGuideConfig, GuideColor } from "../../core/geometry";

export interface BleedDiagnosticsReport {
  readonly version: 1;
  readonly mode: "full" | "summary";
  readonly diagnostics?: readonly {
    readonly workingCardId: string;
    readonly cardName: string;
    readonly source: string;
    readonly requestedMode: string;
    readonly resolvedMode: string;
    readonly effectiveMode: string;
    readonly algorithmVersion: string;
    readonly policyId: string;
    readonly bleedMm: number;
    readonly trimSizeMm: { readonly widthMm: number; readonly heightMm: number };
    readonly roundedCorners?: boolean;
    readonly cornerRadiusMm?: number;
    readonly previewSha256: string;
    readonly sideDiagnostics: Readonly<Record<string, { readonly strategy: string }>>;
  }[];
  readonly truncated?: boolean;
  readonly count?: number;
  readonly effectiveModeCounts?: Readonly<Record<string, number>>;
}

export function buildCutGuideConfig(
  trimEnabled: boolean,
  trimExtentValue: string,
  externalEnabled: boolean,
  externalStrokeWidthValue: string,
  trimColor: GuideColor = "blue",
  externalColor: GuideColor = "black",
): CutGuideConfig {
  return {
    trim: {
      enabled: trimEnabled,
      extentMm: trimExtentValue === "full" ? "full" : Number(trimExtentValue),
      color: trimColor,
    },
    external: {
      enabled: externalEnabled,
      strokeWidthPt: Number(externalStrokeWidthValue),
      color: externalColor,
    },
  };
}

export function buildBleedExportOptions(bleedMm: string, cutGuides: CutGuideConfig, roundedCorners = false) {
  return {
    bleedMm: Number(bleedMm),
    cutGuides,
    roundedCorners,
  };
}

export function decodeBleedDiagnostics(encoded: string | null): BleedDiagnosticsReport | null {
  if (!encoded) return null;
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const report = value as Partial<BleedDiagnosticsReport>;
    if (report.version !== 1) return null;
    if (report.mode === "full" && Array.isArray(report.diagnostics)) return report as BleedDiagnosticsReport;
    if (report.mode === "summary" && report.truncated === true && typeof report.count === "number") return report as BleedDiagnosticsReport;
    return null;
  } catch {
    return null;
  }
}
