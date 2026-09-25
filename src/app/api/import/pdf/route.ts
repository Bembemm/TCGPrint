import { BleedEngine, BleedGenerationError } from "../../../../../image-engine/bleed";
import { MAGIC_STANDARD_CARD, PAPER_FORMATS, type CutGuideConfig } from "../../../../../core/geometry";
import { importImageSource, ImportFailureError } from "../../../../../import-engine";
import type { ImportSource } from "../../../../../import-engine/types";
import { LosslessPdfEngine, PdfExportError } from "../../../../../pdf-engine/document";

export const runtime = "nodejs";

const bleedEngine = new BleedEngine();
const pdfEngine = new LosslessPdfEngine();

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ code, message }, { status });
}

function guideConfig(value: FormDataEntryValue | null): CutGuideConfig {
  const mode = value === "none" ? "none" : "full";
  const style = { color: "#000000", strokeWidthMm: 0.2, opacity: 1, lineStyle: "solid" as const };
  return mode === "none" ? { mode, style } : { mode, style };
}

export async function POST(request: Request): Promise<Response> {
  let source: ImportSource | undefined;
  try {
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File)) return errorResponse("IMAGE_REQUIRED", "Select one local PNG, JPEG or SVG image.", 400);
    const bytes = new Uint8Array(await image.arrayBuffer());
    source = {
      id: "pdf-test-image",
      kind: "file",
      filename: image.name,
      order: 0,
      sizeBytes: bytes.byteLength,
      originalBytes: bytes,
    };
    const imported = await importImageSource(source);
    const format = imported.entry.asset?.originalFormat;
    if (format === "webp" || format === "tiff") {
      return errorResponse(
        "EXPORT_UNSUPPORTED_FORMAT",
        `Formato ${format.toUpperCase()} importado, export direto ainda não suportado pelo PDF Engine.`,
        415,
      );
    }
    if (format !== "png" && format !== "jpeg" && format !== "svg") {
      return errorResponse("EXPORT_UNSUPPORTED_FORMAT", "Imported image format is not supported by the current PDF Engine.", 415);
    }

    const rawBleed = form.get("bleedMm");
    const bleedMm = rawBleed === null || rawBleed === "" ? 0.625 : Number(rawBleed);
    if (!Number.isFinite(bleedMm) || bleedMm < 0 || bleedMm > 3) {
      return errorResponse("INVALID_BLEED", "Bleed must be between 0 and 3 mm.", 400);
    }
    const bleed = await bleedEngine.generate({
      imageBytes: bytes,
      bleedMm,
      trimSizeMm: { widthMm: MAGIC_STANDARD_CARD.widthMm, heightMm: MAGIC_STANDARD_CARD.heightMm },
    });
    const cutGuides = guideConfig(form.get("cutGuides"));
    const pdf = await pdfEngine.generate({
      images: [bytes],
      bleedResults: [bleed],
      cutGuides,
      paperFormat: PAPER_FORMATS.A4,
      cardFormat: MAGIC_STANDARD_CARD,
    });
    return new Response(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="tcgprint-test.pdf"',
        "X-TCGPrint-Original-Format": format,
      },
    });
  } catch (error) {
    if (error instanceof BleedGenerationError) return errorResponse(error.code, error.message, 422);
    if (error instanceof ImportFailureError) return errorResponse(error.code, error.message, 422);
    if (error instanceof PdfExportError) return errorResponse("PDF_EXPORT_FAILED", error.message, 422);
    return errorResponse("PDF_EXPORT_FAILED", error instanceof Error ? error.message : "Could not generate the test PDF.", 500);
  }
}
