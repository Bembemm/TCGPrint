// @vitest-environment jsdom
import { act } from "react";
import { cleanup, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentitySideCalibration, type PrinterProfileSnapshot } from "../../core/calibration";
import { DEFAULT_PROJECT_SETTINGS } from "../../persistence/projects/serializer";
import PrinterCalibrationPanel from "../../src/app/printer-calibration-panel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const profile: PrinterProfileSnapshot = {
  id: "printer-hydration-test",
  name: "Impressora de hydration",
  front: createIdentitySideCalibration(),
  back: createIdentitySideCalibration(),
  paperSize: "A4",
  paperWidthMm: 210,
  paperHeightMm: 297,
  pageOrientation: "portrait",
  duplexMode: "manual-long-edge",
  physicalValidationStatus: "software-only",
  version: 2,
  profileHash: "b".repeat(64),
};

const props = {
  paperFormat: DEFAULT_PROJECT_SETTINGS.paperFormat,
  pageOrientation: "portrait" as const,
  printerProfileSelection: profile,
  printerDuplexMode: "manual-long-edge" as const,
  exportContentMode: "duplex" as const,
  duplexFlipMode: "long-edge" as const,
  disabled: false,
  onProjectSelectionChange: vi.fn(),
};

describe("PrinterCalibrationPanel server hydration", () => {
  it("hydrates matching markup, then uses a unique session for sheets and invalidates verification on a new session", async () => {
    const uuids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => uuids.shift() ?? "44444444-4444-4444-8444-444444444444") });

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "/api/printer-profiles") return Response.json({ profiles: [profile] });
      return new Response("pdf", { status: 200, headers: { "Content-Type": "application/pdf" } });
    }));
    const previousCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const previousRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:calibration-test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const serverMarkup = renderToString(<PrinterCalibrationPanel {...props} />);
    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    const serverInitialSessionText = container.querySelector(".physical-verification-measurements p")?.textContent;
    const serverPdfButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((button) =>
      /Gerar (?:Calibration|Verification) PDF/.test(button.textContent ?? ""));
    expect(serverPdfButtons).toHaveLength(2);
    expect(serverPdfButtons.every((button) => button.disabled)).toBe(true);
    document.body.append(container);

    const hydrationErrors: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: Root | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, <PrinterCalibrationPanel {...props} />, {
          onRecoverableError: (error) => hydrationErrors.push(error),
        });
        await Promise.resolve();
      });

      expect(hydrationErrors).toEqual([]);
      expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/hydration|didn't match|text content/i);
      expect(serverInitialSessionText).toContain("sessão —");

      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Medições" }));
      const sessionInput = screen.getByLabelText("Fixture session ID") as HTMLInputElement;
      await waitFor(() => expect(sessionInput.value).toMatch(/^calibration-session-[0-9a-f-]{36}$/));
      const originalSessionId = sessionInput.value;

      await user.click(screen.getByRole("button", { name: /Gerar Calibration PDF/ }));
      await waitFor(() => expect(requests.some(({ url }) => url === "/api/calibration/sheet")).toBe(true));
      const calibrationRequest = requests.find(({ url }) => url === "/api/calibration/sheet")!;
      expect(JSON.parse(String(calibrationRequest.init?.body)).sessionId).toBe(originalSessionId);

      await user.click(screen.getByRole("tab", { name: "Verificação" }));
      await user.click(screen.getByRole("button", { name: /Gerar Verification PDF/ }));
      await waitFor(() => expect(requests.some(({ url }) => url === "/api/calibration/verification-sheet")).toBe(true));
      const verificationRequest = requests.find(({ url }) => url === "/api/calibration/verification-sheet")!;
      expect(JSON.parse(String(verificationRequest.init?.body)).sessionId).toBe(originalSessionId);
      await waitFor(() => expect(screen.getByRole("checkbox", { name: /Confirmo que medi/ })).toBeEnabled());

      await user.click(screen.getByRole("tab", { name: "Medições" }));
      await user.click(screen.getByRole("button", { name: "Nova sessão" }));
      await waitFor(() => expect(sessionInput.value).not.toBe(originalSessionId));
      const newSessionId = sessionInput.value;
      expect(newSessionId).toMatch(/^calibration-session-[0-9a-f-]{36}$/);

      await user.click(screen.getByRole("tab", { name: "Verificação" }));
      expect(screen.getByRole("checkbox", { name: /Confirmo que medi/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Registrar medição física e criar revisão" })).toBeDisabled();
    } finally {
      root?.unmount();
      container.remove();
      if (previousCreateObjectURL) Object.defineProperty(URL, "createObjectURL", previousCreateObjectURL);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (previousRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});
