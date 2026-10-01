import type { GridPlacementPage } from "../geometry/page-placement";
import type { CardSlotMm, GridPlacementMm } from "../geometry/placement";
import type { PageOrientation } from "../geometry";

export type DuplexFlipMode = "long-edge" | "short-edge";
export type DuplexReflectionAxis = "x" | "y";

export interface DuplexArtworkOrientation {
  /** Back artwork is printed as supplied so its text reads normally from the back side. */
  readonly rotationDegrees: 0;
  readonly mirrorX: false;
  readonly mirrorY: false;
}

export interface DuplexSlotTransform {
  readonly reflectionAxis: DuplexReflectionAxis;
  readonly pageWidthMm: number;
  readonly pageHeightMm: number;
}

export interface DuplexSlotPair {
  /** Slot identity on the front side before the sheet is turned. */
  readonly frontSlotIndex: number;
  /** Slot identity seen while facing the back side of the sheet. */
  readonly backSlotIndex: number;
  /** Page-local input index into the same physical copy list on both sides. */
  readonly cardIndex?: number;
  /** Zero-based physical copy index across the whole document. */
  readonly physicalCardIndex?: number;
  readonly skippedByUser: boolean;
  readonly reserved: boolean;
  readonly front: CardSlotMm;
  readonly back: CardSlotMm;
}

export interface DuplexPagePair {
  readonly frontPageIndex: number;
  readonly backPageIndex: number;
  /** One-based logical page numbers in each independently printable PDF. */
  readonly frontPageNumber: number;
  readonly backPageNumber: number;
  readonly pageOrientation: PageOrientation;
  readonly flipMode: DuplexFlipMode;
  readonly reflectionAxis: DuplexReflectionAxis;
  readonly slotTransform: DuplexSlotTransform;
  readonly backArtworkOrientation: DuplexArtworkOrientation;
  readonly slots: readonly DuplexSlotPair[];
  readonly frontPlacement: GridPlacementPage;
  readonly backPlacement: GridPlacementPage;
}

export interface DuplexPagePairingOptions {
  readonly pageOrientation: PageOrientation;
  readonly flipMode: DuplexFlipMode;
}

export interface DuplexPagePairingPlan {
  readonly pageOrientation: PageOrientation;
  readonly flipMode: DuplexFlipMode;
  readonly pagePairs: readonly DuplexPagePair[];
}

export type DuplexPairingErrorCode = "INVALID_DUPLEX_FLIP" | "DUPLEX_PAIRING_FAILED";

export class DuplexPairingError extends Error {
  readonly code: DuplexPairingErrorCode;

  constructor(code: DuplexPairingErrorCode, message: string) {
    super(message);
    this.name = "DuplexPairingError";
    this.code = code;
  }
}

export type { GridPlacementMm };
