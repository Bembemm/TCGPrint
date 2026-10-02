export interface MpcArtworkFilterInput {
  readonly minimumDpi?: number;
  readonly maximumDpi?: number;
  readonly sources?: readonly number[];
  readonly includeTags?: readonly string[];
  readonly excludeTags?: readonly string[];
  readonly languages?: readonly string[];
  /** Preference arrays retain the user's explicit order. */
  readonly preferredSources?: readonly number[];
  readonly preferredLanguages?: readonly string[];
  readonly preferredTags?: readonly string[];
  readonly rankingMode?: "balanced" | "provider";
}

export interface MpcArtworkFilters {
  readonly minimumDpi: number;
  readonly maximumDpi: number;
  readonly sources: readonly number[];
  readonly includeTags: readonly string[];
  readonly excludeTags: readonly string[];
  readonly languages: readonly string[];
  readonly preferredSources: readonly number[];
  readonly preferredLanguages: readonly string[];
  readonly preferredTags: readonly string[];
  readonly rankingMode: "balanced" | "provider";
}

export interface MpcSourceOption {
  readonly id: number;
  readonly name: string;
  readonly sourceType: "Google Drive";
}

export interface MpcLanguageOption {
  readonly code: string;
  readonly name: string;
}

export interface MpcTagOption {
  readonly name: string;
}

export interface MpcFilterCatalogs {
  readonly sources: readonly MpcSourceOption[];
  readonly languages: readonly MpcLanguageOption[];
  readonly tags: readonly MpcTagOption[];
}

export class MpcArtworkFilterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpcArtworkFilterValidationError";
  }
}

export const MPC_FILTER_LIMITS = Object.freeze({
  maximumDpi: 10_000,
  sourceCount: 50,
  tagCount: 20,
  languageCount: 10,
  textLength: 80,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dpi(value: unknown, fallback: number, field: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0 || result > MPC_FILTER_LIMITS.maximumDpi) {
    throw new MpcArtworkFilterValidationError(`${field} must be an integer between 0 and ${MPC_FILTER_LIMITS.maximumDpi}.`);
  }
  return result;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new MpcArtworkFilterValidationError(`${field} must contain text values.`);
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase("en-US");
  if (!normalized || normalized.length > MPC_FILTER_LIMITS.textLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MpcArtworkFilterValidationError(`${field} contains an empty or invalid value.`);
  }
  return normalized;
}

function integerArray(value: unknown, field: string, maximumLength: number): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumLength) throw new MpcArtworkFilterValidationError(`${field} must be an array of at most ${maximumLength} values.`);
  const values = value.map((item) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      throw new MpcArtworkFilterValidationError(`${field} contains an invalid source ID.`);
    }
    return item;
  });
  return [...new Set(values)].sort((a, b) => a - b);
}

function orderedIntegerArray(value: unknown, field: string, maximumLength: number): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumLength) throw new MpcArtworkFilterValidationError(`${field} must be an array of at most ${maximumLength} values.`);
  const values = value.map((item) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      throw new MpcArtworkFilterValidationError(`${field} contains an invalid source ID.`);
    }
    return item;
  });
  return [...new Set(values)];
}

