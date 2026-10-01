"use client";

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  CalibrationError,
  CALIBRATION_POINT_IDS,
  checkPrinterProfileCompatibility,
  createIdentitySideCalibration,
  createProfileVerificationContextKey,
  createPrintCalibrationTransform,
  getCalibrationTargetPoints,
  parseMillimeterInputToUm,
  parsePrinterProfileImportJson,
  parseSideCalibration,
  solveAdvancedCalibration,
  type CalibrationMeasurement,
  type CalibrationPointId,
  type PrinterDuplexMode,
  type PrinterProfile,
  type PrinterProfileSnapshot,
  type SideCalibration,
} from "../../core/calibration";
import type { PaperFormat, PageOrientation } from "../../core/geometry";
import type { ExportContentMode } from "../../persistence/projects/serializer";
import type { DuplexFlipMode } from "../../core/duplex";

type WizardStep = 1 | 2 | 3 | 4;
type PreviewMode = "nominal" | "calibrated" | "overlay";
type MeasurementDraft = Record<CalibrationPointId, { x: string; y: string }>;

export interface PrinterCalibrationPanelProps {
  readonly paperFormat: PaperFormat;
  readonly pageOrientation: PageOrientation;
  readonly printerProfileSelection: PrinterProfileSnapshot | null;
  readonly printerDuplexMode: PrinterDuplexMode;
  readonly exportContentMode: ExportContentMode;
  readonly duplexFlipMode: DuplexFlipMode;
  readonly disabled: boolean;
  readonly onProjectSelectionChange: (profile: PrinterProfileSnapshot | null, duplexMode: PrinterDuplexMode) => void;
}

const SIMPLE_IDENTITY = createIdentitySideCalibration();
const EMPTY_MEASUREMENTS: MeasurementDraft = {
  center: { x: "", y: "" },
  "top-left": { x: "", y: "" },
  "top-right": { x: "", y: "" },
  "bottom-left": { x: "", y: "" },
  "bottom-right": { x: "", y: "" },
};
const OFFSET_NUDGES = [
  { name: "Micro ±0.001 mm", um: 1 },
  { name: "Fine ±0.010 mm", um: 10 },
  { name: "Normal ±0.100 mm", um: 100 },
  { name: "Coarse ±1.000 mm", um: 1_000 },
] as const;
const SAFE_DECIMAL = /^[+-]?(?:(?:\d+(?:[.,]\d{1,6})?)|(?:[.,]\d{1,6}))$/;

function parseDecimal(text: string, field: string): number {
  if (!SAFE_DECIMAL.test(text)) throw new CalibrationError("INVALID_CALIBRATION", `${field}: use um número com ponto ou vírgula, sem separador de milhar.`);
  const value = Number(text.replace(",", "."));
  if (!Number.isFinite(value)) throw new CalibrationError("INVALID_CALIBRATION", `${field}: informe um número finito.`);
  return value;
}

function millimeters(um: number): string {
  return (um / 1_000).toFixed(3);
}

function rotationText(degrees: number): string {
  return degrees.toFixed(3);
}

function profileValues(snapshot: PrinterProfileSnapshot): PrinterProfile {
  const { version: _version, profileHash: _profileHash, ...profile } = snapshot;
  return profile;
}

