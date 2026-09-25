import { DOMParser } from "@xmldom/xmldom";
import { ImportFailureError } from "../errors";
import { resolveImportLimits } from "../limits";
import type { ImportKind, ImportLimits, ImportSource, ImportedAsset, ImportedEntry, ImportedFace, ImportWarning } from "../types";
import type { ImporterOutput } from "./types";

type ParsedXmlDocument = ReturnType<DOMParser["parseFromString"]>;
export type SafeXmlDocument = ParsedXmlDocument;
type SafeXmlElement = NonNullable<ParsedXmlDocument["documentElement"]>;

interface XmlTreeNode {
  readonly childNodes: {
    readonly length: number;
    item(index: number): XmlTreeNode | null;
  };
}

function readXmlText(input: Uint8Array | string): { readonly text: string; readonly byteLength: number } {
  if (typeof input === "string") return { text: input, byteLength: Buffer.byteLength(input, "utf8") };
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(input),
      byteLength: input.byteLength,
    };
  } catch (error) {
    throw new ImportFailureError("XML input must be valid UTF-8.", "INVALID_XML", undefined, undefined, { cause: error });
  }
}

function assertXmlBounds(document: ParsedXmlDocument, limits: ImportLimits): void {
  const root = document.documentElement;
  if (!root) {
    throw new ImportFailureError("XML document has no root element.", "INVALID_XML");
  }
  const stack: Array<{ readonly node: XmlTreeNode; readonly depth: number }> = [
    { node: root, depth: 1 },
  ];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > limits.maxXmlNodes) {
      throw new ImportFailureError(`XML exceeds the ${limits.maxXmlNodes} node limit.`, "INVALID_XML");
    }
    if (current.depth > limits.maxXmlDepth) {
      throw new ImportFailureError(`XML exceeds the depth limit of ${limits.maxXmlDepth}.`, "INVALID_XML");
    }
    for (let index = current.node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = current.node.childNodes.item(index);
      if (child) stack.push({ node: child, depth: current.depth + 1 });
    }
  }
}

/** Parses UTF-8 XML without DTDs, entity declarations, or external resolution. */
export function parseSafeXml(
  input: Uint8Array | string,
  overrides?: Partial<ImportLimits>,
): ParsedXmlDocument {
  const { text, byteLength } = readXmlText(input);
  const limits = resolveImportLimits(overrides);
  if (byteLength > limits.maxXmlBytes) {
    throw new ImportFailureError(
      `XML is ${byteLength} bytes; the configured limit is ${limits.maxXmlBytes} bytes.`,
      "INPUT_TOO_LARGE",
    );
  }

  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) {
    throw new ImportFailureError("XML DTD and entity declarations are blocked.", "XML_DTD_BLOCKED");
  }

  const parseErrors: string[] = [];
  let document: ParsedXmlDocument;
  try {
    document = new DOMParser({
      locator: false,
      onError: (level, message) => {
        parseErrors.push(message);
        if (level !== "warning") throw new Error(message);
      },
    }).parseFromString(text.replace(/^\uFEFF/, ""), "application/xml");
  } catch (error) {
    throw new ImportFailureError(
      `XML is not well formed. ${error instanceof Error ? error.message : "Parser error."}`,
      "INVALID_XML",
      undefined,
      undefined,
      { cause: error },
    );
  }

  if (!document.documentElement || parseErrors.length > 0) {
    throw new ImportFailureError(
      `XML is not well formed. ${parseErrors[0] ?? "The document has no root element."}`,
      "INVALID_XML",
    );
  }

  assertXmlBounds(document, limits);
  return document;
}

function elementChildren(parent: SafeXmlElement): SafeXmlElement[] {
  const children: SafeXmlElement[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);
    if (child?.nodeType === 1) children.push(child as unknown as SafeXmlElement);
  }
  return children;
}

function elementName(element: SafeXmlElement): string {
  return element.localName ?? element.nodeName;
}

function directChildren(parent: SafeXmlElement, localName: string): SafeXmlElement[] {
  return elementChildren(parent).filter((child) => elementName(child).toLowerCase() === localName.toLowerCase());
}

function directChild(parent: SafeXmlElement, localName: string): SafeXmlElement | undefined {
  return directChildren(parent, localName)[0];
}

