import { describe, expect, it } from "vitest";
import type { TemplateVersionRecord } from "../../persistence/templates/repository";
import {
  applyProjectRegistrationOverride,
  registrationDefaultsForTemplate,
  resolveTemplateRegistrationStatus,
  templateRegistrationLabel,
  templateRegistrationRequiresUserChoice,
} from "../../src/app/template-registration-compat";

describe("legacy template registration compatibility", () => {
  const selection = { templateId: "legacy-template", version: "v9", packageHash: "9".repeat(64) };
  const legacyVersion: TemplateVersionRecord = {
    templateId: selection.templateId,
    name: "Legacy custom",
    source: "Phase 9 fixture",
    version: selection.version,
    paper: "a4",
    cardFormat: "standard",
    orientation: "portrait",
    registrationType: "custom",
    packageHash: selection.packageHash,
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
  };

  it("keeps legacy custom unconfigured instead of resolving it to none", () => {
    const defaults = registrationDefaultsForTemplate(legacyVersion);

    expect(defaults.registration).toBeUndefined();
    expect(defaults.registrationUnconfigured).toBe(true);
    expect(templateRegistrationLabel(legacyVersion)).toContain("geometria física não configurada");
    expect(templateRegistrationLabel(legacyVersion)).not.toContain("none");
    expect(resolveTemplateRegistrationStatus(selection, {
      selection,
      status: "available",
      version: legacyVersion,
      files: [],
    })).toBe("legacy-custom-unconfigured");
    expect(templateRegistrationRequiresUserChoice("legacy-custom-unconfigured")).toBe(true);
    expect(applyProjectRegistrationOverride("legacy-custom-unconfigured", true)).toBe("configured");
    expect(applyProjectRegistrationOverride("legacy-custom-unconfigured", false)).toBe("legacy-custom-unconfigured");
    expect(applyProjectRegistrationOverride("checking", true)).toBe("checking");
    expect(applyProjectRegistrationOverride("unavailable", true)).toBe("unavailable");
  });

  it("keeps legacy custom physical formats unconfigured without inventing dimensions", () => {
    const customPhysicalVersion: TemplateVersionRecord = {
      ...legacyVersion,
      paper: "custom",
      cardFormat: "custom",
    };

    const defaults = registrationDefaultsForTemplate(customPhysicalVersion);

    expect(defaults.physicalFormatUnconfigured).toBe(true);
    expect("paperFormat" in defaults).toBe(false);
    expect("cardFormat" in defaults).toBe(false);
    expect(templateRegistrationLabel(customPhysicalVersion)).toContain("dimensões físicas não configuradas");
    expect(resolveTemplateRegistrationStatus(selection, {
      selection,
      status: "available",
      version: customPhysicalVersion,
      files: [],
    })).toBe("legacy-physical-format-unconfigured");
    expect(templateRegistrationRequiresUserChoice("legacy-physical-format-unconfigured")).toBe(true);
    expect(applyProjectRegistrationOverride("legacy-physical-format-unconfigured", true))
      .toBe("legacy-physical-format-unconfigured");
  });

  it("requires an exact selected version before resolving template registration", () => {
    const otherVersion = { ...legacyVersion, version: "v10", packageHash: "a".repeat(64) };

    expect(resolveTemplateRegistrationStatus(selection, {
      selection,
      status: "hash-mismatch",
      version: otherVersion,
      files: [],
    })).toBe("unavailable");
    expect(templateRegistrationRequiresUserChoice("unavailable")).toBe(true);
    expect(templateRegistrationRequiresUserChoice("configured")).toBe(false);
  });
});
