import { ImportFailureError } from "../errors";
import { URL_ADAPTERS } from "./adapters";
import type { UrlAdapter, UrlAdapterResolution } from "./types";

interface KnownUrlSite {
  readonly id: string;
  readonly hosts: readonly string[];
  readonly message: string;
}

export const KNOWN_URL_SITES: readonly KnownUrlSite[] = Object.freeze([
  { id: "scryfall", hosts: ["scryfall.com"], message: "Este caminho do Scryfall ainda não tem adapter de importação." },
  { id: "moxfield", hosts: ["moxfield.com"], message: "Moxfield não está disponível para importação automatizada neste momento." },
  { id: "archidekt", hosts: ["archidekt.com"], message: "Este caminho do Archidekt ainda não tem adapter de importação." },
  { id: "cubecobra", hosts: ["cubecobra.com"], message: "Este caminho do CubeCobra ainda não tem adapter de importação." },
  { id: "deckstats", hosts: ["deckstats.net"], message: "Deckstats não está disponível para importação automatizada neste momento." },
  { id: "mtggoldfish", hosts: ["mtggoldfish.com"], message: "MTGGoldfish não está disponível para importação automatizada neste momento." },
  { id: "mtgtop8", hosts: ["mtgtop8.com"], message: "Este caminho do MTGTop8 ainda não tem adapter de importação." },
  { id: "tappedout", hosts: ["tappedout.net"], message: "TappedOut não está disponível para importação automatizada neste momento." },
  { id: "mtg-wtf", hosts: ["mtg.wtf"], message: "Este caminho do mtg.wtf ainda não tem adapter de importação." },
]);

function siteForHost(host: string): KnownUrlSite | undefined {
  return KNOWN_URL_SITES.find((site) => site.hosts.some((domain) => host === domain || host.endsWith(`.${domain}`)));
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new ImportFailureError("A entrada parece uma URL, mas seu formato é inválido.", "URL_INVALID", undefined, undefined, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImportFailureError("Somente URLs HTTP e HTTPS podem ser importadas.", "URL_UNSUPPORTED");
  }
  if (!url.hostname || url.username || url.password) {
    throw new ImportFailureError("URL inválida: informe um host público sem credenciais embutidas.", "URL_INVALID");
  }
  return url;
}

export function resolveUrlAdapter(
  value: string,
  adapters: readonly UrlAdapter[] = URL_ADAPTERS,
): UrlAdapterResolution {
  const url = parseHttpUrl(value);
  const host = url.hostname.toLowerCase();
  const hostAdapter = adapters.find((candidate) => candidate.hosts.some((candidateHost) => candidateHost.toLowerCase() === host));
  for (const adapter of adapters) {
    if (!adapter.hosts.some((candidate) => candidate.toLowerCase() === host)) continue;
    try {
      if (adapter.matches(url)) return { kind: "adapter", adapter };
    } catch {
      return {
        kind: "known-unsupported",
        siteId: adapter.id,
        message: `O adapter ${adapter.id} não conseguiu validar este caminho da URL.`,
      };
    }
  }

  const knownSite = siteForHost(host);
  if (knownSite || hostAdapter) {
    return {
      kind: "known-unsupported",
      siteId: hostAdapter?.id ?? knownSite!.id,
      message: hostAdapter
        ? `Este caminho ainda não é suportado pelo adapter ${hostAdapter.id}.`
        : knownSite!.message,
    };
  }

  return { kind: "direct-file" };
}