function childText(parent: SafeXmlElement, localName: string): string | undefined {
  const value = directChild(parent, localName)?.textContent?.trim();
  return value || undefined;
}

function elementRecord(element: SafeXmlElement): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const child of elementChildren(element)) {
    const key = elementName(child);
    const text = child.textContent?.trim() ?? "";
    if (result[key] === undefined) result[key] = text;
    else result[key] = `${result[key]},${text}`;
  }
  return Object.freeze(result);
}

function xmlEntryBase(source: ImportSource, kind: ImportKind, metadata: Readonly<Record<string, unknown>>): ImportedEntry {
  return {
    id: `${source.id}:document`,
    kind: "document",
    order: source.order,
    quantity: 1,
    sourceId: source.id,
    sourceFilename: source.filename,
    sourcePath: source.sourcePath,
    metadata: Object.freeze({ parser: kind, ...metadata }),
  };
}

/** Valid XML is retained as a document entry when no format-specific adapter exists. */
export function importGenericXml(source: ImportSource, limitOverrides?: Partial<ImportLimits>): ImporterOutput {
  if (!source.originalBytes) {
    throw new ImportFailureError("XML import requires original source bytes.", "UNSUPPORTED_INPUT", source.id, source.sourcePath);
  }
  const document = parseSafeXml(source.originalBytes, limitOverrides);
  const root = document.documentElement;
  if (!root) throw new ImportFailureError("XML document has no root element.", "INVALID_XML", source.id, source.sourcePath);
  return {
    entries: [xmlEntryBase(source, "generic-xml", { rootName: elementName(root), rootAttributes: Object.freeze(
      Array.from({ length: root.attributes.length }, (_, index) => root.attributes.item(index))
        .filter((attribute): attribute is NonNullable<typeof attribute> => attribute !== null)
        .reduce<Record<string, string>>((all, attribute) => ({ ...all, [attribute.name]: attribute.value }), {}),
    ) })],
    warnings: [],
  };
}

interface MpcCardRecord {
  readonly side: "front" | "back";
  readonly ordinal: number;
  readonly slots: readonly string[];
  readonly quantity: number;
  readonly id?: string;
  readonly name?: string;
  readonly query?: string;
  readonly rawFields: Readonly<Record<string, string>>;
  readonly asset: ImportedAsset;
  readonly face: ImportedFace;
}

function parseSlotValues(card: SafeXmlElement, source: ImportSource, warnings: ImportWarning[], side: "front" | "back", ordinal: number): string[] {
  const plural = directChildren(card, "slots").map((element) => element.textContent?.trim() ?? "").filter(Boolean);
  const singular = directChildren(card, "slot").map((element) => element.textContent?.trim() ?? "").filter(Boolean);
  const split = (values: readonly string[]) => values.flatMap((value) => value.split(/[\s,]+/).map((slot) => slot.trim()).filter(Boolean));
  const pluralSlots = split(plural);
  const singularSlots = split(singular);
  if (pluralSlots.length > 0 && singularSlots.length > 0
    && (pluralSlots.length !== singularSlots.length || pluralSlots.some((slot, index) => slot !== singularSlots[index]))) {
    warnings.push({
      code: "AMBIGUOUS_MPC_SLOTS",
      message: `MPC ${side} card ${ordinal} has conflicting <slots> and <slot> values; <slots> is retained as the quantity source.`,
      sourceId: source.id,
      sourceFilename: source.filename,
      sourcePath: source.sourcePath,
    });
  }
  return pluralSlots.length > 0 ? pluralSlots : singularSlots;
}

