import type { WorkingCard } from "./types";

export function formatResolutionSummary(
  cards: readonly Pick<WorkingCard, "identityResolution">[],
  providerHealth: Readonly<Record<string, { readonly degraded: boolean }>>,
): string {
  const counts = {
    resolved: cards.filter((card) => card.identityResolution.status === "resolved").length,
    suggested: cards.filter((card) => card.identityResolution.status === "suggested").length,
    ambiguous: cards.filter((card) => card.identityResolution.status === "ambiguous").length,
    unresolved: cards.filter((card) => card.identityResolution.status === "unresolved").length,
    custom: cards.filter((card) => card.identityResolution.status === "custom").length,
  };
  const parts: string[] = [];
  if (counts.resolved) parts.push(`${counts.resolved} ${counts.resolved === 1 ? "resolvida" : "resolvidas"}`);
  if (counts.suggested) parts.push(`${counts.suggested} ${counts.suggested === 1 ? "sugestão" : "sugestões"}`);
  if (counts.ambiguous) parts.push(`${counts.ambiguous} ${counts.ambiguous === 1 ? "ambígua" : "ambíguas"}`);
  if (counts.unresolved) parts.push(`${counts.unresolved} ${counts.unresolved === 1 ? "não resolvida" : "não resolvidas"}`);
  if (counts.custom) parts.push(`${counts.custom} ${counts.custom === 1 ? "custom" : "custom"}`);
  const summary = parts.length ? `Resolução: ${parts.join(", ")}.` : "Nenhuma entrada para resolver.";
  return providerHealth.scryfall?.degraded
    ? `${summary} Scryfall degradado; confira os itens não resolvidos.`
    : summary;
}
