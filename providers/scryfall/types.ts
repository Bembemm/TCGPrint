export interface ScryfallImageUris {
  readonly small?: string;
  readonly normal?: string;
  readonly large?: string;
  readonly png?: string;
  readonly artCrop?: string;
  readonly borderCrop?: string;
}

export interface ScryfallFace {
  readonly name: string;
  readonly manaCost?: string;
  readonly typeLine?: string;
  readonly oracleText?: string;
  readonly imageUris?: ScryfallImageUris;
}

export interface ScryfallRelatedCard {
  readonly id: string;
  readonly component: string;
  readonly name: string;
  readonly typeLine?: string;
}

export interface ScryfallCard {
  readonly id: string;
  readonly oracleId?: string;
  readonly name: string;
  readonly layout: string;
  readonly setCode?: string;
  readonly collectorNumber?: string;
  readonly lang?: string;
  readonly releasedAt?: string;
  readonly digital?: boolean;
  readonly promo?: boolean;
  readonly fullArt?: boolean;
  readonly borderColor?: string;
  readonly imageStatus?: string;
  readonly imageUris?: ScryfallImageUris;
  readonly faces: readonly ScryfallFace[];
  readonly relatedUris?: Readonly<Record<string, string>>;
  readonly relatedCards: readonly ScryfallRelatedCard[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ScryfallPrintingPage {
  readonly cards: readonly ScryfallCard[];
  readonly hasMore: boolean;
  readonly nextPage?: string;
}

export interface ScryfallDownloadedAsset {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sourceUrl: string;
  readonly kind: "thumbnail" | "original";
}

export type ScryfallLookupMode = "exact" | "fuzzy";