function freshId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now().toString(36)}`;
}

function effectivePageSize(paper: PaperFormat, orientation: PageOrientation) {
  const baseLandscape = paper.widthMm > paper.heightMm;
  const desiredLandscape = orientation === "landscape";
  return baseLandscape === desiredLandscape
    ? { widthMm: paper.widthMm, heightMm: paper.heightMm }
    : { widthMm: paper.heightMm, heightMm: paper.widthMm };
}

function svgMatrix(matrix: ReturnType<typeof createPrintCalibrationTransform>["svgMatrix"]): string {
  return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
}

async function responseJson<T>(response: Response): Promise<T> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error(`Resposta inesperada do servidor (HTTP ${response.status}).`); }
  if (!response.ok) {
    const body = value as { message?: unknown };
    throw new Error(typeof body?.message === "string" ? body.message : `A operação falhou (HTTP ${response.status}).`);
  }
  return value as T;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function calibrationFields(profile: PrinterProfile, side: "front" | "back", calibration: SideCalibration): PrinterProfile {
  return { ...profile, [side]: calibration };
}

export default function PrinterCalibrationPanel({
  paperFormat,
  pageOrientation,
  printerProfileSelection,
  printerDuplexMode,
  exportContentMode,
  duplexFlipMode,
  disabled,
  onProjectSelectionChange,
}: PrinterCalibrationPanelProps) {
  const [profiles, setProfiles] = useState<readonly PrinterProfileSnapshot[]>([]);
  const [profileName, setProfileName] = useState("Minha impressora");
  const [side, setSide] = useState<"front" | "back">("back");
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [step, setStep] = useState<WizardStep>(1);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("calibrated");
  const [draftCalibration, setDraftCalibration] = useState<SideCalibration>(SIMPLE_IDENTITY);
  const [xText, setXText] = useState("0.000");
  const [yText, setYText] = useState("0.000");
  const [rotationValue, setRotationValue] = useState("0.000");
  const [scaleXValue, setScaleXValue] = useState("1");
  const [scaleYValue, setScaleYValue] = useState("1");
  const [skewXValue, setSkewXValue] = useState("0");
  const [skewYValue, setSkewYValue] = useState("0");
  const [measurements, setMeasurements] = useState<MeasurementDraft>(EMPTY_MEASUREMENTS);
  const [verificationMeasurements, setVerificationMeasurements] = useState<MeasurementDraft>(EMPTY_MEASUREMENTS);
  const [physicalMeasurementAttested, setPhysicalMeasurementAttested] = useState(false);
  const [verificationSheetKey, setVerificationSheetKey] = useState<string | null>(null);
  const [residualSummary, setResidualSummary] = useState<{ mean: number; min: number; max: number } | null>(null);
  const [sessionId, setSessionId] = useState(() => freshId("calibration-session"));
  const [previewOpacity, setPreviewOpacity] = useState("45");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const refreshProfiles = useCallback(async () => {
    const response = await fetch("/api/printer-profiles", { cache: "no-store" });
    const body = await responseJson<{ profiles: PrinterProfileSnapshot[] }>(response);
    setProfiles(body.profiles);
    return body.profiles;
  }, []);

  useEffect(() => {
    let live = true;
    void fetch("/api/printer-profiles", { cache: "no-store" })
      .then((response) => responseJson<{ profiles: PrinterProfileSnapshot[] }>(response))
      .then((body) => { if (live) setProfiles(body.profiles); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : "A biblioteca local não abriu."); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const selected = printerProfileSelection?.[side] ?? SIMPLE_IDENTITY;
    setDraftCalibration(selected);
    setXText(millimeters(selected.offsetXUm));
    setYText(millimeters(selected.offsetYUm));
    setRotationValue(rotationText(selected.rotationDeg));
    setScaleXValue(String(selected.scaleX));
    setScaleYValue(String(selected.scaleY));
    setSkewXValue(String(selected.skewXDeg ?? 0));
    setSkewYValue(String(selected.skewYDeg ?? 0));
    setMeasurements(EMPTY_MEASUREMENTS);
    setVerificationMeasurements(EMPTY_MEASUREMENTS);
    setPhysicalMeasurementAttested(false);
    setVerificationSheetKey(null);
    setResidualSummary(null);
    setError("");
  }, [printerProfileSelection?.id, printerProfileSelection?.version, printerProfileSelection?.profileHash, side, sessionId, paperFormat.name, paperFormat.widthMm, paperFormat.heightMm, pageOrientation, printerDuplexMode]);

  const pageSize = useMemo(() => effectivePageSize(paperFormat, pageOrientation), [paperFormat, pageOrientation]);
  const selectedLibraryProfile = profiles.find(({ id }) => id === printerProfileSelection?.id);
  const latestIsNewer = Boolean(selectedLibraryProfile && printerProfileSelection
    && selectedLibraryProfile.version > printerProfileSelection.version);
  const exportSides = exportContentMode === "front-only" ? ["front"] as const
    : exportContentMode === "back-only" ? ["back"] as const : ["front", "back"] as const;
  const compatibility = printerProfileSelection ? checkPrinterProfileCompatibility(printerProfileSelection, {
    paperSize: paperFormat.name,
    paperWidthMm: paperFormat.widthMm,
    paperHeightMm: paperFormat.heightMm,
    pageOrientation,
    duplexMode: printerDuplexMode,
    duplexFlipMode,
    exportSides,
  }) : null;
  const sheetCompatibility = printerProfileSelection ? checkPrinterProfileCompatibility(printerProfileSelection, {
    paperSize: paperFormat.name,
    paperWidthMm: paperFormat.widthMm,
    paperHeightMm: paperFormat.heightMm,
    pageOrientation,
    duplexMode: printerDuplexMode,
    duplexFlipMode,
    exportSides: [side],
  }) : null;

  const calibrationForPreview = (target: "front" | "back") => target === side
    ? draftCalibration
    : printerProfileSelection?.[target] ?? SIMPLE_IDENTITY;
  const frontTransform = createPrintCalibrationTransform(pageSize, calibrationForPreview("front"), "front");
  const backTransform = createPrintCalibrationTransform(pageSize, calibrationForPreview("back"), "back");
  const targets = getCalibrationTargetPoints(pageSize);
  const points = [
    { id: "center", x: targets.center.xMm, y: pageSize.heightMm - targets.center.yMm },
    { id: "TL", x: targets["top-left"].xMm, y: pageSize.heightMm - targets["top-left"].yMm },
    { id: "TR", x: targets["top-right"].xMm, y: pageSize.heightMm - targets["top-right"].yMm },
    { id: "BL", x: targets["bottom-left"].xMm, y: pageSize.heightMm - targets["bottom-left"].yMm },
    { id: "BR", x: targets["bottom-right"].xMm, y: pageSize.heightMm - targets["bottom-right"].yMm },
  ];

  const applySelection = (profile: PrinterProfileSnapshot) => {
    const nextCompatibility = checkPrinterProfileCompatibility(profile, {
      paperSize: paperFormat.name,
      paperWidthMm: paperFormat.widthMm,
      paperHeightMm: paperFormat.heightMm,
      pageOrientation,
      duplexMode: printerDuplexMode,
      duplexFlipMode,
      exportSides,
    });
    if (!nextCompatibility.compatible) {
      setError(`Profile incompatível com este Project: ${nextCompatibility.reasons.join(", ")}.`);
      return;
    }
    invalidateVerificationSheet();
    onProjectSelectionChange(profile, printerDuplexMode);
    setError("");
    setStatus(`Project agora usa ${profile.name} v${profile.version}.`);
  };

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "A operação de calibração falhou."); }
    finally { setBusy(false); }
  };

  const invalidateVerificationSheet = () => {
    setVerificationMeasurements(EMPTY_MEASUREMENTS);
    setPhysicalMeasurementAttested(false);
    setVerificationSheetKey(null);
  };

  const createProfile = () => run(async () => {
    const response = await fetch("/api/printer-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: {
        id: freshId("printer"),
        name: profileName.trim() || "Minha impressora",
        front: createIdentitySideCalibration(),
        back: createIdentitySideCalibration(),
        paperSize: paperFormat.name,
        paperWidthMm: paperFormat.widthMm,
        paperHeightMm: paperFormat.heightMm,
        pageOrientation,
        duplexMode: printerDuplexMode,
        physicalValidationStatus: "software-only",
      } satisfies PrinterProfile }),
    });
    const body = await responseJson<{ profile: PrinterProfileSnapshot }>(response);
    await refreshProfiles();
    applySelection(body.profile);
    setStep(1);
    setStatus(`Profile ${body.profile.name} v1 criado. Nenhuma medição física foi presumida.`);
  });

  const duplicateProfile = (profile: PrinterProfileSnapshot) => run(async () => {
    const response = await fetch(`/api/printer-profiles/${encodeURIComponent(profile.id)}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: profile.version }),
    });
    const body = await responseJson<{ profile: PrinterProfileSnapshot }>(response);
    await refreshProfiles();
    applySelection(body.profile);
  });

  const renameSelectedProfile = () => run(async () => {
    if (!printerProfileSelection) throw new Error("Selecione ou crie um profile antes de renomear.");
    const base = selectedLibraryProfile ?? printerProfileSelection;
    const response = await fetch(`/api/printer-profiles/${encodeURIComponent(base.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: base.version, profile: { ...profileValues(base), name: profileName.trim() } }),
    });
    const body = await responseJson<{ profile: PrinterProfileSnapshot }>(response);
    await refreshProfiles();
    setStatus(`Nome salvo como revisão v${body.profile.version}. O Project continua preso à v${printerProfileSelection.version} até atualização explícita.`);
  });

  const updateProjectToLatest = () => {
    if (selectedLibraryProfile) applySelection(selectedLibraryProfile);
  };

  const currentDraft = (): SideCalibration => parseSideCalibration({
    offsetXUm: parseMillimeterInputToUm(xText),
    offsetYUm: parseMillimeterInputToUm(yText),
    rotationDeg: parseDecimal(rotationValue, "Rotation"),
    scaleX: mode === "advanced" ? parseDecimal(scaleXValue, "Scale X") : draftCalibration.scaleX,
    scaleY: mode === "advanced" ? parseDecimal(scaleYValue, "Scale Y") : draftCalibration.scaleY,
    ...(mode === "advanced" ? {
      skewXDeg: parseDecimal(skewXValue, "Skew X"),
      skewYDeg: parseDecimal(skewYValue, "Skew Y"),
    } : {
      ...(draftCalibration.skewXDeg !== undefined ? { skewXDeg: draftCalibration.skewXDeg } : {}),
      ...(draftCalibration.skewYDeg !== undefined ? { skewYDeg: draftCalibration.skewYDeg } : {}),
    }),
  });

  const setOffsetNudge = (axis: "x" | "y", deltaUm: number) => {
    try {
      const calibration = currentDraft();
      const next = parseSideCalibration({ ...calibration, [axis === "x" ? "offsetXUm" : "offsetYUm"]: calibration[axis === "x" ? "offsetXUm" : "offsetYUm"] + deltaUm });
      setDraftCalibration(next);
      setXText(millimeters(next.offsetXUm));
      setYText(millimeters(next.offsetYUm));
      invalidateVerificationSheet();
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nudge fora dos limites."); }
  };

  const setRotationNudge = (delta: number) => {
    try {
      const next = parseSideCalibration({ ...currentDraft(), rotationDeg: parseDecimal(rotationValue, "Rotation") + delta });
      setDraftCalibration(next);
      setRotationValue(rotationText(next.rotationDeg));
      invalidateVerificationSheet();
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Rotation fora dos limites."); }
  };

  const solveMeasurements = () => {
    try {
      const input: CalibrationMeasurement[] = [];
      for (const pointId of CALIBRATION_POINT_IDS) {
        const value = measurements[pointId];
        if (!value.x && !value.y) continue;
        if (!value.x || !value.y) throw new CalibrationError("INVALID_CALIBRATION", `Informe X e Y para ${pointId}.`);
        input.push({ pointId, deltaXUm: parseMillimeterInputToUm(value.x), deltaYUm: parseMillimeterInputToUm(value.y) });
      }
      const solved = solveAdvancedCalibration(pageSize, input);
      setDraftCalibration(solved.calibration);
      invalidateVerificationSheet();
      setXText(millimeters(solved.calibration.offsetXUm));
      setYText(millimeters(solved.calibration.offsetYUm));
      setRotationValue(rotationText(solved.calibration.rotationDeg));
      setScaleXValue(String(solved.calibration.scaleX));
      setScaleYValue(String(solved.calibration.scaleY));
      setSkewXValue(String(solved.calibration.skewXDeg ?? 0));
      setSkewYValue(String(solved.calibration.skewYDeg ?? 0));
      setResidualSummary(solved.summary ? {
        mean: solved.summary.meanMagnitudeMm,
        min: solved.summary.minimumMagnitudeMm,
        max: solved.summary.maximumMagnitudeMm,
      } : null);
      setError("");
      setStatus(`Solução Advanced calculada com ${solved.residuals.length} pontos; a transformação permanece como rascunho até salvar uma nova revisão.`);
      setStep(3);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Medições insuficientes para resolver a calibração."); }
  };

  const saveRecalibration = () => run(async () => {
    if (!printerProfileSelection) throw new Error("Crie ou selecione um profile antes de salvar uma revisão.");
    const base = selectedLibraryProfile ?? printerProfileSelection;
    if (base.version !== printerProfileSelection.version) {
      throw new Error(`O Project usa v${printerProfileSelection.version}, mas a biblioteca está em v${base.version}. Atualize o Project explicitamente antes de recalibrar a revisão mais nova.`);
    }
    const calibration = currentDraft();
    const candidate = calibrationFields(profileValues(base), side, calibration);
    const response = await fetch(`/api/printer-profiles/${encodeURIComponent(base.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: base.version, profile: candidate }),
    });
    const body = await responseJson<{ profile: PrinterProfileSnapshot }>(response);
    await refreshProfiles();
    setDraftCalibration(calibration);
    setStatus(`Calibração salva como ${body.profile.name} v${body.profile.version}. O Project mantém sua revisão anterior até você atualizá-lo.`);
    setStep(4);
  });

  const recordPhysicalVerification = () => run(async () => {
    if (!printerProfileSelection || !selectedLibraryProfile) throw new Error("Selecione um profile salvo antes de registrar medições físicas.");
    if (!sheetCompatibility?.compatible) {
      throw new Error(`Profile incompatível com esta folha de verificação: ${sheetCompatibility?.reasons.join(", ") ?? "profile ausente"}.`);
    }
    if (selectedLibraryProfile.version !== printerProfileSelection.version) {
      throw new Error(`O Project usa v${printerProfileSelection.version}, mas a biblioteca está em v${selectedLibraryProfile.version}. Atualize o Project explicitamente antes de verificar esta revisão.`);
    }
    if (!physicalMeasurementAttested) throw new Error("Confirme que os valores foram medidos na impressão do Verification PDF.");
    const current = currentDraft();
    if (JSON.stringify(current) !== JSON.stringify(selectedLibraryProfile[side])) {
      throw new Error("Os parâmetros editados ainda não correspondem à revisão salva. Salve uma nova revisão e atualize o Project antes de verificar.");
    }
    const expectedSheetKey = createProfileVerificationContextKey(sessionId, printerProfileSelection, side, current, paperFormat, pageOrientation, printerDuplexMode);
    if (verificationSheetKey !== expectedSheetKey) {
      throw new Error("Gere o Verification PDF desta sessão, profile, versão e lado antes de registrar os residuals.");
    }
    const measured = [];
    for (const pointId of CALIBRATION_POINT_IDS) {
      const value = verificationMeasurements[pointId];
      if (!value.x && !value.y) continue;
      if (!value.x || !value.y) throw new Error(`Informe os dois residuals para ${pointId}.`);
      measured.push({ pointId, residualXUm: parseMillimeterInputToUm(value.x), residualYUm: parseMillimeterInputToUm(value.y) });
    }
    if (measured.length === 0) throw new Error("Informe ao menos um target medido na folha de verificação.");
    const response = await fetch(`/api/printer-profiles/${encodeURIComponent(printerProfileSelection.id)}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: printerProfileSelection.version,
        sessionId,
        measurements: measured,
        attestPhysicalMeasurements: true,
      }),
    });
    const body = await responseJson<{ profile: PrinterProfileSnapshot }>(response);
    await refreshProfiles();
    setPhysicalMeasurementAttested(false);
    setVerificationSheetKey(null);
    setVerificationMeasurements(EMPTY_MEASUREMENTS);
    setStatus(`Medições físicas registradas em ${body.profile.name} v${body.profile.version}: média ${body.profile.physicalVerification?.residualSummaryMm.mean.toFixed(3)} mm, min ${body.profile.physicalVerification?.residualSummaryMm.minimum.toFixed(3)} mm, max ${body.profile.physicalVerification?.residualSummaryMm.maximum.toFixed(3)} mm. O Project continua usando a revisão selecionada até atualização explícita.`);
  });

  const downloadSheet = (verification: boolean) => run(async () => {
    if (!printerProfileSelection) throw new Error("Selecione ou crie um profile antes de gerar uma folha.");
    if (!sheetCompatibility?.compatible) {
      throw new Error(`Profile incompatível com esta folha: ${sheetCompatibility?.reasons.join(", ") ?? "profile ausente"}.`);
    }
    const draftProfileId = printerProfileSelection?.id ?? freshId("draft");
    const calibration = verification ? currentDraft() : undefined;
    const payload = {
      sessionId,
      draftProfileId,
      paperFormat,
      pageOrientation,
      duplexMode: printerDuplexMode,
      side,
      ...(calibration ? { calibration } : {}),
    };
    const response = await fetch(verification ? "/api/calibration/verification-sheet" : "/api/calibration/sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let message = `A folha não foi gerada (HTTP ${response.status}).`;
      try { const body = await response.json() as { message?: string }; message = body.message ?? message; } catch { /* API may return an empty failure response. */ }
      throw new Error(message);
    }
    downloadBlob(await response.blob(), `tcgprint-${verification ? "verification" : "calibration"}-${side}.pdf`);
    if (verification && printerProfileSelection && calibration) {
      setVerificationSheetKey(createProfileVerificationContextKey(sessionId, printerProfileSelection, side, calibration, paperFormat, pageOrientation, printerDuplexMode));
      setVerificationMeasurements(EMPTY_MEASUREMENTS);
      setPhysicalMeasurementAttested(false);
    }
    setStatus(`${verification ? "Verification PDF" : "Calibration PDF"} da sessão ${sessionId} baixado. Isso não marca verificação física.`);
    setStep(verification ? 4 : 2);
  });

  const exportProfile = () => {
    if (!printerProfileSelection) return;
    const anchor = document.createElement("a");
    anchor.href = `/api/printer-profiles/${encodeURIComponent(printerProfileSelection.id)}/export?version=${printerProfileSelection.version}`;
    anchor.download = `printer-profile-${printerProfileSelection.id}-v${printerProfileSelection.version}.json`;
    anchor.click();
  };

  const importProfile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    void run(async () => {
      if (file.size > 64 * 1024) throw new Error("Profile import excede 64 KiB.");
      const json = await file.text();
      const imported = parsePrinterProfileImportJson(json);
      const acceptsPhysicalEvidence = imported.physicalValidationStatus === "physically-verified"
        ? window.confirm("Este JSON declara medições físicas anteriores. Confirme somente se o relatório e os residuals vieram de medições reais. Importar essa evidência?")
        : false;
      if (imported.physicalValidationStatus === "physically-verified" && !acceptsPhysicalEvidence) return;
      const response = await fetch("/api/printer-profiles/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(acceptsPhysicalEvidence ? { "X-TCGPrint-Accept-Physical-Verification": "true" } : {}),
        },
        body: json,
      });
      const body = await responseJson<{ profile: PrinterProfileSnapshot }>(response);
      await refreshProfiles();
      applySelection(body.profile);
    });
  };

  const calibrationPreview = (target: "front" | "back", showCalibrated: boolean, opacity = 1) => {
    const transform = target === "front" ? frontTransform : backTransform;
    const stroke = target === "front" ? "#1d4ed8" : "#ea580c";
    return <g key={`${target}-${showCalibrated ? "calibrated" : "nominal"}`} transform={showCalibrated ? svgMatrix(transform.svgMatrix) : undefined} opacity={opacity} stroke={stroke} fill="none" strokeWidth="0.65" vectorEffect="non-scaling-stroke">
      {points.map((point) => <g key={point.id} transform={`translate(${point.x} ${point.y})`}>
        <line x1="-3" y1="0" x2="3" y2="0" /><line x1="0" y1="-3" x2="0" y2="3" />
        {target === "front" ? <circle r="1.8" /> : <rect x="-1.4" y="-1.4" width="2.8" height="2.8" />}
      </g>)}
    </g>;
  };

  const matrixGroups = previewMode === "nominal"
    ? <>{calibrationPreview("front", false)}{calibrationPreview("back", false, Number(previewOpacity) / 100)}</>
    : previewMode === "calibrated"
      ? <>{calibrationPreview("front", true)}{calibrationPreview("back", true, Number(previewOpacity) / 100)}</>
      : <>{calibrationPreview("front", false)}{calibrationPreview("back", true, Number(previewOpacity) / 100)}</>;

  const updateMeasurement = (point: CalibrationPointId, axis: "x" | "y", value: string) => {
    setMeasurements((current) => ({ ...current, [point]: { ...current[point], [axis]: value } }));
  };

  return <section className="printer-calibration-panel" aria-labelledby="printer-calibration-heading">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Fase 13 · Precision Print Calibration</p>
        <h3 id="printer-calibration-heading">Calibração física da impressora</h3>
        <p>A correção final move o conteúdo impresso da página. Trim, layout, artwork original, registration reservado e arquivos de corte continuam nominais.</p>
      </div>
      <span className="calibration-status-badge">{printerProfileSelection ? `Profile v${printerProfileSelection.version}` : "Sem calibração"}</span>
    </div>

    <div className="calibration-axis-convention" aria-label="Convenção dos eixos de calibração">
      <strong>+X → direita</strong><strong>-X → esquerda</strong><strong>+Y → cima</strong><strong>-Y → baixo</strong>
    </div>

    <nav className="calibration-wizard-steps" aria-label="Etapas do Calibration Wizard">
      {([1, 2, 3, 4] as const).map((item) => <button key={item} type="button" className={step === item ? "button primary" : "button secondary"} aria-current={step === item ? "step" : undefined} onClick={() => setStep(item)}>
        {item}. {(["Profile", "Folha", "Medições", "Verificação"] as const)[item - 1]}
      </button>)}
    </nav>

    <div className="calibration-layout">
      <div className="calibration-controls">
        <div className="calibration-profile-fields">
          <label>Printer profile<select aria-label="Printer profile" value={printerProfileSelection?.id ?? ""} disabled={disabled || busy} onChange={(event) => {
            const next = profiles.find(({ id }) => id === event.currentTarget.value);
            if (next) applySelection(next);
            else if (!event.currentTarget.value) { invalidateVerificationSheet(); onProjectSelectionChange(null, printerDuplexMode); }
          }}>
            <option value="">Sem calibração</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.version}</option>)}
          </select></label>
          <label>Nome do profile<input type="text" maxLength={160} value={profileName} disabled={disabled || busy} onChange={(event) => setProfileName(event.currentTarget.value)} /></label>
          <label>Modo da impressora<select aria-label="Printer duplex mode" value={printerDuplexMode} disabled={disabled || busy} onChange={(event) => onProjectSelectionChange(printerProfileSelection, event.currentTarget.value as PrinterDuplexMode)}>
            <option value="single-sided">Simplex</option>
            <option value="manual-long-edge">Manual · long-edge</option>
            <option value="manual-short-edge">Manual · short-edge</option>
            <option value="automatic-long-edge">Automático · long-edge</option>
            <option value="automatic-short-edge">Automático · short-edge</option>
          </select></label>
          <p className="muted">Papel {paperFormat.name} · {paperFormat.widthMm} × {paperFormat.heightMm} mm · {pageOrientation} · {printerDuplexMode}</p>
          {!printerProfileSelection && <button className="button primary" type="button" disabled={disabled || busy} onClick={() => void createProfile()}>Criar profile</button>}
          {printerProfileSelection && <div className="calibration-profile-actions">
            <button className="button secondary" type="button" disabled={disabled || busy} onClick={() => void renameSelectedProfile()}>Renomear</button>
            <button className="button secondary" type="button" disabled={disabled || busy} onClick={() => void duplicateProfile(printerProfileSelection)}>Duplicar profile</button>
            <button className="button secondary" type="button" onClick={exportProfile}>Exportar JSON</button>
            <label className="button secondary calibration-file-button">Importar JSON<input type="file" accept="application/json,.json" disabled={disabled || busy} onChange={importProfile} /></label>
          </div>}
          {!printerProfileSelection && <label className="button secondary calibration-file-button">Importar profile<input type="file" accept="application/json,.json" disabled={disabled || busy} onChange={importProfile} /></label>}
          {latestIsNewer && selectedLibraryProfile && printerProfileSelection && <div className="warning-message" role="status">
            <p>Existe uma calibração mais nova. O Project usa v{printerProfileSelection.version}; a biblioteca está em v{selectedLibraryProfile.version}.</p>
            <button className="button secondary" type="button" disabled={disabled || busy} onClick={updateProjectToLatest}>Atualizar Project para v{selectedLibraryProfile.version}</button>
          </div>}
          {compatibility && <p className={compatibility.compatible ? "status-message" : "error-message"} role={compatibility.compatible ? "status" : "alert"}>
            {compatibility.compatible ? `Compatível · profile ${printerProfileSelection?.name} v${printerProfileSelection?.version}` : `Profile incompatível: ${compatibility.reasons.join(", ")}`}
          </p>}
          {printerProfileSelection && <p className="muted">Status: {printerProfileSelection.physicalValidationStatus}. Gerar uma folha de verificação não confirma uma medição física.
            {printerProfileSelection.physicalVerification && ` Residual medido: média ${printerProfileSelection.physicalVerification.residualSummaryMm.mean.toFixed(3)} mm · min ${printerProfileSelection.physicalVerification.residualSummaryMm.minimum.toFixed(3)} mm · max ${printerProfileSelection.physicalVerification.residualSummaryMm.maximum.toFixed(3)} mm.`}
          </p>}
        </div>

        <div className="calibration-mode-switch" role="group" aria-label="Modo de calibração">
          <button type="button" className={mode === "simple" ? "button primary" : "button secondary"} aria-pressed={mode === "simple"} onClick={() => setMode("simple")}>Simple · X/Y/Rotation</button>
          <button type="button" className={mode === "advanced" ? "button primary" : "button secondary"} aria-pressed={mode === "advanced"} onClick={() => setMode("advanced")}>Advanced · Scale/Skew</button>
        </div>
        <div className="calibration-side-switch" role="group" aria-label="Lado da calibração">
          <button type="button" className={side === "front" ? "button primary" : "button secondary"} aria-pressed={side === "front"} onClick={() => { invalidateVerificationSheet(); setSide("front"); }}>Front</button>
          <button type="button" className={side === "back" ? "button primary" : "button secondary"} aria-pressed={side === "back"} onClick={() => { invalidateVerificationSheet(); setSide("back"); }}>Back</button>
        </div>

        <div className="calibration-numeric-fields">
          <label>X offset (mm)<input inputMode="decimal" value={xText} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => { setXText(event.currentTarget.value); invalidateVerificationSheet(); }} onBlur={() => {
            try { const next = parseSideCalibration({ ...draftCalibration, offsetXUm: parseMillimeterInputToUm(xText) }); setDraftCalibration(next); setError(""); }
            catch (cause) { setError(cause instanceof Error ? cause.message : "Offset X inválido."); }
          }} /></label>
          <label>Y offset (mm)<input inputMode="decimal" value={yText} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => { setYText(event.currentTarget.value); invalidateVerificationSheet(); }} onBlur={() => {
            try { const next = parseSideCalibration({ ...draftCalibration, offsetYUm: parseMillimeterInputToUm(yText) }); setDraftCalibration(next); setError(""); }
            catch (cause) { setError(cause instanceof Error ? cause.message : "Offset Y inválido."); }
          }} /></label>
          <label>Rotation (°)<input inputMode="decimal" value={rotationValue} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => { setRotationValue(event.currentTarget.value); invalidateVerificationSheet(); }} onBlur={() => {
            try { const next = parseSideCalibration({ ...draftCalibration, rotationDeg: parseDecimal(rotationValue, "Rotation") }); setDraftCalibration(next); setError(""); }
            catch (cause) { setError(cause instanceof Error ? cause.message : "Rotation inválida."); }
          }} /></label>
          {mode === "advanced" && <>
            <label>Scale X<input inputMode="decimal" value={scaleXValue} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => { setScaleXValue(event.currentTarget.value); invalidateVerificationSheet(); }} onBlur={() => {
              try { const next = parseSideCalibration({ ...draftCalibration, scaleX: parseDecimal(scaleXValue, "Scale X") }); setDraftCalibration(next); setError(""); }
              catch (cause) { setError(cause instanceof Error ? cause.message : "Scale X inválido."); }
            }} /></label>
            <label>Scale Y<input inputMode="decimal" value={scaleYValue} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => { setScaleYValue(event.currentTarget.value); invalidateVerificationSheet(); }} onBlur={() => {
              try { const next = parseSideCalibration({ ...draftCalibration, scaleY: parseDecimal(scaleYValue, "Scale Y") }); setDraftCalibration(next); setError(""); }
              catch (cause) { setError(cause instanceof Error ? cause.message : "Scale Y inválido."); }
            }} /></label>
            <label>Skew X (°)<input inputMode="decimal" value={skewXValue} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => { setSkewXValue(event.currentTarget.value); invalidateVerificationSheet(); }} onBlur={() => {
              try { const next = parseSideCalibration({ ...draftCalibration, skewXDeg: parseDecimal(skewXValue, "Skew X") }); setDraftCalibration(next); setError(""); }
              catch (cause) { setError(cause instanceof Error ? cause.message : "Skew X inválido."); }
            }} /></label>
            <label>Skew Y (°)<input inputMode="decimal" value={skewYValue} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => { setSkewYValue(event.currentTarget.value); invalidateVerificationSheet(); }} onBlur={() => {
              try { const next = parseSideCalibration({ ...draftCalibration, skewYDeg: parseDecimal(skewYValue, "Skew Y") }); setDraftCalibration(next); setError(""); }
              catch (cause) { setError(cause instanceof Error ? cause.message : "Skew Y inválido."); }
            }} /></label>
          </>}
        </div>
        <p className="muted">Offsets aceitam . ou , com até 3 casas decimais; armazenamento em µm. X/Y são deltas físicos, não posições medidas.</p>

        <div className="calibration-nudges" aria-label="Nudges de offset">
          {OFFSET_NUDGES.map(({ name, um }) => <div className="calibration-nudge-row" key={name}>
            <strong>{name}</strong>
            {(["x", "y"] as const).map((axis) => <span className="calibration-nudge-axis" key={axis}>
              <span>{axis.toUpperCase()}</span>
              <button type="button" className="button secondary" aria-label={`${axis.toUpperCase()} ${name} −`} disabled={disabled || busy || !printerProfileSelection} onClick={() => setOffsetNudge(axis, -um)}>−</button>
              <button type="button" className="button secondary" aria-label={`${axis.toUpperCase()} ${name} +`} disabled={disabled || busy || !printerProfileSelection} onClick={() => setOffsetNudge(axis, um)}>+</button>
            </span>)}
          </div>)}
          <div className="calibration-nudge-row"><strong>Rotation ±0.001°</strong>
            <button type="button" className="button secondary" aria-label="Rotation −0.001°" disabled={disabled || busy || !printerProfileSelection} onClick={() => setRotationNudge(-0.001)}>−</button>
            <button type="button" className="button secondary" aria-label="Rotation +0.001°" disabled={disabled || busy || !printerProfileSelection} onClick={() => setRotationNudge(0.001)}>+</button>
          </div>
        </div>

        {mode === "advanced" && <div className="calibration-measurements">
          <h4>Erro observado por target (mm)</h4>
          <p>Delta = coordenada impressa observada − alvo nominal. X positivo é direita; Y positivo é fisicamente para cima. Informe medições reais da folha desta sessão.</p>
          {CALIBRATION_POINT_IDS.map((pointId) => <div className="calibration-measurement-row" key={pointId}>
            <strong>{pointId}</strong>
            <label>X (mm)<input inputMode="decimal" value={measurements[pointId].x} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => updateMeasurement(pointId, "x", event.currentTarget.value)} /></label>
            <label>Y (mm)<input inputMode="decimal" value={measurements[pointId].y} disabled={disabled || busy || !printerProfileSelection} onChange={(event) => updateMeasurement(pointId, "y", event.currentTarget.value)} /></label>
          </div>)}
          <button className="button secondary" type="button" disabled={disabled || busy || !printerProfileSelection} onClick={solveMeasurements}>Calcular transformação Advanced</button>
          {residualSummary && <p role="status">Resíduo após a correção: média {residualSummary.mean.toFixed(4)} mm · min {residualSummary.min.toFixed(4)} mm · max {residualSummary.max.toFixed(4)} mm. Sem critério universal de aprovação.</p>}
        </div>}

        {step === 4 && <div className="calibration-measurements physical-verification-measurements">
          <h4>Residual medido após correção (mm)</h4>
          <p>Informe diferença observada − nominal no Verification PDF desta sessão. Estes valores são evidência informada pelo usuário; o software não recebe dados da impressora nem define aprovação universal.</p>
          {CALIBRATION_POINT_IDS.map((pointId) => <div className="calibration-measurement-row" key={`verify-${pointId}`}>
            <strong>{pointId}</strong>
            <label>X residual (mm)<input inputMode="decimal" value={verificationMeasurements[pointId].x} disabled={disabled || busy || !verificationSheetKey} onChange={(event) => { setPhysicalMeasurementAttested(false); setVerificationMeasurements((current) => ({ ...current, [pointId]: { ...current[pointId], x: event.currentTarget.value } })); }} /></label>
            <label>Y residual (mm)<input inputMode="decimal" value={verificationMeasurements[pointId].y} disabled={disabled || busy || !verificationSheetKey} onChange={(event) => { setPhysicalMeasurementAttested(false); setVerificationMeasurements((current) => ({ ...current, [pointId]: { ...current[pointId], y: event.currentTarget.value } })); }} /></label>
          </div>)}
          <label className="calibration-attestation"><input type="checkbox" checked={physicalMeasurementAttested} disabled={disabled || busy || !verificationSheetKey} onChange={(event) => setPhysicalMeasurementAttested(event.currentTarget.checked)} />Confirmo que medi estes residuals fisicamente no Verification PDF desta sessão, profile, versão e lado.</label>
          <button className="button primary" type="button" disabled={disabled || busy || !physicalMeasurementAttested || !verificationSheetKey || !printerProfileSelection} onClick={() => void recordPhysicalVerification()}>Registrar medição física e criar revisão</button>
        </div>}
      </div>

      <div className="calibration-preview-column">
        <div className="calibration-preview-controls" role="group" aria-label="Preview nominal e calibrado">
          <button type="button" className={previewMode === "nominal" ? "button primary" : "button secondary"} aria-pressed={previewMode === "nominal"} onClick={() => setPreviewMode("nominal")}>Nominal</button>
          <button type="button" className={previewMode === "calibrated" ? "button primary" : "button secondary"} aria-pressed={previewMode === "calibrated"} onClick={() => setPreviewMode("calibrated")}>Calibrated</button>
          <button type="button" className={previewMode === "overlay" ? "button primary" : "button secondary"} aria-pressed={previewMode === "overlay"} onClick={() => setPreviewMode("overlay")}>Front + Back overlay</button>
        </div>
        <label>Opacidade do verso ({previewOpacity}%)<input type="range" min="10" max="90" step="5" value={previewOpacity} onChange={(event) => setPreviewOpacity(event.currentTarget.value)} /></label>
        <svg className="calibration-page-preview" viewBox={`0 0 ${pageSize.widthMm} ${pageSize.heightMm}`} role="img" aria-label={`Preview ${previewMode}: correction page matrix for ${pageOrientation} ${paperFormat.name}`}>
          <rect x="0" y="0" width={pageSize.widthMm} height={pageSize.heightMm} fill="white" stroke="#64748b" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
          {matrixGroups}
        </svg>
        <p className="muted">Azul = Front; laranja = Back. O overlay usa a matriz canônica do export, em coordenadas SVG Y-down. O tamanho físico da página não muda.</p>
        <div className="calibration-wizard-actions">
          <label>Fixture session ID<input type="text" value={sessionId} readOnly /></label>
          <button type="button" className="button secondary" onClick={() => { invalidateVerificationSheet(); setSessionId(freshId("calibration-session")); }}>Nova sessão</button>
          <button type="button" className="button secondary" disabled={disabled || busy || !printerProfileSelection} onClick={() => void downloadSheet(false)}>Gerar Calibration PDF · {side}</button>
          <button type="button" className="button secondary" disabled={disabled || busy || !printerProfileSelection} onClick={() => void downloadSheet(true)}>Gerar Verification PDF · {side}</button>
          <button type="button" className="button primary" disabled={disabled || busy || !printerProfileSelection} onClick={() => void saveRecalibration()}>Salvar nova revisão do profile</button>
        </div>
      </div>
    </div>
    {status && <p className="status-message" role="status">{status}</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
  </section>;
}
