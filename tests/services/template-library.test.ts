import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDatabase } from "../../persistence/projects/database";
import { TemplateRepository } from "../../persistence/templates/repository";
import { makeSyntheticZip } from "../helpers/zip";
import { TemplateFileStore } from "../../templates/file-store";
import { TemplateLibraryService } from "../../services/template-library";

const studio = new Uint8Array([0, 255, 1, 2, 128, 13, 10, 0]);
const dxf = new TextEncoder().encode("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n");
const metadata = {
  name: "Alan A4 Standard",
  source: "Local",
  version: "5",
  paper: "a4" as const,
  cardFormat: "standard" as const,
  orientation: "portrait" as const,
  recommendedBleedMm: 0.625,
  registrationType: "three-point" as const,
};

describe("template library service", () => {
  const directories: string[] = [];
  const databases: Array<ReturnType<typeof openProjectDatabase>> = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function setup(options: ConstructorParameters<typeof TemplateLibraryService>[2] = {}) {
    const directory = await mkdtemp(join(tmpdir(), "tcgprint-template-library-"));
    directories.push(directory);
    const database = openProjectDatabase(join(directory, "projects.sqlite"));
    databases.push(database);
    const repository = new TemplateRepository(database, { idFactory: (() => { let value = 0; return () => `template-${++value}`; })() });
    const store = new TemplateFileStore(join(directory, "template-originals"), { maximumBytes: 8 * 1024 * 1024 });
    return new TemplateLibraryService(repository, store, options);
  }

  it("stores .studio3 opaquely, preserves its exact bytes/hash, and keeps metadata separate", async () => {
    const library = await setup();
    const created = await library.importTemplate(metadata, [{ fileName: "template.studio3", bytes: studio }]);
    const file = created.version.files[0]!;

    expect(file.contentHash).toBe(createHash("sha256").update(studio).digest("hex"));
    expect(await library.readFile(file.fileId)).toEqual(studio);
    expect(await readFile(join(directories.at(-1)!, "template-originals", file.contentHash.slice(0, 2), file.contentHash))).toEqual(Buffer.from(studio));
    expect(created.version).toMatchObject({ name: metadata.name, version: "5", packageHash: created.version.packageHash });
  });

  it("associates raw ZIP and extracted template files while preserving all input bytes", async () => {
    const library = await setup();
    const packageBytes = makeSyntheticZip([
      { name: "template.studio3", bytes: studio },
      { name: "template.dxf", bytes: dxf },
      { name: "template.json", bytes: new TextEncoder().encode('{"units":"mm"}') },
    ]);
    const created = await library.importTemplate(metadata, [{ fileName: "alan-a4.zip", bytes: packageBytes }]);

    expect(created.version.files.map(({ relativePath }) => relativePath).sort()).toEqual([
      "alan-a4.zip", "alan-a4.zip.contents/template.dxf", "alan-a4.zip.contents/template.json", "alan-a4.zip.contents/template.studio3",
    ]);
    const archive = created.version.files.find(({ extension }) => extension === "zip")!;
    const originalStudio = created.version.files.find(({ extension }) => extension === "studio3")!;
    expect(await library.readFile(archive.fileId)).toEqual(packageBytes);
    expect(await library.readFile(originalStudio.fileId)).toEqual(studio);
    expect(created.version.packageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ingests valid DXF, SVG and JSON as associated immutable originals with per-file SHA-256", async () => {
    const library = await setup();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><path d="M0 0"/></svg>');
    const json = new TextEncoder().encode('{"name":"Alan A4","units":"mm"}');
    const inputs = [
      { fileName: "template.studio3", bytes: studio },
      { fileName: "template.dxf", bytes: dxf },
      { fileName: "template.svg", bytes: svg },
      { fileName: "template.json", bytes: json },
    ];

    const created = await library.importTemplate(metadata, inputs);

    expect(created.version.files.map(({ extension }) => extension).sort()).toEqual(["dxf", "json", "studio3", "svg"]);
    for (const file of created.version.files) {
      const input = inputs.find(({ fileName }) => fileName === file.fileName)!;
      expect(file.contentHash).toBe(createHash("sha256").update(input.bytes).digest("hex"));
      expect(await library.readFile(file.fileId)).toEqual(input.bytes);
    }
  });

  it("keeps an existing version intact after a same-version content conflict and leaves blobs after metadata deletion", async () => {
    const library = await setup();
    const first = await library.importTemplate(metadata, [{ fileName: "template.studio3", bytes: studio }]);
    const changed = new Uint8Array([...studio, 9]);

    await expect(library.importTemplate(metadata, [{ fileName: "template.studio3", bytes: changed }], first.templateId))
      .rejects.toMatchObject({ code: "TEMPLATE_VERSION_CONFLICT" });
    expect(await library.readFile(first.version.files[0]!.fileId)).toEqual(studio);
    library.remove(first.templateId);
    expect(await readFile(join(directories.at(-1)!, "template-originals", first.version.files[0]!.contentHash.slice(0, 2), first.version.files[0]!.contentHash)))
      .toEqual(Buffer.from(studio));
  });

  it.each([
    ["path traversal", [{ name: "../escape.studio3", bytes: studio }]],
    ["symlink", [{ name: "template.studio3", bytes: studio, symlink: true }]],
  ] as const)("rejects ZIP %s without changing existing templates", async (_label, entries) => {
    const library = await setup();
    const good = await library.importTemplate(metadata, [{ fileName: "template.studio3", bytes: studio }]);
    const before = library.list();
    const unsafe = makeSyntheticZip(entries);

    await expect(library.importTemplate({ ...metadata, version: "6" }, [{ fileName: "unsafe.zip", bytes: unsafe }]))
      .rejects.toMatchObject({ code: "TEMPLATE_PACKAGE_INVALID" });
    expect(library.list()).toEqual(before);
    expect((await library.readFile(good.version.files[0]!.fileId))).toEqual(studio);
  });

  it("rejects ZIP count, expanded size, compression ratio, oversize archive, and nested ZIP limits", async () => {
    const countLibrary = await setup({ limits: { maxZipEntries: 1 } });
    const tooMany = makeSyntheticZip([{ name: "a.studio3", bytes: studio }, { name: "b.dxf", bytes: dxf }]);
    await expect(countLibrary.importTemplate(metadata, [{ fileName: "too-many.zip", bytes: tooMany }])).rejects.toMatchObject({ code: "TEMPLATE_PACKAGE_INVALID" });

    const expandedLibrary = await setup({ limits: { maxZipTotalBytes: 8 } });
    await expect(expandedLibrary.importTemplate(metadata, [{ fileName: "expanded.zip", bytes: makeSyntheticZip([{ name: "template.dxf", bytes: dxf }]) }]))
      .rejects.toMatchObject({ code: "TEMPLATE_PACKAGE_INVALID" });

    const ratioLibrary = await setup({ limits: { maxZipCompressionRatio: 2 } });
    const ratio = makeSyntheticZip([{ name: "repeat.studio3", bytes: new Uint8Array(5000).fill(7), compression: "deflate" }]);
    await expect(ratioLibrary.importTemplate(metadata, [{ fileName: "ratio.zip", bytes: ratio }])).rejects.toMatchObject({ code: "TEMPLATE_PACKAGE_INVALID" });

    const archiveLibrary = await setup({ limits: { maxArchiveBytes: 64 } });
    await expect(archiveLibrary.importTemplate(metadata, [{ fileName: "too-large.zip", bytes: new Uint8Array(65).fill(0) }]))
      .rejects.toMatchObject({ code: "TEMPLATE_FILE_TOO_LARGE" });

    const nestedLibrary = await setup();
    const nested = makeSyntheticZip([{ name: "inner.studio3", bytes: studio }]);
    const outer = makeSyntheticZip([{ name: "nested.zip", bytes: nested }]);
    await expect(nestedLibrary.importTemplate(metadata, [{ fileName: "nested-package.zip", bytes: outer }])).rejects.toMatchObject({ code: "TEMPLATE_PACKAGE_INVALID" });

    await expect(nestedLibrary.importTemplate(metadata, [{ fileName: "empty-package.zip", bytes: makeSyntheticZip([]) }]))
      .rejects.toMatchObject({ code: "TEMPLATE_PACKAGE_INVALID" });
  });

  it("rejects invalid metadata, malformed SVG/DXF/JSON and oversized associated files", async () => {
    const library = await setup({ limits: { maxFileBytes: 10 } });
    await expect(library.importTemplate({ ...metadata, recommendedBleedMm: 9 }, [{ fileName: "template.svg", bytes: new TextEncoder().encode("<svg/>") }]))
      .rejects.toMatchObject({ code: "TEMPLATE_METADATA_INVALID" });
    await expect(library.importTemplate(metadata, [{ fileName: "template.svg", bytes: new TextEncoder().encode("<svg><g>") }]))
      .rejects.toMatchObject({ code: "TEMPLATE_FILE_INVALID" });
    await expect(library.importTemplate(metadata, [{ fileName: "template.dxf", bytes: new TextEncoder().encode("not dxf") }]))
      .rejects.toMatchObject({ code: "TEMPLATE_FILE_INVALID" });
    await expect(library.importTemplate(metadata, [{ fileName: "template.json", bytes: new TextEncoder().encode("{") }]))
      .rejects.toMatchObject({ code: "TEMPLATE_FILE_INVALID" });
    await expect(library.importTemplate(metadata, [{ fileName: "template.studio3", bytes: new Uint8Array(11).fill(8) }]))
      .rejects.toMatchObject({ code: "TEMPLATE_FILE_TOO_LARGE" });
  });

  it("enforces upload-count and combined raw-byte limits", async () => {
    const countLibrary = await setup({ limits: { maxUploadFiles: 1 } });
    await expect(countLibrary.importTemplate(metadata, [
      { fileName: "one.studio3", bytes: studio },
      { fileName: "two.dxf", bytes: dxf },
    ])).rejects.toMatchObject({ code: "TEMPLATE_UPLOAD_LIMIT" });

    const totalLibrary = await setup({ limits: { maxTotalUploadBytes: 10 } });
    await expect(totalLibrary.importTemplate(metadata, [
      { fileName: "template.studio3", bytes: studio },
      { fileName: "another.studio3", bytes: studio },
    ])).rejects.toMatchObject({ code: "TEMPLATE_UPLOAD_LIMIT" });
  });

  it.each(["missing", "corrupt"] as const)("reports a %s original without replacing the selected version", async (failure) => {
    const library = await setup();
    const created = await library.importTemplate(metadata, [{ fileName: "template.studio3", bytes: studio }]);
    const selected = { templateId: created.templateId, version: created.version.version, packageHash: created.version.packageHash };
    const file = created.version.files[0]!;
    const originalPath = join(directories.at(-1)!, "template-originals", file.contentHash.slice(0, 2), file.contentHash);
    if (failure === "missing") await rm(originalPath);
    else await writeFile(originalPath, Buffer.from([1, 2, 3]));

    const inspection = await library.inspectSelection(selected);

    expect(inspection).toMatchObject({ selection: selected, status: failure });
    expect(library.list()[0]?.versions[0]?.version).toBe("5");
    expect(await library.inspectSelection({ ...selected, packageHash: "f".repeat(64) })).toMatchObject({ status: "hash-mismatch", selection: { packageHash: "f".repeat(64) } });
  });

  it("reports a removed template reference as missing and keeps the recorded identity", async () => {
    const library = await setup();
    const selection = { templateId: "removed-template", version: "5", packageHash: "5".repeat(64) };

    expect(await library.inspectSelection(selection)).toMatchObject({ selection, status: "missing", version: null, files: [] });
  });
});
