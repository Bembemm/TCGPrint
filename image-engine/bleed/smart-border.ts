import type { RasterPixels } from "./raster";

export const SMART_BORDER_FILL_CONFIG_VERSION = "smart-border-fill-thresholds-v1" as const;

export interface SmartBorderFillConfig {
  readonly version: typeof SMART_BORDER_FILL_CONFIG_VERSION;
  readonly classificationStripMm: number;
  readonly darkLuminanceMax: number;
  readonly darkPixelLuminanceMax: number;
  readonly minimumDarkPixelFraction: number;
  readonly maximumDarkPixelFractionForInteriorStrip: number;
  readonly maximumLuminanceStdDev: number;
  readonly maximumColorStdDev: number;
  readonly minimumSamples: number;
  readonly inwardSearchBoundMm: number;
  readonly searchStepMm: number;
}

export const SMART_BORDER_FILL_CONFIG: SmartBorderFillConfig = Object.freeze({
  version: SMART_BORDER_FILL_CONFIG_VERSION,
  classificationStripMm: 0.75,
  darkLuminanceMax: 0.2,
  darkPixelLuminanceMax: 0.14,
  minimumDarkPixelFraction: 0.85,
  maximumDarkPixelFractionForInteriorStrip: 0.1,
  maximumLuminanceStdDev: 0.045,
  maximumColorStdDev: 0.07,
  minimumSamples: 12,
  inwardSearchBoundMm: 2,
  searchStepMm: 0.25,
});

export type SmartBorderFillConfigOverrides = Partial<Omit<SmartBorderFillConfig, "version">>;
export type BleedSide = "top" | "right" | "bottom" | "left";
export type SmartBorderFallbackReason = "outer-band-not-dark-uniform" | "no-representative-interior-strip-within-search-bound";

export interface SmartBorderSideSource {
  readonly offsetPx: number;
  readonly sourceStripPx: number;
  readonly effectiveMode: "smart-border-fill" | "subtle-edge-stretch";
  readonly classification: "interior-strip-found" | "outer-band-not-dark-uniform" | "search-bound-exhausted";
  readonly fallbackReason?: SmartBorderFallbackReason;
}

export type SmartBorderSideSources = Readonly<Record<BleedSide, SmartBorderSideSource>>;

interface EdgeStats {
  readonly count: number;
  readonly meanLuminance: number;
  readonly luminanceStdDev: number;
  readonly colorStdDev: number;
  readonly darkPixelFraction: number;
}

export function resolveSmartBorderFillConfig(overrides: SmartBorderFillConfigOverrides = {}): SmartBorderFillConfig {
  const config = { ...SMART_BORDER_FILL_CONFIG, ...overrides, version: SMART_BORDER_FILL_CONFIG_VERSION };
  const finite = (value: number) => Number.isFinite(value);
  const thresholds = [
    config.darkLuminanceMax,
    config.darkPixelLuminanceMax,
    config.minimumDarkPixelFraction,
    config.maximumDarkPixelFractionForInteriorStrip,
    config.maximumLuminanceStdDev,
    config.maximumColorStdDev,
  ];
  if (
    !finite(config.classificationStripMm) || config.classificationStripMm <= 0 || config.classificationStripMm > 3
    || thresholds.some((value) => !finite(value) || value < 0 || value > 1)
    || !Number.isInteger(config.minimumSamples) || config.minimumSamples < 1
    || !finite(config.inwardSearchBoundMm) || config.inwardSearchBoundMm < 0 || config.inwardSearchBoundMm > 3
    || !finite(config.searchStepMm) || config.searchStepMm <= 0 || config.searchStepMm > 3
  ) {
    throw new RangeError("Smart border fill thresholds must be finite and within their supported physical or normalized ranges.");
  }
  return Object.freeze(config);
}

function sampleColor(source: RasterPixels, x: number, y: number): readonly [number, number, number] | undefined {
  const start = (y * source.width + x) * source.channels;
  const maximum = source.depth === "ushort" ? 65535 : 255;
  const isGray = source.channels <= 2;
  const alphaChannel = source.channels === 2 ? 1 : source.channels === 4 ? 3 : -1;
  if (alphaChannel >= 0 && source.samples[start + alphaChannel] / maximum <= 0.05) return undefined;
  const red = source.samples[start] / maximum;
  const green = isGray ? red : source.samples[start + 1] / maximum;
  const blue = isGray ? red : source.samples[start + 2] / maximum;
  return [red, green, blue];
}

