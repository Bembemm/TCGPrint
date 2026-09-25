import type { ScryfallClient, ScryfallRequestOptions } from "../../providers/scryfall/client";
import { ScryfallError } from "../../providers/scryfall/errors";
import type { OcrRecognizer } from "../../providers/ocr/types";
import type { ScryfallCard } from "../../providers/scryfall/types";
import type { ArtworkCandidate, CardFaceSide, CardIdentity, IdentityResolutionCandidate, IdentityResolutionMethod, SelectedArtwork, WorkingCard } from "./types";
import { DEFAULT_ARTWORK_POLICY_ID, IDENTITY_RESOLUTION_POLICY } from "./identity-policy";
import { normalizeArtworkFilename } from "./filename-resolver";
import { fuzzyMatchName } from "./fuzzy-matcher";

export interface IdentityResolveOptions {
  readonly filename?: string;
  readonly imageBytes?: Uint8Array;
  readonly signal?: AbortSignal;
  readonly recognizer?: OcrRecognizer;
}

function toIdentity(card: ScryfallCard, method: IdentityResolutionMethod, confidence: number): CardIdentity {
  const id = card.oracleId ? `scryfall:oracle:${card.oracleId}` : `scryfall:card:${card.id}`;
  return {
    id,
    provider: "scryfall",
    name: card.name,
    scryfallId: card.id,
    ...(card.oracleId ? { oracleId: card.oracleId } : {}),
    ...(card.setCode ? { setCode: card.setCode } : {}),
    ...(card.collectorNumber ? { collectorNumber: card.collectorNumber } : {}),
    ...(card.lang ? { lang: card.lang } : {}),
    resolutionMethod: method,
    confidence,
    metadata: {
      layout: card.layout,
      digital: Boolean(card.digital),
      promo: Boolean(card.promo),
      fullArt: Boolean(card.fullArt),
      imageStatus: card.imageStatus,
      faces: card.faces.map((face) => ({ name: face.name })),
      relatedCards: card.relatedCards,
    },
  };
}

function result(card: WorkingCard, identity: CardIdentity | null, status: WorkingCard["identityResolution"]["status"], method: IdentityResolutionMethod | undefined, confidence?: number, candidates: readonly IdentityResolutionCandidate[] = []): WorkingCard {
  return {
    ...card,
    identity,
    identityResolution: {
      status,
      ...(method ? { method } : {}),
      ...(card.identityHints.name ? { query: card.identityHints.name } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      candidates,
      confirmed: false,
    },
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ScryfallError ? error.kind === "not-found" : Boolean(error && typeof error === "object" && (error as { kind?: string }).kind === "not-found");
}

function candidateResolution(card: ScryfallCard, score: number, reason: string): IdentityResolutionCandidate {
  return { identity: toIdentity(card, "fuzzy", score), score, reason };
}

function sortedDefaultCandidates(candidates: readonly ArtworkCandidate[]): readonly ArtworkCandidate[] {
  return candidates.filter((candidate) => candidate.source === "scryfall"
    && candidate.language === "en"
    && candidate.metadata?.digital !== true
    && candidate.metadata?.imageStatus === "highres_scan")
    .slice()
    .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "")
      || (a.setCode ?? "").localeCompare(b.setCode ?? "", "en")
      || (a.collectorNumber ?? "").localeCompare(b.collectorNumber ?? "", "en", { numeric: true })
      || (a.scryfallId ?? a.providerAssetId ?? a.id).localeCompare(b.scryfallId ?? b.providerAssetId ?? b.id));
}

function selected(candidate: ArtworkCandidate): SelectedArtwork {
  return {
    candidateId: candidate.id,
    source: candidate.source,
    identityId: candidate.identityId,
    faceId: candidate.faceId,
    ...(candidate.providerAssetId ? { providerAssetId: candidate.providerAssetId } : {}),
    ...(candidate.selectedArtworkId ? { selectedArtworkId: candidate.selectedArtworkId } : {}),
    selectionPolicy: DEFAULT_ARTWORK_POLICY_ID,
  };
}

export class IdentityResolver {
  private readonly client: ScryfallClient;

  constructor(client: ScryfallClient) {
    this.client = client;
  }

