import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openProjectDatabase } from "../../persistence/projects/database";
import { migrateProjectDatabase } from "../../persistence/projects/migrations";
import { ProjectRepository } from "../../persistence/projects/repository";
import { DEFAULT_PROJECT_SETTINGS, serializeProjectSnapshot } from "../../persistence/projects/serializer";
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

  it("keeps ZIP-shaped .studio3 files opaque inside template packages", async () => {
    const library = await setup();
    const opaqueStudio = makeSyntheticZip([{ name: "internal.studio3", bytes: studio }]);
    const packageBytes = makeSyntheticZip([{ name: "official.studio3", bytes: opaqueStudio }]);

    const created = await library.importTemplate(metadata, [{ fileName: "package.zip", bytes: packageBytes }]);

    expect(created.version.files.map(({ relativePath }) => relativePath).sort()).toEqual([
      "package.zip", "package.zip.contents/official.studio3",
    ]);
    const original = created.version.files.find(({ extension }) => extension === "studio3")!;
    expect(await library.readFile(original.fileId)).toEqual(opaqueStudio);
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

  it("applies ZIP entry and expanded-byte limits across all archives in one package", async () => {
    const countLibrary = await setup({ limits: { maxZipEntries: 1 } });
    const firstCountArchive = makeSyntheticZip([{ name: "template.studio3", bytes: studio }]);
    const secondCountArchive = makeSyntheticZip([{ name: "template.dxf", bytes: dxf }]);
    await expect(countLibrary.importTemplate(metadata, [
      { fileName: "first.zip", bytes: firstCountArchive },
      { fileName: "second.zip", bytes: secondCountArchive },
    ])).rejects.toMatchObject({ code: "TEMPLATE_UPLOAD_LIMIT" });
    expect(countLibrary.list()).toEqual([]);

    const byteLibrary = await setup({ limits: { maxZipTotalBytes: studio.byteLength * 2 - 1 } });
    await expect(byteLibrary.importTemplate(metadata, [
      { fileName: "first.zip", bytes: makeSyntheticZip([{ name: "template.studio3", bytes: studio }]) },
      { fileName: "second.zip", bytes: makeSyntheticZip([{ name: "template.studio3", bytes: studio }]) },
    ])).rejects.toMatchObject({ code: "TEMPLATE_PACKAGE_INVALID" });
    expect(byteLibrary.list()).toEqual([]);
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

  it("migrates and verifies a Phase 9 v2 custom template without inventing registration geometry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tcgprint-template-v2-"));
    directories.push(directory);
    const database = new Database(":memory:");
    databases.push(database);
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        project_schema_version INTEGER NOT NULL CHECK (project_schema_version >= 1),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        autosaved_at TEXT NOT NULL
      );
      CREATE TABLE project_recovery (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        project_schema_version INTEGER NOT NULL CHECK (project_schema_version >= 1),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE templates (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 180),
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
        source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 240),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE template_versions (
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        version TEXT NOT NULL CHECK (length(trim(version)) BETWEEN 1 AND 80),
        package_hash TEXT NOT NULL CHECK (length(package_hash) = 64 AND package_hash NOT GLOB '*[^0-9a-f]*'),
        paper TEXT NOT NULL CHECK (paper IN ('a4','a3','letter','legal','tabloid','custom')),
        card_format TEXT NOT NULL CHECK (card_format IN ('standard','poker','bridge','tarot','custom')),
        orientation TEXT NOT NULL CHECK (orientation IN ('portrait','landscape')),
        recommended_bleed_mm REAL CHECK (recommended_bleed_mm >= 0 AND recommended_bleed_mm <= 3),
        registration_type TEXT NOT NULL CHECK (registration_type IN ('three-point','four-point','custom','none')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (template_id, version),
        UNIQUE (template_id, version, package_hash)
      );
      CREATE TABLE template_files (
        file_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(file_id)) BETWEEN 1 AND 180),
        template_id TEXT NOT NULL,
        version TEXT NOT NULL,
        relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
        file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
        extension TEXT NOT NULL CHECK (extension IN ('studio3','dxf','svg','json','zip')),
        media_type TEXT NOT NULL CHECK (
          (extension = 'studio3' AND media_type = 'application/octet-stream' AND lower(file_name) GLOB '*.studio3') OR
          (extension = 'dxf' AND media_type = 'application/dxf' AND lower(file_name) GLOB '*.dxf') OR
          (extension = 'svg' AND media_type = 'image/svg+xml' AND lower(file_name) GLOB '*.svg') OR
          (extension = 'json' AND media_type = 'application/json' AND lower(file_name) GLOB '*.json') OR
          (extension = 'zip' AND media_type = 'application/zip' AND lower(file_name) GLOB '*.zip')
        ),
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
        byte_length INTEGER NOT NULL CHECK (byte_length > 0),
        created_at TEXT NOT NULL,
        UNIQUE (template_id, version, relative_path),
        FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version) ON DELETE CASCADE
      );
      CREATE INDEX template_files_version_idx ON template_files(template_id, version, relative_path);
      CREATE TABLE project_template_selections (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        version TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        FOREIGN KEY (template_id, version, package_hash)
          REFERENCES template_versions(template_id, version, package_hash) ON DELETE RESTRICT
      );
      CREATE TABLE project_recovery_template_selections (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES project_recovery(project_id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        version TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        FOREIGN KEY (template_id, version, package_hash)
          REFERENCES template_versions(template_id, version, package_hash) ON DELETE RESTRICT
      );
      PRAGMA user_version = 2;
    `);

    const name = "Fase 9 custom legacy";
    const source = "Local";
    const version = "v9";
    const fileName = "template.studio3";
    const contentHash = createHash("sha256").update(studio).digest("hex");
    const metadataV9 = { name, source, version, paper: "custom", cardFormat: "custom", orientation: "portrait", registrationType: "custom" };
    const packageHash = createHash("sha256").update(JSON.stringify({
      schema: 1,
      metadata: metadataV9,
      files: [{ relativePath: fileName, contentHash, byteLength: studio.byteLength }],
    }), "utf8").digest("hex");
    const selected = { templateId: "template-legacy", version, packageHash };
    const now = "2026-01-01T00:00:00.000Z";
    database.prepare("INSERT INTO projects VALUES (?, ?, 2, 1, ?, ?, ?, ?)")
      .run("project-legacy", "Legacy Project", serializeProjectSnapshot([], DEFAULT_PROJECT_SETTINGS), now, now, now);
    database.prepare("INSERT INTO templates VALUES (?, ?, ?, ?, ?)").run(selected.templateId, name, source, now, now);
    database.prepare(`INSERT INTO template_versions
      (template_id, version, package_hash, paper, card_format, orientation, recommended_bleed_mm, registration_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'custom', ?)`)
      .run(selected.templateId, version, packageHash, metadataV9.paper, metadataV9.cardFormat, metadataV9.orientation, now);
    database.prepare(`INSERT INTO template_versions
      (template_id, version, package_hash, paper, card_format, orientation, recommended_bleed_mm, registration_type, created_at)
      VALUES (?, 'v10', ?, 'a4', 'standard', 'portrait', NULL, 'none', ?)`)
      .run(selected.templateId, "a".repeat(64), now);
    database.prepare(`INSERT INTO template_files
      (file_id, template_id, version, relative_path, file_name, extension, media_type, content_hash, byte_length, created_at)
      VALUES (?, ?, ?, ?, ?, 'studio3', 'application/octet-stream', ?, ?, ?)`)
      .run("file-legacy", selected.templateId, version, fileName, fileName, contentHash, studio.byteLength, now);
    database.prepare("INSERT INTO project_template_selections VALUES (?, ?, ?, ?)")
      .run("project-legacy", selected.templateId, version, packageHash);

    expect(migrateProjectDatabase(database)).toBe(4);
    expect(database.prepare("SELECT paper, card_format, registration_type, registration_config_json, template_geometry_json FROM template_versions WHERE template_id = ? AND version = ?")
      .get(selected.templateId, version)).toEqual({ paper: "custom", card_format: "custom", registration_type: "custom", registration_config_json: null, template_geometry_json: null });
    const repository = new TemplateRepository(database);
    const store = new TemplateFileStore(join(directory, "template-originals"));
    await store.put(studio);
    const library = new TemplateLibraryService(repository, store);
    const inspection = await library.inspectSelection(selected);

    expect(library.list()).toHaveLength(1);
    expect(library.list()[0]!.versions.map(({ version }) => version)).toEqual(expect.arrayContaining(["v9", "v10"]));
    const listedLegacyVersion = library.list()[0]!.versions.find(({ version: listedVersion }) => listedVersion === "v9");
    expect(listedLegacyVersion).toMatchObject({ registrationType: "custom", packageHash });
    expect(listedLegacyVersion!.registrationConfig).toBeUndefined();
    expect(inspection).toMatchObject({ selection: selected, status: "available", version: { version: "v9", packageHash } });
    expect(new ProjectRepository(database).open("project-legacy").templateSelection).toEqual(selected);
    expect(database.prepare("SELECT template_id, version, package_hash FROM project_template_selections WHERE project_id = ?")
      .get("project-legacy")).toEqual({ template_id: selected.templateId, version, package_hash: packageHash });
  });
});
