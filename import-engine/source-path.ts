/** Validates a logical path supplied by an import UI. It is never a filesystem path. */
export function sanitizeRelativeImportPath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new TypeError("Import file path must be a string.");
  if (value.length > 1024) throw new RangeError("Import file path exceeds 1024 characters.");
  if (value.includes("\0") || /[\u0001-\u001f\u007f]/.test(value)) throw new TypeError("Import file path contains control characters.");

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) throw new TypeError("Import file path must be relative.");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) throw new TypeError("Import file path cannot contain parent-directory segments.");
  const path = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (path.length > 1024) throw new RangeError("Import file path exceeds 1024 characters.");
  return path || undefined;
}
