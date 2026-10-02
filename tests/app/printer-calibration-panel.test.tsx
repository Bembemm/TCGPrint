import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PrinterCalibrationPanel from "../../src/app/printer-calibration-panel";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";

describe("printer calibration Project panel", () => {
  it("shows explicit nominal state, physical-axis convention, precision nudges, and wizard actions", () => {
    const markup = renderToStaticMarkup(createElement(PrinterCalibrationPanel, {
      paperFormat: DEFAULT_PROJECT_SETTINGS.paperFormat,
      pageOrientation: "portrait",
      printerProfileSelection: null,
      printerDuplexMode: "single-sided",
      exportContentMode: "front-only",
      duplexFlipMode: "long-edge",
      disabled: false,
      onProjectSelectionChange: vi.fn(),
    }));

    expect(markup).toContain("Sem calibração");
    expect(markup).toContain("+X → direita");
    expect(markup).toContain("+Y → cima");
    expect(markup).toContain("Micro ±0.001 mm");
    expect(markup).toContain("Fine ±0.010 mm");
    expect(markup).toContain("Normal ±0.100 mm");
    expect(markup).toContain("Coarse ±1.000 mm");
    expect(markup).toContain("0.001°");
    expect(markup).toContain("Nominal");
    expect(markup).toContain("Calibrated");
    expect(markup).toContain("Criar profile");
    expect(markup).toContain("Modo da impressora");
  });

  it.each(["automatic-long-edge", "automatic-short-edge"] as const)("explains that %s prints one two-page automatic duplex job", (printerDuplexMode) => {
    const markup = renderToStaticMarkup(createElement(PrinterCalibrationPanel, {
      paperFormat: DEFAULT_PROJECT_SETTINGS.paperFormat,
      pageOrientation: "portrait",
      printerProfileSelection: null,
      printerDuplexMode,
      exportContentMode: "front-back-separated",
      duplexFlipMode: printerDuplexMode.endsWith("long-edge") ? "long-edge" : "short-edge",
      disabled: false,
      onProjectSelectionChange: vi.fn(),
    }));

    expect(markup).toContain("Imprima este PDF de 2 páginas usando duplex automático e o binding selecionado.");
    expect(markup).toContain("Não faça reinserção manual.");
    expect(markup).toContain("Calibration PDF duplex (2 páginas)");
    expect(markup).toContain("Verification PDF duplex (2 páginas)");
  });
});
