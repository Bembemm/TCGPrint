export { createDuplexPagePairing } from "./page-pairing";
export { buildCanonicalPrintPlan, calculateSharedPagePlacements } from "./shared-placement";
export type { SharedPagePlacementResult, SharedPlacementOptions } from "./shared-placement";
export {
  getDuplexPageReflectionMatrix,
  getDuplexPhysicalBackPageMapping,
  getDuplexPreviewOverlayMatrix,
  getDuplexReflectionAxis,
  transformPhysicalPointByDuplexMatrix,
  transformPointByDuplexMatrix,
} from "./page-reflection";
export type { DuplexPagePointMm, DuplexPageReflectionMatrix, DuplexPhysicalBackPageMapping, DuplexPreviewSide } from "./page-reflection";
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
