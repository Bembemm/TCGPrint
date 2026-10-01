export { createDuplexPagePairing } from "./page-pairing";
export { calculateSharedPagePlacements } from "./shared-placement";
export type { SharedPagePlacementResult, SharedPlacementOptions } from "./shared-placement";
export { getDuplexPageReflectionMatrix, getDuplexPreviewOverlayMatrix, transformPointByDuplexMatrix } from "./page-reflection";
export type { DuplexPagePointMm, DuplexPageReflectionMatrix, DuplexPreviewSide } from "./page-reflection";
export { DuplexPairingError } from "./types";
export type {
  DuplexArtworkOrientation,
  DuplexBackPageTransform,
  DuplexFlipMode,
  DuplexPagePair,
  DuplexPagePairingOptions,
  DuplexPagePairingPlan,
  DuplexPairingErrorCode,
  DuplexReflectionAxis,
  DuplexSlotPair,
  DuplexSlotTransform,
} from "./types";