  async resolve(workingCard: WorkingCard, options: IdentityResolveOptions = {}): Promise<WorkingCard> {
    if (workingCard.identityResolution.confirmed) return workingCard;
    const requestOptions: ScryfallRequestOptions = { signal: options.signal };
    const hints = workingCard.identityHints;

    if (hints.scryfallId) {
      try {
        const card = await this.client.lookupById(hints.scryfallId, requestOptions);
        return result(workingCard, toIdentity(card, "scryfall-id", 1), "resolved", "scryfall-id", 1);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    if (hints.setCode && hints.collectorNumber) {
      try {
        const card = await this.client.lookupBySetCollector(hints.setCode, hints.collectorNumber, hints.language, requestOptions);
        return result(workingCard, toIdentity(card, "set-collector", 1), "resolved", "set-collector", 1);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    if (hints.name) {
      try {
        const card = await this.client.lookupByName(hints.name, "exact", requestOptions);
        return result(workingCard, toIdentity(card, "name", 1), "resolved", "name", 1);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    const filenameQuery = normalizeArtworkFilename(options.filename ?? workingCard.importSource.filename ?? "");
    if (filenameQuery) {
      try {
        const card = await this.client.lookupByName(filenameQuery, "exact", requestOptions);
        return result(workingCard, toIdentity(card, "filename", 0.99), "resolved", "filename", 0.99);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    let ocrQuery: string | undefined;
    if (options.imageBytes && options.recognizer) {
      try {
        ocrQuery = (await options.recognizer.recognizeName(options.imageBytes, { signal: options.signal }))?.trim() || undefined;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        ocrQuery = undefined;
      }
    }
    const query = ocrQuery ?? filenameQuery ?? hints.name;
    if (!query || query.length < IDENTITY_RESOLUTION_POLICY.minimumQueryLength) {
      return result(workingCard, null, workingCard.identityResolution.status === "custom" ? "custom" : "unresolved", undefined);
    }

    let cards: readonly ScryfallCard[];
    try {
      cards = await this.client.searchCards(`name:"${query.replaceAll('"', "\\\"")}"`, requestOptions);
    } catch (error) {
      if (isNotFound(error)) return result(workingCard, null, "unresolved", undefined);
      throw error;
    }
    const unique = [...new Map(cards.map((item) => [item.oracleId ?? item.id, item])).values()];
    const matching = fuzzyMatchName(query, unique, IDENTITY_RESOLUTION_POLICY);
    const method: IdentityResolutionMethod = ocrQuery ? "ocr" : filenameQuery ? "fuzzy" : "fuzzy";
    const resolutions = matching.candidates.map(({ candidate, score }) => candidateResolution(candidate, score, matching.reason));
    if (matching.status === "unresolved" || !matching.candidate) return result(workingCard, null, "unresolved", method);
    if (matching.status === "resolved" && !ocrQuery) {
      const exactMethod: IdentityResolutionMethod = filenameQuery ? "filename" : "name";
      return result(workingCard, toIdentity(matching.candidate, exactMethod, 1), "resolved", exactMethod, 1);
    }
    return result(workingCard, null, matching.status === "ambiguous" ? "ambiguous" : "suggested", method, matching.score, resolutions);
  }
}

export function confirmIdentity(workingCard: WorkingCard, candidate: CardIdentity): WorkingCard {
  return {
    ...workingCard,
    identity: candidate,
    identityResolution: { status: "resolved", method: "manual", query: candidate.name, confidence: 1, confirmed: true, candidates: [{ identity: candidate, score: 1, reason: "human-confirmed" }] },
  };
}

export function keepCustom(workingCard: WorkingCard): WorkingCard {
  return {
    ...workingCard,
    identity: null,
    identityResolution: { status: "custom", method: "custom", query: workingCard.identityResolution.query, candidates: [], confirmed: true },
  };
}

/** Applies one explicit default candidate per unselected face, without replacing uploads/MPC. */
export function selectDefaultArtwork(workingCard: WorkingCard, candidates: readonly ArtworkCandidate[]): WorkingCard {
  if (!workingCard.identity) return workingCard;
  const eligible = sortedDefaultCandidates(candidates).filter((candidate) => candidate.identityId === workingCard.identity?.id);
  const selectedArtworkByFace = { ...workingCard.selectedArtworkByFace };
  let changed = false;

  if (workingCard.identityHints.scryfallId) {
    for (const side of ["front", "back"] as const) {
      if (selectedArtworkByFace[side] || !workingCard.faces.some((face) => face.side === side)) continue;
      const printing = candidates.find((candidate) => candidate.source === "scryfall"
        && candidate.identityId === workingCard.identity?.id
        && candidate.faceId === side
        && candidate.originalAvailable
        && (candidate.scryfallId === workingCard.identityHints.scryfallId || candidate.providerAssetId === workingCard.identityHints.scryfallId));
      if (printing) { selectedArtworkByFace[side] = selected(printing); changed = true; }
    }
    return changed ? { ...workingCard, selectedArtworkByFace } : workingCard;
  }

  if (workingCard.identityHints.setCode && workingCard.identityHints.collectorNumber) {
    for (const side of ["front", "back"] as const) {
      if (selectedArtworkByFace[side] || !workingCard.faces.some((face) => face.side === side)) continue;
      const printing = candidates.find((candidate) => candidate.source === "scryfall"
        && candidate.identityId === workingCard.identity?.id
        && candidate.faceId === side
        && candidate.originalAvailable
        && candidate.setCode?.toLowerCase() === workingCard.identityHints.setCode?.toLowerCase()
        && candidate.collectorNumber === workingCard.identityHints.collectorNumber);
      if (printing) { selectedArtworkByFace[side] = selected(printing); changed = true; }
    }
    return changed ? { ...workingCard, selectedArtworkByFace } : workingCard;
  }

  if (workingCard.faces.some((face) => face.side === "front") && workingCard.faces.some((face) => face.side === "back")) {
    if (workingCard.identityResolution.method !== "name") return workingCard;
    const missingSides = (["front", "back"] as const).filter((side) => !selectedArtworkByFace[side]);
    if (!missingSides.length) return workingCard;
    const selectedScryfall = Object.values(selectedArtworkByFace).find((selection) => selection?.source === "scryfall");
    const selectedPrintingId = selectedScryfall?.providerAssetId ?? selectedScryfall?.candidateId.match(/^scryfall:([^:]+):/)?.[1];
    if (selectedPrintingId) {
      for (const side of missingSides) {
        const candidate = eligible.find((item) => item.faceId === side && item.originalAvailable
          && (item.scryfallId ?? item.providerAssetId) === selectedPrintingId);
        if (candidate) { selectedArtworkByFace[side] = selected(candidate); changed = true; }
      }
      return changed ? { ...workingCard, selectedArtworkByFace } : workingCard;
    }

    if (missingSides.length === 2) {
      const printings = new Map<string, ArtworkCandidate[]>();
      for (const candidate of eligible) {
        const id = candidate.scryfallId ?? candidate.providerAssetId ?? candidate.id;
        const printing = printings.get(id) ?? [];
        printing.push(candidate);
        printings.set(id, printing);
      }
      const ordered = [...printings.values()];
      const chosen = ordered.find((printing) => (["front", "back"] as const).every((side) => printing.some((candidate) => candidate.faceId === side && candidate.originalAvailable)))
        ?? ordered.find((printing) => printing.some((candidate) => candidate.originalAvailable));
      if (!chosen) return workingCard;
      for (const side of ["front", "back"] as const) {
        const candidate = chosen.find((item) => item.faceId === side && item.originalAvailable);
        if (candidate) { selectedArtworkByFace[side] = selected(candidate); changed = true; }
      }
      return changed ? { ...workingCard, selectedArtworkByFace } : workingCard;
    }

    const side = missingSides[0];
    const candidate = eligible.find((item) => item.faceId === side && item.originalAvailable);
    if (candidate) { selectedArtworkByFace[side] = selected(candidate); changed = true; }
    return changed ? { ...workingCard, selectedArtworkByFace } : workingCard;
  }

  for (const side of ["front", "back"] as const satisfies readonly CardFaceSide[]) {
    if (selectedArtworkByFace[side] || !workingCard.faces.some((face) => face.side === side)) continue;
    if (workingCard.identityResolution.method !== "name") continue;
    const defaultCandidate = eligible.find((candidate) => candidate.faceId === side && candidate.originalAvailable);
    if (defaultCandidate) { selectedArtworkByFace[side] = selected(defaultCandidate); changed = true; }
  }
  return changed ? { ...workingCard, selectedArtworkByFace } : workingCard;
}