function parseMpcCardRecords(
  container: SafeXmlElement | undefined,
  side: "front" | "back",
  source: ImportSource,
  cardback: string | undefined,
  warnings: ImportWarning[],
): MpcCardRecord[] {
  if (!container) return [];
  return directChildren(container, "card").map((card, index) => {
    const ordinal = index + 1;
    const slots = parseSlotValues(card, source, warnings, side, ordinal);
    const id = childText(card, "id");
    const name = childText(card, "name");
    const query = childText(card, "query");
    const explicitQuantity = childText(card, "quantity");
    const explicitQuantityValue = explicitQuantity ? Number(explicitQuantity) : undefined;
    const hasValidExplicitQuantity = explicitQuantityValue !== undefined
      && Number.isSafeInteger(explicitQuantityValue)
      && explicitQuantityValue > 0;
    const quantity = slots.length > 0
      ? slots.length
      : hasValidExplicitQuantity
        ? explicitQuantityValue
        : 1;
    if (explicitQuantity !== undefined && !hasValidExplicitQuantity) {
      warnings.push({
        code: "INVALID_MPC_QUANTITY",
        message: `MPC ${side} card ${ordinal} has an invalid quantity "${explicitQuantity}"; slots remain authoritative when present, otherwise quantity defaults to one.`,
        sourceId: source.id,
        sourceFilename: source.filename,
        sourcePath: source.sourcePath,
      });
    }
    if (slots.length === 0 && quantity === 1 && explicitQuantityValue === undefined) {
      warnings.push({
        code: "MPC_SLOTS_MISSING",
        message: `MPC ${side} card ${ordinal} has no slot or quantity; quantity defaults to one while the missing value is reported.`,
        sourceId: source.id,
        sourceFilename: source.filename,
        sourcePath: source.sourcePath,
      });
    } else if (hasValidExplicitQuantity && slots.length > 0 && explicitQuantityValue !== slots.length) {
      warnings.push({
        code: "MPC_QUANTITY_DIFFERS_FROM_SLOTS",
        message: `MPC ${side} card ${ordinal} quantity differs from its ${slots.length} slots; slots remain authoritative.`,
        sourceId: source.id,
        sourceFilename: source.filename,
        sourcePath: source.sourcePath,
      });
    }
    const rawFields = elementRecord(card);
    const assetId = `${source.id}:mpc:${side}:${ordinal}`;
    const asset: ImportedAsset = {
      id: assetId,
      sourceId: source.id,
      sourceFilename: source.filename,
      sourcePath: source.sourcePath,
      originalFormat: "mpc-artwork-reference",
      ...(id ? { providerAssetId: id, selectedArtworkId: id } : {}),
      metadata: Object.freeze({ rawFields, ...(cardback ? { cardback } : {}) }),
    };
    const face: ImportedFace = {
      side,
      asset,
      ...(id ? { providerAssetId: id, selectedArtworkId: id } : {}),
      ...(name ? { name } : {}),
      ...(query ? { query } : {}),
      slots,
      metadata: Object.freeze({ rawFields }),
    };
    return { side, ordinal, slots, quantity, ...(id ? { id } : {}), ...(name ? { name } : {}), ...(query ? { query } : {}), rawFields, asset, face };
  });
}

function entryForMpcCard(
  source: ImportSource,
  front: MpcCardRecord | undefined,
  backRecords: readonly MpcCardRecord[],
  cardback: string | undefined,
  cardbackAsset: ImportedAsset | undefined,
  details: Readonly<Record<string, string>>,
  warnings: ImportWarning[],
  order: number,
): ImportedEntry {
  const associatedBacks: MpcCardRecord[] = [];
  const associations = front?.slots.map((slot) => {
    const matches = backRecords.filter((record) => record.slots.includes(slot));
    if (matches.length !== 1) {
      if (matches.length > 1) warnings.push({
        code: "AMBIGUOUS_MPC_BACK_PAIRING",
        message: `MPC slot ${slot} matches multiple back records; no back association was guessed.`,
        sourceId: source.id,
        sourceFilename: source.filename,
        sourcePath: source.sourcePath,
      });
      return { slot, frontAssetId: front.asset.id };
    }
    const back = matches[0];
    associatedBacks.push(back);
    return { slot, frontAssetId: front.asset.id, backAssetId: back.asset.id };
  }) ?? [];
  const uniqueBacks = front
    ? [...new Map(associatedBacks.map((record) => [record.asset.id, record])).values()]
    : [...new Map(backRecords.map((record) => [record.asset.id, record])).values()];
  const primary = front ?? backRecords[0];
  const globalOrder = order;
  const faceList = [ ...(front ? [front.face] : []), ...uniqueBacks.map((record) => record.face) ];
  return {
    id: `${source.id}:mpc-entry:${globalOrder}`,
    kind: "mpc-order-card",
    order: source.order + globalOrder,
    quantity: primary?.quantity ?? 1,
    sourceId: source.id,
    sourceFilename: source.filename,
    sourcePath: source.sourcePath,
    ...(front?.name ? { nameSuggestion: front.name, cardHint: { name: front.name } } : {}),
    ...(front ? { front: front.face, slots: front.slots } : primary ? { slots: primary.slots } : {}),
    ...(cardbackAsset ? { cardbackAsset } : {}),
    ...(uniqueBacks.length === 1 ? { back: uniqueBacks[0].face } : {}),
    ...(faceList.length ? { faces: faceList } : {}),
    ...(associations.length ? { faceAssociations: associations } : {}),
    metadata: Object.freeze({
      parser: "mpc-autofill-xml",
      ...(front ? { originalFrontFields: front.rawFields } : primary ? { originalBackFields: primary.rawFields } : {}),
      ...(front ? { originalFrontOrder: front.ordinal } : {}),
      ...(cardback ? { cardback } : {}),
      ...(cardbackAsset ? { cardbackAsset } : {}),
      details,
    }),
  };
}

