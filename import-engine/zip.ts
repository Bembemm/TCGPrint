import { createHash } from "node:crypto";
import * as yauzl from "yauzl";
import { ImportFailureError, ImportCancelledError } from "./errors";
import { detectImport } from "./detection";
import { resolveImportLimits } from "./limits";
import type { ImportError, ImportLimits, ImportProgress, ImportSource, UniversalImportOptions } from "./types";

export interface ZipExpansion {
  readonly sources: readonly ImportSource[];
  readonly errors: readonly ImportError[];
}

interface ZipState {
  readonly limits: ImportLimits;
  readonly options: UniversalImportOptions;
  readonly errors: ImportError[];
  nextOrder: number;
  entriesSeen: number;
  uncompressedBytes: number;
  stopEntries: boolean;
}

function domainError(error: ImportFailureError, source: ImportSource, path?: string): ImportError {
  return {
    code: error.code,
    message: error.message,
    severity: "error",
    sourceId: source.id,
    sourceFilename: source.filename,
    sourcePath: path ?? source.sourcePath,
  };
}

function failure(source: ImportSource, code: ImportFailureError["code"], message: string, path?: string): ImportError {
  return domainError(new ImportFailureError(message, code, source.id, path ?? source.sourcePath), source, path);
}

function bufferView(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bufferView(bytes)).digest("hex");
}

function safeZipPath(rawPath: string): { readonly path?: string; readonly reason?: string } {
  if (!rawPath || rawPath.includes("\0")) return { reason: "empty or NUL-containing entry name" };
  const path = rawPath.replace(/\\/g, "/");
  if (path.startsWith("/") || path.startsWith("//")) return { reason: "absolute paths are blocked" };
  if (/^[A-Za-z]:/.test(path)) return { reason: "Windows drive paths are blocked" };
  if (path.split("/").some((part) => part === "..")) return { reason: "parent traversal segments are blocked" };
  return { path };
}

function isSymlink(entry: yauzl.Entry): boolean {
  const unixMode = entry.externalFileAttributes >>> 16;
  return (unixMode & 0xf000) === 0xa000;
}

function emitProgress(options: UniversalImportOptions, progress: ImportProgress): void {
  if (options.signal?.aborted) throw new ImportCancelledError(progress.sourceId);
  options.onProgress?.(progress);
  if (options.signal?.aborted) throw new ImportCancelledError(progress.sourceId);
}

