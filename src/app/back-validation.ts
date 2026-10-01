import { fallbackToProjectDefaultBack, isDoubleFacedIdentity, resolveEffectiveCardBack } from "../../core/cards/back-selection";
import type { BackLibraryAssetReference, WorkingCard } from "../../core/cards/types";
import type { ExportContentMode, MissingBackPolicy } from "../../persistence/projects/serializer";

export interface BackValidationSummary {
  readonly dfcPhysicalCards: number;
  readonly simplePhysicalCards: number;
  readonly backs: { readonly auto: number; readonly projectDefault: number; readonly manual: number; readonly noneOrMissing: number };
  readonly missing: readonly { readonly cardId: string; readonly name: string; readonly copy: number; readonly reason: string }[];
  readonly warnings: readonly { readonly cardId: string; readonly name: string; readonly copy: number; readonly reason: string }[];
  readonly blockers: readonly { readonly cardId: string; readonly name: string; readonly copy: number; readonly reason: string }[];
}

/** Back-only reprints need resolved back artwork but do not depend on front artwork. */
export function exportModeRequiresFrontArtwork(mode: ExportContentMode): boolean {
  return mode !== "back-only";
}

export function resolveBackForMissingPolicy(
  card: WorkingCard,
  projectDefaultBack: BackLibraryAssetReference | null,
  missingBackPolicy: MissingBackPolicy,
) {
  const effective = resolveEffectiveCardBack(card, projectDefaultBack);
  return missingBackPolicy === "use-project-default"
    ? fallbackToProjectDefaultBack(card, effective, projectDefaultBack)
    : effective;
}

/** The UI preflight uses the same DFC/default policy as back export and preview. */
export function createBackValidationSummary(
  cards: readonly WorkingCard[],
  projectDefaultBack: BackLibraryAssetReference | null,
  missingBackPolicy: MissingBackPolicy,
): BackValidationSummary {
  const physicalCardCount = cards.reduce((sum, card) => sum + card.quantity, 0);
  const dfcPhysicalCards = cards.reduce((sum, card) => sum + (isDoubleFacedIdentity(card.identity) ? card.quantity : 0), 0);
  const summary = { auto: 0, projectDefault: 0, manual: 0, noneOrMissing: 0 };
  const missing: Array<{ cardId: string; name: string; copy: number; reason: string }> = [];
  for (const card of [...cards].sort((left, right) => left.order - right.order)) {
    const policyBack = resolveBackForMissingPolicy(card, projectDefaultBack, missingBackPolicy);
    for (let copy = 1; copy <= card.quantity; copy += 1) {
      if (policyBack.mode === "auto") summary.auto += 1;
      else if (policyBack.mode === "project-default") summary.projectDefault += 1;
      else if (policyBack.mode === "manual") summary.manual += 1;
      else summary.noneOrMissing += 1;
      if (policyBack.status !== "available") missing.push({
        cardId: card.id,
        name: card.identity?.name ?? card.identityHints.name ?? card.importSource.filename ?? "Carta custom",
        copy,
        reason: policyBack.status === "intentional-none"
          ? "verso explicitamente em branco"
          : isDoubleFacedIdentity(card.identity) && policyBack.mode === "auto"
            ? "face traseira da carta dupla-face ainda não foi resolvida"
            : "sem artwork de verso resolvida",
      });
    }
  }
  return {
    dfcPhysicalCards,
    simplePhysicalCards: physicalCardCount - dfcPhysicalCards,
    backs: summary,
    missing,
    warnings: missingBackPolicy === "warn-and-continue" || missingBackPolicy === "use-project-default" ? missing : [],
    blockers: missingBackPolicy === "block" ? missing : [],
  };
}