/** Imports the supplied MPC Autofill order XML. It never resolves or downloads artwork. */
export function importMpcAutofillXml(source: ImportSource, limitOverrides?: Partial<ImportLimits>): ImporterOutput {
  if (!source.originalBytes) {
    throw new ImportFailureError("MPC Autofill import requires original XML bytes.", "UNSUPPORTED_INPUT", source.id, source.sourcePath);
  }
  const document = parseSafeXml(source.originalBytes, limitOverrides);
  const root = document.documentElement;
  if (!root || elementName(root).toLowerCase() !== "order") {
    throw new ImportFailureError("Selected MPC Autofill XML must have an <order> root.", "FORMAT_MISMATCH", source.id, source.sourcePath);
  }

  const warnings: ImportWarning[] = [];
  const detailsElement = directChild(root, "details");
  const details = detailsElement ? elementRecord(detailsElement) : Object.freeze({});
  const cardback = childText(root, "cardback");
  const cardbackAsset: ImportedAsset | undefined = cardback ? {
    id: `${source.id}:mpc:cardback`,
    sourceId: source.id,
    sourceFilename: source.filename,
    sourcePath: source.sourcePath,
    originalFormat: "mpc-cardback-reference",
    providerAssetId: cardback,
    selectedArtworkId: cardback,
    metadata: Object.freeze({ rawValue: cardback }),
  } : undefined;
  const fronts = parseMpcCardRecords(directChild(root, "fronts"), "front", source, cardback, warnings);
  const backs = parseMpcCardRecords(directChild(root, "backs"), "back", source, cardback, warnings);
  const frontSlotCounts = new Map<string, number>();
  for (const record of fronts) for (const slot of record.slots) frontSlotCounts.set(slot, (frontSlotCounts.get(slot) ?? 0) + 1);

  const entries: ImportedEntry[] = [];
  fronts.forEach((front, index) => {
    const ambiguousFrontSlots = front.slots.filter((slot) => frontSlotCounts.get(slot) !== 1);
    for (const slot of ambiguousFrontSlots) warnings.push({
      code: "AMBIGUOUS_MPC_FRONT_SLOT",
      message: `MPC slot ${slot} is reused by multiple front records; no back association was guessed.`,
      sourceId: source.id,
      sourceFilename: source.filename,
      sourcePath: source.sourcePath,
    });
    const candidateBacks = backs.filter((back) => !ambiguousFrontSlots.some((slot) => back.slots.includes(slot)));
    entries.push(entryForMpcCard(source, front, candidateBacks, cardback, cardbackAsset, details, warnings, index));
  });

  const pairedBackIds = new Set(entries.flatMap((entry) => entry.faceAssociations?.map((association) => association.backAssetId).filter((id): id is string => Boolean(id)) ?? []));
  backs.forEach((back, index) => {
    if (!pairedBackIds.has(back.asset.id)) {
      entries.push(entryForMpcCard(source, undefined, [back], cardback, cardbackAsset, details, warnings, fronts.length + index));
    }
  });
  if (entries.length === 0) {
    entries.push({
      ...xmlEntryBase(source, "mpc-autofill-xml", { details, ...(cardback ? { cardback, cardbackAsset } : {}) }),
      ...(cardbackAsset ? { cardbackAsset } : {}),
    });
  }
  return { entries, warnings, metadata: Object.freeze({ details, ...(cardback ? { cardback, cardbackAsset } : {}) }) };
}
