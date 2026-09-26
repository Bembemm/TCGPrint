const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const typescript = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = require("node:fs").readFileSync(filename, "utf8");
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
      strict: true,
    },
  }).outputText;
  module._compile(output, filename);
};

const { BleedEngine } = require("../../image-engine/bleed/index.ts");

const WIDTH = 300;
const HEIGHT = 420;
const TRIM = { widthMm: 63.5, heightMm: 88.9 };
const BLEED_MM = 1;
const TILE_WIDTH = 202;
const TILE_HEIGHT = 286;
const PANEL_WIDTH = 154;

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function syntheticCard(kind) {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const position = (y * WIDTH + x) * 3;
      const edgeDepth = Math.min(x, WIDTH - 1 - x, y, HEIGHT - 1 - y);
      if (kind === "classic" && edgeDepth < 5) {
        pixels[position] = 13;
        pixels[position + 1] = 16;
        pixels[position + 2] = 20;
        continue;
      }

      if (kind === "light" && edgeDepth < 6) {
        pixels[position] = 242;
        pixels[position + 1] = 236;
        pixels[position + 2] = 219;
        continue;
      }

      if (kind === "asymmetric" && x < 5) {
        pixels[position] = 12;
        pixels[position + 1] = 14;
        pixels[position + 2] = 18;
        continue;
      }

      const wave = Math.sin(x / 31) * 17 + Math.cos(y / 37) * 19;
      const block = (Math.floor(x / 37) + 2 * Math.floor(y / 53)) % 3;
      pixels[position] = clamp((kind === "classic" ? 66 : 92) + (x / WIDTH) * 88 + wave + block * 7);
      pixels[position + 1] = clamp((kind === "classic" ? 54 : 84) + (y / HEIGHT) * 103 - wave / 2 + block * 5);
      pixels[position + 2] = clamp((kind === "classic" ? 98 : 102) + ((x + y) / (WIDTH + HEIGHT)) * 113 + wave / 3 - block * 6);

      if (kind === "high-contrast-corners" && edgeDepth < 7 && (x < 7 || x >= WIDTH - 7) && (y < 7 || y >= HEIGHT - 7)) {
        const cornerTone = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0 ? 0 : 255;
        pixels[position] = cornerTone;
        pixels[position + 1] = cornerTone;
        pixels[position + 2] = cornerTone;
      }
    }
  }
  return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
}

function panelSvg(mode, effectiveMode, trimRect, outputWidth, outputHeight) {
  const scale = PANEL_WIDTH / outputWidth;
  const panelHeight = outputHeight * scale;
  const imageLeft = (TILE_WIDTH - PANEL_WIDTH) / 2;
  const imageTop = 36 + (TILE_HEIGHT - 54 - panelHeight) / 2;
  const trimX = imageLeft + trimRect.x * scale;
  const trimY = imageTop + trimRect.y * scale;
  const trimWidth = trimRect.width * scale;
  const trimHeight = trimRect.height * scale;
  const heading = mode.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return Buffer.from(`<svg width="${TILE_WIDTH}" height="${TILE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0.5" y="0.5" width="${TILE_WIDTH - 1}" height="${TILE_HEIGHT - 1}" fill="none" stroke="#d0d8df"/>
    <text x="10" y="20" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#263746">${heading}</text>
    <text x="10" y="34" font-family="Arial,sans-serif" font-size="9" fill="#5a6875">effective: ${effectiveMode}</text>
    <rect x="${trimX.toFixed(2)}" y="${trimY.toFixed(2)}" width="${trimWidth.toFixed(2)}" height="${trimHeight.toFixed(2)}" fill="none" stroke="#d84343" stroke-width="1.5" stroke-dasharray="4 3"/>
    <text x="10" y="${TILE_HEIGHT - 10}" font-family="Arial,sans-serif" font-size="9" fill="#64727d">1 mm bleed · red dashed line = trim</text>
  </svg>`);
}

