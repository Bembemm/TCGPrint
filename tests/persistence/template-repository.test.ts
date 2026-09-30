import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openProjectDatabase } from "../../persistence/projects/database";
import { TemplateRepository } from "../../persistence/templates/repository";
import { calculateTemplatePackageHash, parseTemplateMetadata } from "../../templates/validation";
import type { TemplateMetadata } from "../../templates/types";

const now = "2026-09-30T10:00:00.000Z";
const fileBytes = new Uint8Array([0, 255, 1, 2]);
const fileHash = createHash("sha256").update(fileBytes).digest("hex");

function metadata(version: string): TemplateMetadata {
  return parseTemplateMetadata({
    name: "A4 Standard",
    source: "Alan Cha / SCM",
    version,
    paper: "a4",
    cardFormat: "standard",
    orientation: "landscape",
    recommendedBleedMm: 0.625,
    registrationType: "three-point",
  });
}

function files() {
  return [{
    relativePath: "template.studio3",
    fileName: "template.studio3",
    extension: "studio3" as const,
    mediaType: "application/octet-stream",
    contentHash: fileHash,
    byteLength: fileBytes.byteLength,
  }];
}

describe("template repository", () => {
  let database: ReturnType<typeof openProjectDatabase> | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("keeps immutable v5 and v6 versions with their exact metadata and associated files", () => {
    database = openProjectDatabase(":memory:");
    const repository = new TemplateRepository(database, {
      idFactory: (() => {
        const ids = ["template-1", "file-v5", "file-v6"];
        return () => ids.shift() ?? "unexpected-id";
      })(),
      now: () => now,
    });
    const v5 = metadata("v5");
    const v5Hash = calculateTemplatePackageHash(v5, [{ relativePath: "template.studio3", contentHash: fileHash, byteLength: 4 }]);
    const first = repository.addVersion({ metadata: v5, packageHash: v5Hash, files: files() });
    const v6 = metadata("v6");
    const v6Hash = calculateTemplatePackageHash(v6, [{ relativePath: "template.studio3", contentHash: fileHash, byteLength: 4 }]);
    const second = repository.addVersion({ templateId: first.templateId, metadata: v6, packageHash: v6Hash, files: files() });

    expect(repository.list()).toHaveLength(1);
    expect(repository.getVersion(first.templateId, "v5")).toMatchObject({ version: "v5", packageHash: v5Hash, paper: "a4" });
    expect(repository.getVersion(first.templateId, "v5")?.files[0]).toMatchObject({
      relativePath: "template.studio3",
      fileName: "template.studio3",
      contentHash: fileHash,
      byteLength: 4,
    });
    expect(second).toMatchObject({ templateId: first.templateId, created: true, version: { version: "v6", packageHash: v6Hash } });
  });

  it("treats a byte-identical same-version import as idempotent and rejects changed content", () => {
    database = openProjectDatabase(":memory:");
    const repository = new TemplateRepository(database, { idFactory: () => "template-1", now: () => now });
    const v5 = metadata("v5");
    const packageHash = calculateTemplatePackageHash(v5, [{ relativePath: "template.studio3", contentHash: fileHash, byteLength: 4 }]);
    const first = repository.addVersion({ metadata: v5, packageHash, files: files() });
    const repeated = repository.addVersion({ templateId: first.templateId, metadata: v5, packageHash, files: files() });

    expect(repeated).toMatchObject({ templateId: first.templateId, created: false, version: { packageHash } });
    const changedBytesHash = createHash("sha256").update(new Uint8Array([7, 7, 7])).digest("hex");
    const changedFiles = [{ ...files()[0]!, contentHash: changedBytesHash, byteLength: 3 }];
    const changedPackageHash = calculateTemplatePackageHash(v5, changedFiles.map(({ relativePath, contentHash, byteLength }) => ({ relativePath, contentHash, byteLength })));
    expect(() => repository.addVersion({
      templateId: first.templateId,
      metadata: v5,
      packageHash: changedPackageHash,
      files: changedFiles,
    })).toThrowError(expect.objectContaining({ code: "TEMPLATE_VERSION_CONFLICT" }));
    expect(repository.list()[0]?.versions).toHaveLength(1);
  });

  it("treats same-version imports with Unicode paths as idempotent despite database ordering", () => {
    database = openProjectDatabase(":memory:");
    const repository = new TemplateRepository(database, {
      idFactory: (() => { let index = 0; return () => `template-${++index}`; })(),
      now: () => now,
    });
    const v5 = metadata("v5");
    const dxfBytes = new TextEncoder().encode("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n");
    const dxfHash = createHash("sha256").update(dxfBytes).digest("hex");
    const unicodeFiles = [
      {
        relativePath: "𐀀.dxf",
        fileName: "𐀀.dxf",
        extension: "dxf" as const,
        mediaType: "application/dxf",
        contentHash: dxfHash,
        byteLength: dxfBytes.byteLength,
      },
      {
        relativePath: ".studio3",
        fileName: ".studio3",
        extension: "studio3" as const,
        mediaType: "application/octet-stream",
        contentHash: fileHash,
        byteLength: fileBytes.byteLength,
      },
    ];
    const packageHash = calculateTemplatePackageHash(v5, unicodeFiles.map(({ relativePath, contentHash, byteLength }) => ({ relativePath, contentHash, byteLength })));
    const first = repository.addVersion({ metadata: v5, packageHash, files: unicodeFiles });
    const sqliteOrder = (database.prepare("SELECT relative_path FROM template_files WHERE template_id = ? AND version = 'v5' ORDER BY relative_path")
      .all(first.templateId) as Array<{ relative_path: string }>).map(({ relative_path }) => relative_path);
    const javascriptOrder = [...unicodeFiles]
      .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
      .map(({ relativePath }) => relativePath);
    expect(sqliteOrder).toEqual([".studio3", "𐀀.dxf"]);
    expect(javascriptOrder).toEqual(["𐀀.dxf", ".studio3"]);
    expect(sqliteOrder).not.toEqual(javascriptOrder);

    const repeated = repository.addVersion({ templateId: first.templateId, metadata: v5, packageHash, files: unicodeFiles });

    expect(repeated).toMatchObject({ templateId: first.templateId, created: false, version: { packageHash } });
    const changedDxfHash = createHash("sha256").update(new Uint8Array([...dxfBytes, 0x20])).digest("hex");
    const changedFiles = unicodeFiles.map((file) => file.extension === "dxf"
      ? { ...file, contentHash: changedDxfHash, byteLength: dxfBytes.byteLength + 1 }
      : file);
    const changedPackageHash = calculateTemplatePackageHash(v5, changedFiles.map(({ relativePath, contentHash, byteLength }) => ({ relativePath, contentHash, byteLength })));
    expect(() => repository.addVersion({
      templateId: first.templateId,
      metadata: v5,
      packageHash: changedPackageHash,
      files: changedFiles,
    })).toThrowError(expect.objectContaining({ code: "TEMPLATE_VERSION_CONFLICT" }));
  });

  it("requires an existing logical template ID when adding a version and keeps names out of identity", () => {
    database = openProjectDatabase(":memory:");
    const repository = new TemplateRepository(database, {
      idFactory: (() => { let index = 0; return () => `template-${++index}`; })(),
      now: () => now,
    });
    const v5 = metadata("v5");
    const packageHash = calculateTemplatePackageHash(v5, [{ relativePath: "template.studio3", contentHash: fileHash, byteLength: 4 }]);
    const first = repository.addVersion({ metadata: v5, packageHash, files: files() });

    const v6 = metadata("v6");
    const v6Hash = calculateTemplatePackageHash(v6, [{ relativePath: "template.studio3", contentHash: fileHash, byteLength: 4 }]);
    expect(() => repository.addVersion({ templateId: "missing-template", metadata: v6, packageHash: v6Hash, files: files() }))
      .toThrowError(expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }));
    const separate = repository.addVersion({ metadata: v5, packageHash, files: files() });
    expect(separate.templateId).not.toBe(first.templateId);
    expect(repository.list()).toHaveLength(2);
  });

  it("rejects deletion while a canonical Project or recovery references any version", () => {
    database = openProjectDatabase(":memory:");
    const repository = new TemplateRepository(database, { idFactory: () => "template-1", now: () => now });
    const v5 = metadata("v5");
    const packageHash = calculateTemplatePackageHash(v5, [{ relativePath: "template.studio3", contentHash: fileHash, byteLength: 4 }]);
    const template = repository.addVersion({ metadata: v5, packageHash, files: files() });
    const timestamp = now;
    database.prepare(`INSERT INTO projects VALUES (?, ?, 1, 1, ?, ?, ?, ?)`)
      .run("project-1", "Project", '{"projectSchemaVersion":1}', timestamp, timestamp, timestamp);
    database.prepare(`INSERT INTO project_template_selections VALUES (?, ?, ?, ?)`)
      .run("project-1", template.templateId, "v5", packageHash);

    expect(() => repository.delete(template.templateId)).toThrowError(expect.objectContaining({ code: "TEMPLATE_REFERENCED" }));

    database.prepare(`DELETE FROM project_template_selections WHERE project_id = ?`).run("project-1");
    database.prepare(`INSERT INTO project_recovery VALUES (?, 1, 1, ?, ?)`)
      .run("project-1", '{"projectSchemaVersion":1}', timestamp);
    database.prepare(`INSERT INTO project_recovery_template_selections VALUES (?, ?, ?, ?)`)
      .run("project-1", template.templateId, "v5", packageHash);
    expect(() => repository.delete(template.templateId)).toThrowError(expect.objectContaining({ code: "TEMPLATE_REFERENCED" }));
  });

  it("deletes only unreferenced library records and exposes no filesystem path", () => {
    database = openProjectDatabase(":memory:");
    const repository = new TemplateRepository(database, { idFactory: () => "template-1", now: () => now });
    const v5 = metadata("v5");
    const packageHash = calculateTemplatePackageHash(v5, [{ relativePath: "template.studio3", contentHash: fileHash, byteLength: 4 }]);
    const template = repository.addVersion({ metadata: v5, packageHash, files: files() });

    expect(repository.getFile(template.version.files[0]!.fileId)).toMatchObject({ contentHash: fileHash, byteLength: 4 });
    expect(() => database!.prepare(`INSERT INTO template_files
      (file_id, template_id, version, relative_path, file_name, extension, media_type, content_hash, byte_length, created_at)
      VALUES ('bad-media-type', ?, 'v5', 'other.studio3', 'other.studio3', 'studio3', 'image/svg+xml', ?, 4, ?)`)
      .run(template.templateId, fileHash, now)).toThrow();
    expect(JSON.stringify(repository.list())).not.toContain("/home/agent");
    repository.delete(template.templateId);
    expect(repository.list()).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });
});
