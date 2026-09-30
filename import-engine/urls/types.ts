import type { ImportWarning, ImportedEntry } from "../types";

export interface UrlAdapterContext {
  readonly fetchImpl?: typeof fetch;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly sourceId?: string;
}

export type UrlAdapterResult =
  | {
      readonly kind: "source";
      readonly filename: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
      readonly sourceUrl: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "entries";
      readonly entries: readonly ImportedEntry[];
      readonly warnings?: readonly ImportWarning[];
      readonly sourceUrl: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    };

export interface UrlAdapter {
  readonly id: string;
  readonly hosts: readonly string[];
  matches(url: URL): boolean;
  import(url: URL, context: UrlAdapterContext): Promise<UrlAdapterResult>;
}

export type UrlAdapterResolution =
  | { readonly kind: "adapter"; readonly adapter: UrlAdapter }
  | { readonly kind: "known-unsupported"; readonly siteId: string; readonly message: string }
  | { readonly kind: "direct-file" };
