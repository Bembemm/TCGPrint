import { describe, expect, it } from "vitest";
import { ImportFailureError } from "../../import-engine";
import { parseSafeXml } from "../../import-engine/importers/xml";

const encode = (xml: string) => new TextEncoder().encode(xml);

describe("safe XML parsing", () => {
  it("parses well formed XML without rewriting source bytes", () => {
    const bytes = encode("<deck><card name=\"Sol Ring\">1</card></deck>");
    const document = parseSafeXml(bytes);
    expect(document.documentElement?.localName).toBe("deck");
    expect(document.getElementsByTagName("card").item(0)?.getAttribute("name")).toBe("Sol Ring");
    expect(Buffer.from(bytes).toString("utf8")).toBe("<deck><card name=\"Sol Ring\">1</card></deck>");
  });

  it("blocks DOCTYPE and external entity declarations before parsing", () => {
    const xml = encode('<!DOCTYPE order [<!ENTITY local SYSTEM "file:///etc/passwd">]><order>&local;</order>');
    expect(() => parseSafeXml(xml)).toThrowError(expect.objectContaining({ code: "XML_DTD_BLOCKED" }));
  });

  it("returns a typed error for malformed XML instead of a partial tree", () => {
    expect(() => parseSafeXml(encode("<deck><card></deck>")))
      .toThrowError(expect.objectContaining({ code: "INVALID_XML" } satisfies Partial<ImportFailureError>));
  });

  it("does not resolve an undeclared external entity", () => {
    expect(() => parseSafeXml(encode('<deck>&external;</deck>')))
      .toThrowError(expect.objectContaining({ code: "INVALID_XML" }));
  });

  it("enforces XML byte, depth and node limits", () => {
    expect(() => parseSafeXml(encode("<deck />"), { maxXmlBytes: 4 }))
      .toThrowError(expect.objectContaining({ code: "INPUT_TOO_LARGE" }));
    expect(() => parseSafeXml(encode("<a><b><c /></b></a>"), { maxXmlDepth: 2 }))
      .toThrowError(expect.objectContaining({ code: "INVALID_XML" }));
    expect(() => parseSafeXml(encode("<a><b/><c/></a>"), { maxXmlNodes: 2 }))
      .toThrowError(expect.objectContaining({ code: "INVALID_XML" }));
  });
});
