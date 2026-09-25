const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|tiff?|avif|svg)$/i;
const BRACKETED_MARKER = /[\[(\{]\s*(?:mpc|custom|proxy|alt[\s_-]*art)\s*[\])\}]/gi;
const TRAILING_MARKER = /(?:[\s_-]+)(?:alt[\s_-]+art|custom|proxy)$/i;
const FACE_SUFFIX = /(?:[\s_-]+)(?:front|back)$/i;

/** Produces a search suggestion from a filename; it is not itself an identity. */
export function normalizeArtworkFilename(filename: string): string {
  let value = filename.split(/[\\/]/).pop() ?? "";
  value = value.replace(IMAGE_EXTENSION, "").replace(BRACKETED_MARKER, " ").trim();
  value = value.replace(/^\s*\d+\s*[x×]\s*/i, "");
  value = value.replace(/^\s*\d+\s*[-._]\s*/, "");
  let previous = "";
  while (previous !== value) {
    previous = value;
    value = value.replace(FACE_SUFFIX, "").replace(TRAILING_MARKER, "").trim();
  }
  return value
    .replace(/_/g, " ")
    .replace(/^[\s.\-_]+|[\s.\-_]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
