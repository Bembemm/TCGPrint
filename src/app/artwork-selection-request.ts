import type { CardFaceSide, WorkingCard } from "../../core/cards/types";

type ArtworkSelectionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function postArtworkSelection(
  card: WorkingCard,
  face: CardFaceSide,
  candidateId: string,
  fetcher: ArtworkSelectionFetch = fetch,
): Promise<Response> {
  return fetcher("/api/cards/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "select", card, faceId: face, candidateId }),
  });
}
