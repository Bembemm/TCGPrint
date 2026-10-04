import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "../cards/limits";
import { calculateGridPlacement, type GridPlacementMm, type GridPlacementRequest } from "./placement";

export interface GridPlacementPage {
  /** Zero-based page index in the document. */
  readonly pageIndex: number;
  /** Zero-based, inclusive index into the ordered physical card list. */
  readonly startCardIndex: number;
  /** Zero-based, exclusive index into the ordered physical card list. */
  readonly endCardIndex: number;
  readonly placement: GridPlacementMm;
}

export interface GridPagePlacementRequest {
  readonly placement: Omit<GridPlacementRequest, "count" | "bleedByCardMm">;
  readonly count: number;
  /** Effective per-card bleed in PDF card order; defaults to placement.bleedMm. */
  readonly bleedByCardMm?: readonly number[];
}

/**
 * Resolves the capacity grid once using the configured physical bleed, then
 * fixes its shape for every page, including the final partial page. Any
 * per-card bleed is still validated at its physical slot on each page.
 */
export function calculateGridPagePlacements(request: GridPagePlacementRequest): readonly GridPlacementPage[] {
  if (!Number.isSafeInteger(request.count) || request.count < 0 || request.count > MAX_PHYSICAL_CARDS_PER_EXPORT) {
    throw new RangeError(`A paginated layout must contain from 0 to ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards.`);
  }
  const bleedByCardMm = request.bleedByCardMm ?? Array.from({ length: request.count }, () => request.placement.bleedMm);
  if (bleedByCardMm.length !== request.count) {
    throw new RangeError("Per-card bleed values must contain one value per physical card in document order.");
  }
  if (!Number.isFinite(request.placement.bleedMm) || request.placement.bleedMm < 0) {
    throw new RangeError("Bleed must be a finite number greater than or equal to zero.");
  }
  if (request.placement.bleedMm > 3) throw new RangeError("Bleed must not exceed 3 mm.");

  for (const bleed of bleedByCardMm) {
    if (!Number.isFinite(bleed) || bleed < 0) throw new RangeError("Per-card bleed must be a finite number greater than or equal to zero.");
    if (bleed > 3) throw new RangeError("Bleed must not exceed 3 mm.");
  }
  const capacityGrid = calculateGridPlacement({
    ...request.placement,
    count: 0,
    bleedMm: request.placement.bleedMm,
  });
  if (request.count === 0) {
    return [{ pageIndex: 0, startCardIndex: 0, endCardIndex: 0, placement: capacityGrid }];
  }

  const pages: GridPlacementPage[] = [];
  const gridPlacement = {
    ...request.placement,
    rows: request.placement.rows ?? capacityGrid.rows,
    columns: request.placement.columns ?? capacityGrid.columns,
    bleedMm: request.placement.bleedMm,
  };
  let startCardIndex = 0;
  while (startCardIndex < request.count) {
    const remaining = request.count - startCardIndex;
    const maximumCandidate = Math.min(remaining, capacityGrid.capacity);
    let selectedPlacement: GridPlacementMm | undefined;
    let selectedCount = 0;

    for (let candidateCount = maximumCandidate; candidateCount > 0; candidateCount -= 1) {
      try {
        selectedPlacement = calculateGridPlacement({
          ...gridPlacement,
          count: candidateCount,
          bleedByCardMm: bleedByCardMm.slice(startCardIndex, startCardIndex + candidateCount),
        });
        selectedCount = candidateCount;
        break;
      } catch (error) {
        if (!(error instanceof RangeError)
          || !/card slots do not fit|no physical card slot fits|template has capacity/i.test(error.message)) {
          throw error;
        }
      }
    }

    if (!selectedPlacement) {
      calculateGridPlacement({
        ...gridPlacement,
        count: 1,
        bleedByCardMm: [bleedByCardMm[startCardIndex]!],
      });
      throw new RangeError("No physical card slot fits on the selected paper.");
    }
    pages.push({
      pageIndex: pages.length,
      startCardIndex,
      endCardIndex: startCardIndex + selectedCount,
      placement: selectedPlacement,
    });
    startCardIndex += selectedCount;
  }
  return Object.freeze(pages);
}