function analyzeBand(
  source: RasterPixels,
  side: BleedSide,
  offsetPx: number,
  stripPx: number,
  config: SmartBorderFillConfig,
): EdgeStats | undefined {
  const isVerticalSide = side === "left" || side === "right";
  const alongLength = isVerticalSide ? source.height : source.width;
  const cornerSkip = Math.floor(alongLength * 0.05);
  const from = cornerSkip;
  const to = Math.max(from + 1, alongLength - cornerSkip);
  const colors: Array<readonly [number, number, number]> = [];
  const luminances: number[] = [];
  let darkPixels = 0;

  for (let along = from; along < to; along += 1) {
    for (let depth = 0; depth < stripPx; depth += 1) {
      const x = side === "left" ? offsetPx + depth
        : side === "right" ? source.width - 1 - offsetPx - depth
          : along;
      const y = side === "top" ? offsetPx + depth
        : side === "bottom" ? source.height - 1 - offsetPx - depth
          : along;
      const color = sampleColor(source, x, y);
      if (!color) continue;
      const luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
      colors.push(color);
      luminances.push(luminance);
      if (luminance <= config.darkPixelLuminanceMax) darkPixels += 1;
    }
  }

  if (luminances.length < config.minimumSamples) return undefined;
  const meanLuminance = luminances.reduce((sum, value) => sum + value, 0) / luminances.length;
  const luminanceVariance = luminances.reduce((sum, value) => sum + (value - meanLuminance) ** 2, 0) / luminances.length;
  const channelMeans = [0, 1, 2].map((channel) => colors.reduce((sum, color) => sum + color[channel], 0) / colors.length);
  const colorVariance = colors.reduce((sum, color) => sum + color.reduce((channels, value, channel) => channels + (value - channelMeans[channel]!) ** 2, 0), 0) / (colors.length * 3);
  return {
    count: luminances.length,
    meanLuminance,
    luminanceStdDev: Math.sqrt(luminanceVariance),
    colorStdDev: Math.sqrt(colorVariance),
    darkPixelFraction: darkPixels / luminances.length,
  };
}

function isDarkUniform(stats: EdgeStats | undefined, config: SmartBorderFillConfig): boolean {
  return Boolean(stats
    && stats.count >= config.minimumSamples
    && stats.meanLuminance <= config.darkLuminanceMax
    && stats.darkPixelFraction >= config.minimumDarkPixelFraction
    && stats.luminanceStdDev <= config.maximumLuminanceStdDev
    && stats.colorStdDev <= config.maximumColorStdDev);
}

function isRepresentativeInteriorStrip(stats: EdgeStats | undefined, config: SmartBorderFillConfig): boolean {
  return Boolean(stats
    && stats.count >= config.minimumSamples
    && stats.meanLuminance > config.darkLuminanceMax
    && stats.darkPixelFraction <= config.maximumDarkPixelFractionForInteriorStrip);
}

function pxPerMm(pixels: number, physicalMm: number): number {
  return pixels / physicalMm;
}

function candidateOffsets(maximumPx: number, stepPx: number): readonly number[] {
  if (maximumPx < 1) return [];
  const offsets: number[] = [];
  for (let offset = stepPx; offset <= maximumPx; offset += stepPx) offsets.push(offset);
  if (offsets.at(-1) !== maximumPx) offsets.push(maximumPx);
  return offsets;
}

function classifySide(
  source: RasterPixels,
  side: BleedSide,
  stripPx: number,
  trimMm: number,
  config: SmartBorderFillConfig,
): SmartBorderSideSource {
  const sidePixels = side === "left" || side === "right" ? source.width : source.height;
  const scale = pxPerMm(sidePixels, trimMm);
  const probeWidthPx = Math.min(stripPx, Math.max(1, Math.ceil(config.classificationStripMm * scale)));
  if (!isDarkUniform(analyzeBand(source, side, 0, probeWidthPx, config), config)) {
    return {
      offsetPx: 0,
      sourceStripPx: stripPx,
      effectiveMode: "subtle-edge-stretch",
      classification: "outer-band-not-dark-uniform",
      fallbackReason: "outer-band-not-dark-uniform",
    };
  }

  const maximumInwardPx = Math.floor(config.inwardSearchBoundMm * scale);
  const searchBoundPx = Math.min(Math.max(0, maximumInwardPx), sidePixels - stripPx);
  const searchStepPx = Math.max(1, Math.floor(config.searchStepMm * scale));
  for (const offsetPx of candidateOffsets(searchBoundPx, searchStepPx)) {
    if (isRepresentativeInteriorStrip(analyzeBand(source, side, offsetPx, stripPx, config), config)) {
      return {
        offsetPx,
        sourceStripPx: stripPx,
        effectiveMode: "smart-border-fill",
        classification: "interior-strip-found",
      };
    }
  }

  return {
    offsetPx: 0,
    sourceStripPx: stripPx,
    effectiveMode: "subtle-edge-stretch",
    classification: "search-bound-exhausted",
    fallbackReason: "no-representative-interior-strip-within-search-bound",
  };
}

export function classifySmartBorderFillSides(
  source: RasterPixels,
  sourceStripXPx: number,
  sourceStripYPx: number,
  trimWidthMm: number,
  trimHeightMm: number,
  config: SmartBorderFillConfig,
): SmartBorderSideSources {
  const sidePixels = { top: source.height, right: source.width, bottom: source.height, left: source.width } as const;
  const trimMm = { top: trimHeightMm, right: trimWidthMm, bottom: trimHeightMm, left: trimWidthMm } as const;
  const stripPx = { top: sourceStripYPx, right: sourceStripXPx, bottom: sourceStripYPx, left: sourceStripXPx } as const;
  return Object.freeze({
    top: classifySide(source, "top", Math.min(stripPx.top, sidePixels.top), trimMm.top, config),
    right: classifySide(source, "right", Math.min(stripPx.right, sidePixels.right), trimMm.right, config),
    bottom: classifySide(source, "bottom", Math.min(stripPx.bottom, sidePixels.bottom), trimMm.bottom, config),
    left: classifySide(source, "left", Math.min(stripPx.left, sidePixels.left), trimMm.left, config),
  });
}