async function readEntryBytes(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  sourceId: string,
): Promise<Uint8Array> {
  const stream = await zip.openReadStreamPromise(entry, { decodeFileData: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        stream.destroy();
        throw new ImportCancelledError(sourceId);
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > maximumBytes) {
        stream.destroy();
        throw new ImportFailureError(`ZIP entry expanded beyond the configured ${maximumBytes} byte safety bound.`, "ZIP_SIZE_LIMIT");
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ImportFailureError) throw error;
    throw new ImportFailureError(
      `Could not read ZIP entry data. ${error instanceof Error ? error.message : "Entry stream failed."}`,
      "ZIP_INVALID",
      undefined,
      undefined,
      { cause: error },
    );
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

async function openZip(bytes: Uint8Array): Promise<yauzl.ZipFile> {
  try {
    return await yauzl.fromBufferPromise(bufferView(bytes), {
      autoClose: true,
      lazyEntries: true,
      // Ask yauzl for raw filename bytes so unsafe names can be reported entry by entry.
      // Its normal decode path aborts the whole archive before our per-entry path policy runs.
      decodeStrings: false,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (error) {
    throw new ImportFailureError(
      `ZIP archive is invalid. ${error instanceof Error ? error.message : "Could not read its central directory."}`,
      "ZIP_INVALID",
      undefined,
      undefined,
      { cause: error },
    );
  }
}

async function expandRecursive(source: ImportSource, state: ZipState, depth: number): Promise<ImportSource[]> {
  const bytes = source.originalBytes;
  if (!bytes) {
    state.errors.push(failure(source, "ZIP_INVALID", "ZIP source has no original bytes."));
    return [];
  }
  if (bytes.byteLength > state.limits.maxZipArchiveBytes) {
    state.errors.push(failure(source, "ZIP_SIZE_LIMIT", `ZIP archive exceeds ${state.limits.maxZipArchiveBytes} bytes.`));
    return [];
  }
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(bytes);
  } catch (error) {
    state.errors.push(error instanceof ImportFailureError ? domainError(error, source) : failure(source, "ZIP_INVALID", "ZIP archive could not be opened."));
    return [];
  }

  const expanded: ImportSource[] = [];
  let localCompleted = 0;
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const settle = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve();
    };
    zip.once("end", () => settle());
    zip.once("close", () => settle());
    zip.once("error", (error: Error) => {
      state.errors.push(failure(source, "ZIP_INVALID", `ZIP archive failed while reading entries. ${error.message}`));
      settle();
    });
    zip.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        if (state.stopEntries) {
          zip.readEntry();
          return;
        }
        localCompleted += 1;
        state.entriesSeen += 1;
        if (state.entriesSeen > state.limits.maxZipEntries) {
          state.errors.push(failure(source, "ZIP_ENTRY_LIMIT", `ZIP tree exceeds ${state.limits.maxZipEntries} entries.`, source.sourcePath));
          state.stopEntries = true;
          zip.close();
          settle();
          return;
        }
        const rawName = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
        const pathResult = safeZipPath(rawName);
        if (!pathResult.path) {
          state.errors.push(failure(source, "ZIP_UNSAFE_PATH", `Blocked ZIP entry "${rawName}": ${pathResult.reason}.`, rawName));
          emitProgress(state.options, { phase: "zip-entry", completed: localCompleted, total: zip.entryCount, sourceId: source.id, sourcePath: rawName });
          zip.readEntry();
          return;
        }
        const normalizedPath = pathResult.path;
        const unixMode = entry.externalFileAttributes >>> 16;
        const isDirectory = normalizedPath.endsWith("/") || (((entry.versionMadeBy >>> 8) & 0xff) === 3 && (unixMode & 0xf000) === 0x4000);
        if (isSymlink(entry)) {
          state.errors.push(failure(source, "ZIP_SYMLINK_BLOCKED", `Blocked symlink ZIP entry "${normalizedPath}".`, normalizedPath));
          emitProgress(state.options, { phase: "zip-entry", completed: localCompleted, total: zip.entryCount, sourceId: source.id, sourcePath: normalizedPath });
          zip.readEntry();
          return;
        }
        if (isDirectory) {
          emitProgress(state.options, { phase: "zip-entry", completed: localCompleted, total: zip.entryCount, sourceId: source.id, sourcePath: normalizedPath });
          zip.readEntry();
          return;
        }
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
          || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) {
          state.errors.push(failure(source, "ZIP_INVALID", `ZIP entry "${normalizedPath}" has an invalid declared size.`, normalizedPath));
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > state.limits.maxZipEntryBytes
          || state.uncompressedBytes + entry.uncompressedSize > state.limits.maxZipTotalUncompressedBytes) {
          state.errors.push(failure(source, "ZIP_SIZE_LIMIT", `ZIP entry "${normalizedPath}" exceeds the configured individual or aggregate uncompressed size limit.`, normalizedPath));
          emitProgress(state.options, { phase: "zip-entry", completed: localCompleted, total: zip.entryCount, sourceId: source.id, sourcePath: normalizedPath });
          zip.readEntry();
          return;
        }
        const ratio = entry.uncompressedSize === 0 ? 0
          : entry.compressedSize === 0 ? Number.POSITIVE_INFINITY
            : entry.uncompressedSize / entry.compressedSize;
        if (ratio > state.limits.maxZipCompressionRatio) {
          state.errors.push(failure(source, "ZIP_RATIO_LIMIT", `ZIP entry "${normalizedPath}" has compression ratio ${ratio.toFixed(1)}; limit is ${state.limits.maxZipCompressionRatio}.`, normalizedPath));
          emitProgress(state.options, { phase: "zip-entry", completed: localCompleted, total: zip.entryCount, sourceId: source.id, sourcePath: normalizedPath });
          zip.readEntry();
          return;
        }

        let childBytes: Uint8Array;
        try {
          const remaining = state.limits.maxZipTotalUncompressedBytes - state.uncompressedBytes;
          childBytes = await readEntryBytes(zip, entry, Math.min(state.limits.maxZipEntryBytes, remaining), state.options.signal, source.id);
        } catch (error) {
          if (error instanceof ImportCancelledError) throw error;
          const typed = error instanceof ImportFailureError
            ? error
            : new ImportFailureError("ZIP entry data is invalid.", "ZIP_INVALID", source.id, normalizedPath, { cause: error });
          state.errors.push(domainError(typed, source, normalizedPath));
          emitProgress(state.options, { phase: "zip-entry", completed: localCompleted, total: zip.entryCount, sourceId: source.id, sourcePath: normalizedPath });
          zip.readEntry();
          return;
        }
        state.uncompressedBytes += childBytes.byteLength;
        const childPath = source.sourcePath ? `${source.sourcePath}!/${normalizedPath}` : normalizedPath;
        const child: ImportSource = {
          id: `${source.id}!/${normalizedPath}#${localCompleted}`,
          kind: "zip-entry",
          filename: normalizedPath.split("/").pop() || normalizedPath,
          sourcePath: childPath,
          parentSourceId: source.id,
          order: state.nextOrder++,
          sizeBytes: childBytes.byteLength,
          originalBytes: childBytes,
          sha256: sha256(childBytes),
        };
        expanded.push(child);
        const detection = detectImport({ bytes: childBytes, fileName: child.filename });
        if (detection.selected?.kind === "zip") {
          if (depth >= state.limits.maxZipNestingDepth) {
            state.errors.push(failure(child, "ZIP_DEPTH_LIMIT", `Nested ZIP exceeds depth ${state.limits.maxZipNestingDepth}.`, childPath));
          } else {
            expanded.push(...await expandRecursive(child, state, depth + 1));
          }
        }
        emitProgress(state.options, { phase: "zip-entry", completed: localCompleted, total: zip.entryCount, sourceId: child.id, sourcePath: childPath });
        zip.readEntry();
      })().catch((error: unknown) => {
        zip.close();
        settle(error instanceof Error ? error : new Error("ZIP entry handling failed."));
      });
    });
    if (state.options.signal?.aborted) {
      zip.close();
      settle(new ImportCancelledError(source.id));
    } else zip.readEntry();
  });
  return expanded;
}

export async function expandZipSource(
  source: ImportSource,
  options: UniversalImportOptions = {},
): Promise<ZipExpansion> {
  const limits = resolveImportLimits(options.limits);
  const state: ZipState = {
    limits,
    options,
    errors: [],
    nextOrder: source.order + 0.000001,
    entriesSeen: 0,
    uncompressedBytes: 0,
    stopEntries: false,
  };
  const sources = await expandRecursive(source, state, 0);
  return { sources, errors: state.errors };
}
