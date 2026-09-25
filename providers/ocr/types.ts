export interface OcrRecognizer {
  recognizeName(imageBytes: Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<string | undefined>;
  dispose?(): Promise<void>;
}

export interface OcrWorker {
  recognize(image: Uint8Array): Promise<{ readonly data: { readonly text?: string } }>;
  terminate(): Promise<unknown>;
}

export type OcrWorkerFactory = () => Promise<OcrWorker>;
