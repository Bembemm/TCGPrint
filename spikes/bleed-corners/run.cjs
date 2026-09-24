const sharp = require("sharp");
const path = require("node:path");

(async () => {
  const width = 64;
  const height = 64;
  const bleedPx = 12;
  const sourceStripPx = 8;
  const channels = 3;
  const scale = 5;
  const candidates = ["dominant-side", "reflected-patch", "edge-blend", "constant-corner"];
  const sourcePixels = Buffer.alloc(width * height * channels);

  function setPixel(target, targetWidth, x, y, color) {
    const start = (y * targetWidth + x) * channels;
    target.set(color, start);
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let color = [
        28 + Math.floor(x * 1.2),
        45 + Math.floor(y * 0.8),
        92 + Math.floor((x + y) * 0.35),
      ];
      if (x < 10 && y < 10) {
        const checker = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0;
        color = checker ? [245, 220, 42] : [20, 20, 20];
      }
      if (y === 0) color = [235, 50 + Math.floor(x * 1.5), 70];
      if (x === 0) color = [40, 210 - Math.floor(y * 1.5), 100];
      if (x < 5 && y < 5) color = [255, 255, 255];
      if (x >= 4 && x < 8 && y >= 1 && y < 4) color = [10, 10, 10];
      setPixel(sourcePixels, width, x, y, color);
    }
  }

  function sampleSource(x, y) {
    const safeX = Math.max(0, Math.min(width - 1, x));
    const safeY = Math.max(0, Math.min(height - 1, y));
    const start = (safeY * width + safeX) * channels;
    return [...sourcePixels.subarray(start, start + channels)];
  }

  function stripOffset(depthPx) {
    return Math.min(sourceStripPx - 1, Math.floor(((depthPx - 1) * sourceStripPx) / bleedPx));
  }

  const panels = [];
  for (const candidate of candidates) {
    const outputWidth = width + 2 * bleedPx;
    const outputHeight = height + 2 * bleedPx;
    const outputPixels = Buffer.alloc(outputWidth * outputHeight * channels);

    for (let y = 0; y < outputHeight; y += 1) {
      for (let x = 0; x < outputWidth; x += 1) {
        const cardX = x - bleedPx;
        const cardY = y - bleedPx;
        let color;

        if (cardX >= 0 && cardX < width && cardY >= 0 && cardY < height) {
          color = sampleSource(cardX, cardY);
        } else {
          const left = cardX < 0;
          const right = cardX >= width;
          const top = cardY < 0;
          const bottom = cardY >= height;
          const depthX = left ? -cardX : right ? cardX - width + 1 : 0;
          const depthY = top ? -cardY : bottom ? cardY - height + 1 : 0;

          if ((left || right) && (top || bottom)) {
            const sourceXOffset = stripOffset(depthX);
            const sourceYOffset = stripOffset(depthY);
            const cornerX = left ? sourceXOffset : width - 1 - sourceXOffset;
            const cornerY = top ? sourceYOffset : height - 1 - sourceYOffset;
            const horizontalSample = sampleSource(cornerX, top ? 0 : height - 1);
            const verticalSample = sampleSource(left ? 0 : width - 1, cornerY);

            if (candidate === "dominant-side") {
              color = depthX >= depthY ? horizontalSample : verticalSample;
            } else if (candidate === "reflected-patch") {
              color = sampleSource(cornerX, cornerY);
            } else if (candidate === "edge-blend") {
              const weight = depthX / (depthX + depthY);
              color = verticalSample.map((value, index) => Math.round(
                value * (1 - weight) + horizontalSample[index] * weight,
              ));
            } else {
              color = sampleSource(left ? 0 : width - 1, top ? 0 : height - 1);
            }
          } else if (top) {
            color = sampleSource(cardX, stripOffset(depthY));
          } else if (bottom) {
            color = sampleSource(cardX, height - 1 - stripOffset(depthY));
          } else if (left) {
            color = sampleSource(stripOffset(depthX), cardY);
          } else {
            color = sampleSource(width - 1 - stripOffset(depthX), cardY);
          }
        }

        setPixel(outputPixels, outputWidth, x, y, color);
      }
    }

    const scaledPanel = await sharp(outputPixels, {
      raw: { width: outputWidth, height: outputHeight, channels },
    }).resize(outputWidth * scale, outputHeight * scale, { kernel: "nearest" }).png().toBuffer();
    const label = Buffer.from(
      `<svg width="${outputWidth * scale}" height="26"><rect width="100%" height="100%" fill="#f5f5f5"/><text x="8" y="19" font-family="Arial" font-size="15" fill="#111">${candidate}</text></svg>`,
    );
    const panel = await sharp(scaledPanel)
      .extend({ top: 26, bottom: 0, left: 0, right: 0, background: "#f5f5f5" })
      .composite([{ input: label, left: 0, top: 0 }])
      .png()
      .toBuffer();
    panels.push(panel);
  }

  const panelWidth = (width + 2 * bleedPx) * scale;
  const panelHeight = panelWidth + 26;
  const matrix = await sharp({
    create: {
      width: panelWidth * 2,
      height: panelHeight * 2,
      channels,
      background: { r: 245, g: 245, b: 245 },
    },
  }).composite([
    { input: panels[0], left: 0, top: 0 },
    { input: panels[1], left: panelWidth, top: 0 },
    { input: panels[2], left: 0, top: panelHeight },
    { input: panels[3], left: panelWidth, top: panelHeight },
  ]).png().toBuffer();

  const outputPath = path.join(__dirname, "candidate-matrix.png");
  await sharp(matrix).toFile(outputPath);
  console.log(`Wrote ${outputPath}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
