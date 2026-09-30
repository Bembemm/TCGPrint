import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MAX_TEMPLATE_FILE_BYTES } from "./validation";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class TemplateFileStoreError extends Error {
  constructor(
    readonly code: "TEMPLATE_FILE_INVALID" | "TEMPLATE_FILE_TOO_LARGE" | "TEMPLATE_FILE_MISSING" | "TEMPLATE_FILE_CORRUPT" | "TEMPLATE_STORAGE_IO",
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TemplateFileStoreError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

function blobPath(rootDirectory: string, contentHash: string): string {
  if (!SHA256_PATTERN.test(contentHash)) {
    throw new TemplateFileStoreError("TEMPLATE_FILE_INVALID", "Template content hash must be a lowercase SHA-256 digest.");
  }
  return join(rootDirectory, contentHash.slice(0, 2), contentHash);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function readImmutableFile(path: string): Promise<Uint8Array> {
  let details;
  try { details = await lstat(path); } catch (error) {
    if (isMissing(error)) throw new TemplateFileStoreError("TEMPLATE_FILE_MISSING", "Template original file is missing.", error);
    throw new TemplateFileStoreError("TEMPLATE_STORAGE_IO", "Template original file could not be inspected.", error);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new TemplateFileStoreError("TEMPLATE_FILE_CORRUPT", "Template original path is not a regular file.");
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw new TemplateFileStoreError("TEMPLATE_FILE_CORRUPT", "Template original path is not a regular file.");
    return new Uint8Array(await handle.readFile());
  } catch (error) {
    if (error instanceof TemplateFileStoreError) throw error;
    if (isMissing(error) || (error as NodeJS.ErrnoException)?.code === "ELOOP") {
      throw new TemplateFileStoreError(isMissing(error) ? "TEMPLATE_FILE_MISSING" : "TEMPLATE_FILE_CORRUPT", "Template original file could not be read safely.", error);
    }
    throw new TemplateFileStoreError("TEMPLATE_STORAGE_IO", "Template original file could not be read.", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(path, 0o700);
  } catch (error) {
    throw new TemplateFileStoreError("TEMPLATE_STORAGE_IO", "Template original storage directory could not be created.", error);
  }
}

async function verifyExisting(path: string, contentHash: string, expectedByteLength: number): Promise<void> {
  const bytes = await readImmutableFile(path);
  if (bytes.byteLength !== expectedByteLength || digest(bytes) !== contentHash) {
    throw new TemplateFileStoreError("TEMPLATE_FILE_CORRUPT", "Existing template original does not match its content-addressed SHA-256 path.");
  }
}

/** Content-addressed immutable storage for non-image template originals. */
export class TemplateFileStore {
  private readonly rootDirectory: string;
  private readonly maximumBytes: number;

  constructor(rootDirectory: string, options: { readonly maximumBytes?: number } = {}) {
    this.rootDirectory = rootDirectory;
    this.maximumBytes = options.maximumBytes ?? MAX_TEMPLATE_FILE_BYTES;
  }

  async put(bytes: Uint8Array): Promise<{ readonly contentHash: string; readonly byteLength: number }> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TemplateFileStoreError("TEMPLATE_FILE_INVALID", "Template original must contain non-empty bytes.");
    }
    if (bytes.byteLength > this.maximumBytes) {
      throw new TemplateFileStoreError("TEMPLATE_FILE_TOO_LARGE", `Template original exceeds the ${this.maximumBytes} byte limit.`);
    }
    const contentHash = digest(bytes);
    const path = blobPath(this.rootDirectory, contentHash);
    const directory = join(this.rootDirectory, contentHash.slice(0, 2));
    await ensurePrivateDirectory(this.rootDirectory);
    await ensurePrivateDirectory(directory);
    const temporaryPath = join(directory, `${contentHash}.${randomUUID()}.tmp`);
    let temporaryHandle;
    try {
      temporaryHandle = await open(temporaryPath, "wx", 0o600);
      await temporaryHandle.writeFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        await verifyExisting(path, contentHash, bytes.byteLength);
      }
      return { contentHash, byteLength: bytes.byteLength };
    } catch (error) {
      if (error instanceof TemplateFileStoreError) throw error;
      throw new TemplateFileStoreError("TEMPLATE_STORAGE_IO", "Template original could not be stored atomically.", error);
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    }
  }

  async get(contentHash: string, expectedByteLength?: number): Promise<Uint8Array> {
    const bytes = await readImmutableFile(blobPath(this.rootDirectory, contentHash));
    if (digest(bytes) !== contentHash || (expectedByteLength !== undefined && bytes.byteLength !== expectedByteLength)) {
      throw new TemplateFileStoreError("TEMPLATE_FILE_CORRUPT", "Template original failed its byte-length or SHA-256 integrity check.");
    }
    return bytes;
  }
}