async function createPanel(originalBytes, result, mode, referenceResult) {
  const outputWidth = referenceResult.preview.widthPx;
  const outputHeight = referenceResult.preview.heightPx;
  const trimRect = referenceResult.preview.trimRectPx;
  const image = result
    ? result.preview.bytes
    : await sharp({ create: { width: outputWidth, height: outputHeight, channels: 3, background: { r: 231, g: 235, b: 239 } } })
      .composite([{ input: originalBytes, left: trimRect.x, top: trimRect.y }]).png().toBuffer();
  const effectiveMode = result ? result.effectiveMode : "none";
  const scale = PANEL_WIDTH / outputWidth;
  const panelHeight = Math.round(outputHeight * scale);
  const resized = await sharp(image).resize(PANEL_WIDTH, panelHeight).png().toBuffer();
  const imageLeft = Math.floor((TILE_WIDTH - PANEL_WIDTH) / 2);
  const imageTop = 36 + Math.floor((TILE_HEIGHT - 54 - panelHeight) / 2);
  const background = sharp({ create: { width: TILE_WIDTH, height: TILE_HEIGHT, channels: 3, background: { r: 255, g: 255, b: 255 } } });
  return background.composite([
    { input: resized, left: imageLeft, top: imageTop },
    { input: panelSvg(mode, effectiveMode, trimRect, outputWidth, outputHeight) },
  ]).png().toBuffer();
}

async function main() {
  const engine = new BleedEngine();
  const rows = [
    { title: "Classic dark frame", kind: "classic" },
    { title: "Borderless full-art", kind: "full-art" },
    { title: "Light border", kind: "light" },
    { title: "Asymmetric dark left edge", kind: "asymmetric" },
    { title: "High-contrast corners", kind: "high-contrast-corners" },
  ];
  const gap = 10;
  const margin = 14;
  const width = margin * 2 + TILE_WIDTH * 3 + gap * 2;
  const headerHeight = 54;
  const rowLabelHeight = 23;
  const height = headerHeight + rows.length * (rowLabelHeight + TILE_HEIGHT) + gap * (rows.length + 1) + margin;
  const panels = [];
  let top = headerHeight + gap;

  for (const row of rows) {
    top += rowLabelHeight;
    const original = await syntheticCard(row.kind);
    const subtle = await engine.generate({ imageBytes: original, bleedMm: BLEED_MM, trimSizeMm: TRIM, mode: "subtle-edge-stretch", policyId: "matrix-subtle" });
    const smart = await engine.generate({ imageBytes: original, bleedMm: BLEED_MM, trimSizeMm: TRIM, mode: "smart-border-fill", policyId: "matrix-smart" });
    const variants = [
      ["Original", undefined],
      ["Subtle Edge Stretch", subtle],
      ["Smart Border Fill", smart],
    ];
    for (let index = 0; index < variants.length; index += 1) {
      const [label, result] = variants[index];
      panels.push({ input: await createPanel(original, result, label, subtle), left: margin + index * (TILE_WIDTH + gap), top });
    }
    panels.push({
      input: Buffer.from(`<svg width="${width}" height="${rowLabelHeight}" xmlns="http://www.w3.org/2000/svg"><text x="${margin}" y="16" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#344654">${row.title} · synthetic RGB only</text></svg>`),
      left: 0,
      top: top - rowLabelHeight,
    });
    top += TILE_HEIGHT + gap;
  }

  panels.push({
    input: Buffer.from(`<svg width="${width}" height="${headerHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f4f7f9"/><text x="${margin}" y="24" font-family="Arial,sans-serif" font-size="17" font-weight="700" fill="#1e3445">Smart Border Fill · synthetic comparison</text><text x="${margin}" y="43" font-family="Arial,sans-serif" font-size="10" fill="#5b6974">Source samples only · 1 mm exterior bleed · trim outline is red and dashed</text></svg>`),
    left: 0,
    top: 0,
  });

  const output = path.resolve(__dirname, "../../docs/decisions/assets/smart-border-fill-comparison.png");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: { r: 249, g: 250, b: 251 } } })
    .composite(panels)
    .png({ compressionLevel: 9 })
    .toFile(output);
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