function stringArray(value: unknown, field: string, maximumLength: number, preserveOrder = false): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumLength) throw new MpcArtworkFilterValidationError(`${field} must be an array of at most ${maximumLength} values.`);
  const values = [...new Set(value.map((item) => stringValue(item, field)))];
  return preserveOrder ? values : values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export function normalizeMpcArtworkFilters(input: unknown): MpcArtworkFilters {
  if (!isRecord(input)) throw new MpcArtworkFilterValidationError("MPC filters must be a TCGPrint filter object.");
  const allowed = new Set([
    "minimumDpi", "maximumDpi", "sources", "includeTags", "excludeTags", "languages",
    "preferredSources", "preferredLanguages", "preferredTags", "rankingMode",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new MpcArtworkFilterValidationError("MPC filters contain an unsupported field.");

  const minimumDpi = dpi(input.minimumDpi, 0, "minimumDpi");
  const maximumDpi = dpi(input.maximumDpi, 1500, "maximumDpi");
  if (minimumDpi > maximumDpi) throw new MpcArtworkFilterValidationError("minimumDpi must not exceed maximumDpi.");
  const sources = integerArray(input.sources, "sources", MPC_FILTER_LIMITS.sourceCount);
  const includeTags = stringArray(input.includeTags, "includeTags", MPC_FILTER_LIMITS.tagCount);
  const excludeTags = stringArray(input.excludeTags, "excludeTags", MPC_FILTER_LIMITS.tagCount);
  if (includeTags.some((tag) => excludeTags.includes(tag))) throw new MpcArtworkFilterValidationError("A tag cannot be included and excluded at the same time.");
  const rankingMode = input.rankingMode === undefined ? "balanced" : input.rankingMode;
  if (rankingMode !== "balanced" && rankingMode !== "provider") throw new MpcArtworkFilterValidationError("rankingMode must be balanced or provider.");

  return {
    minimumDpi,
    maximumDpi,
    sources,
    includeTags,
    excludeTags,
    languages: stringArray(input.languages, "languages", MPC_FILTER_LIMITS.languageCount),
    preferredSources: orderedIntegerArray(input.preferredSources, "preferredSources", MPC_FILTER_LIMITS.sourceCount),
    preferredLanguages: stringArray(input.preferredLanguages, "preferredLanguages", MPC_FILTER_LIMITS.languageCount, true),
    preferredTags: stringArray(input.preferredTags, "preferredTags", MPC_FILTER_LIMITS.tagCount),
    rankingMode,
  };
}

function canonicalTagNames(values: readonly string[], tags: readonly MpcTagOption[], field: string): string[] {
  const byName = new Map(tags.map(({ name }) => [name.toLocaleLowerCase("en-US"), name]));
  return values.map((value) => {
    const canonical = byName.get(value.toLocaleLowerCase("en-US"));
    if (!canonical) throw new MpcArtworkFilterValidationError(`${field} contains a tag not present in the MPC catalog.`);
    return canonical;
  }).sort((left, right) => {
    const a = left.toLocaleLowerCase("en-US");
    const b = right.toLocaleLowerCase("en-US");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function validateMpcArtworkFiltersAgainstCatalogs(filters: MpcArtworkFilters, catalogs: MpcFilterCatalogs): MpcArtworkFilters {
  const sourceIds = new Set(catalogs.sources.map(({ id }) => id));
  for (const id of [...filters.sources, ...filters.preferredSources]) {
    if (!sourceIds.has(id)) throw new MpcArtworkFilterValidationError("A source ID is not present in the verified MPC catalog.");
  }
  const languageCodes = new Map(catalogs.languages.map(({ code }) => [code.toLocaleLowerCase("en-US"), code.toLocaleLowerCase("en-US")]));
  const canonicalLanguages = (values: readonly string[], field: string) => values.map((value) => {
    const canonical = languageCodes.get(value.toLocaleLowerCase("en-US"));
    if (!canonical) throw new MpcArtworkFilterValidationError(`${field} contains a language not present in the MPC catalog.`);
    return canonical;
  }).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const includeTags = canonicalTagNames(filters.includeTags, catalogs.tags, "includeTags");
  const excludeTags = canonicalTagNames(filters.excludeTags, catalogs.tags, "excludeTags");
  const preferredTags = canonicalTagNames(filters.preferredTags, catalogs.tags, "preferredTags");
  if (includeTags.some((tag) => excludeTags.some((excluded) => excluded.toLocaleLowerCase("en-US") === tag.toLocaleLowerCase("en-US")))) {
    throw new MpcArtworkFilterValidationError("A tag cannot be included and excluded at the same time.");
  }
  return {
    ...filters,
    includeTags,
    excludeTags,
    languages: canonicalLanguages(filters.languages, "languages"),
    preferredLanguages: filters.preferredLanguages.map((value) => {
      const canonical = languageCodes.get(value.toLocaleLowerCase("en-US"));
      if (!canonical) throw new MpcArtworkFilterValidationError("preferredLanguages contains a language not present in the MPC catalog.");
      return canonical;
    }),
    preferredTags,
    rankingMode: filters.rankingMode,
  };
}
