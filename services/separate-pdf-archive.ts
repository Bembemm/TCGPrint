const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

export interface SeparatePdfArchiveEntry {
  readonly filename: "front.pdf" | "back.pdf" | "manifest.json";
  readonly bytes: Uint8Array;
}

/** Creates a bounded, uncompressed ZIP so both PDF members remain independently printable. */
export function createSeparatePdfArchive(entries: readonly SeparatePdfArchiveEntry[]): Uint8Array {
  if (entries.length !== 3 || new Set(entries.map(({ filename }) => filename)).size !== 3
    || !["front.pdf", "back.pdf", "manifest.json"].every((filename) => entries.some((entry) => entry.filename === filename))) {
    throw new TypeError("Separate PDF archive requires exactly front.pdf, back.pdf, and manifest.json.");
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.filename, "utf8");
    const data = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    if (data.byteLength > 0xffffffff) throw new RangeError("Separate PDF archive entry exceeds the ZIP32 size limit.");
    const crc = crc32(entry.bytes);
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21),
      u32(crc), u32(data.byteLength), u32(data.byteLength), u16(name.byteLength), u16(0), name,
    ]);
    localParts.push(header, data);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21),
      u32(crc), u32(data.byteLength), u32(data.byteLength), u16(name.byteLength), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += header.byteLength + data.byteLength;
    if (offset > 0xffffffff) throw new RangeError("Separate PDF archive exceeds the ZIP32 archive size limit.");
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDirectory.byteLength), u32(offset), u16(0),
  ]);
  return new Uint8Array(Buffer.concat([...localParts, centralDirectory, end]));
}
