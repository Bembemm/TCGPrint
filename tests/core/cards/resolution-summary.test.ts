import { describe, expect, it } from "vitest";
import { formatResolutionSummary } from "../../../core/cards/resolution-summary";
import type { IdentityResolutionStatus, WorkingCard } from "../../../core/cards/types";

function entry(status: IdentityResolutionStatus): Pick<WorkingCard, "identityResolution"> {
  return { identityResolution: { status, candidates: [], confirmed: false } };
}

describe("resolution summary", () => {
  it("counts resolved, suggested, ambiguous and unresolved WorkingCards", () => {
    const cards = [entry("resolved"), entry("resolved"), entry("resolved"), entry("resolved"), entry("suggested"), entry("ambiguous"), entry("unresolved")];

    expect(formatResolutionSummary(cards, {})).toBe("Resolução: 4 resolvidas, 1 sugestão, 1 ambígua, 1 não resolvida.");
  });

  it("reports offline degradation alongside unresolved cards", () => {
    expect(formatResolutionSummary([entry("unresolved")], { scryfall: { degraded: true } }))
      .toBe("Resolução: 1 não resolvida. Scryfall degradado; confira os itens não resolvidos.");
  });
});
