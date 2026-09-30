import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDatabase } from "../../persistence/projects/database";
import { ProjectRepository } from "../../persistence/projects/repository";
import { TemplateRepository } from "../../persistence/templates/repository";
import { TemplateFileStore } from "../../templates/file-store";
import { TemplateLibraryService } from "../../services/template-library";
import {
  handleTemplateDelete,
  handleTemplateFileDownload,
  handleTemplateImport,
  handleTemplateList,
  handleTemplateVerify,
} from "../../services/template-api";

const studio = new Uint8Array([0, 255, 17, 0, 8]);
const metadata = {
  name: "Alan A4",
  source: "Local",
  version: "5",
  paper: "a4",
  cardFormat: "standard",
  orientation: "portrait",
  registrationType: "three-point",
};

describe("template API", () => {
  let directory: string | undefined;
  let database: ReturnType<typeof openProjectDatabase> | undefined;

  afterEach(async () => {
    database?.close();
    database = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function setup() {
    directory = await mkdtemp(join(tmpdir(), "tcgprint-template-api-"));
    database = openProjectDatabase(join(directory, "projects.sqlite"));
    const templates = new TemplateRepository(database, { idFactory: (() => { let id = 0; return () => `template-${++id}`; })() });
    const projects = new ProjectRepository(database, { idFactory: () => "project-1" });
    const library = new TemplateLibraryService(templates, new TemplateFileStore(join(directory, "originals"), { maximumBytes: 1024 * 1024 }));
    return { library, projects };
  }

  function uploadRequest(metadataValue: unknown, name: string, bytes: Uint8Array): Request {
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadataValue));
    form.append("files", new Blob([Buffer.from(bytes)]), name);
    return new Request("http://localhost/api/templates", { method: "POST", body: form });
  }

  it("uploads .studio3, returns safe metadata, lists the version, verifies and downloads exact original bytes", async () => {
    const { library } = await setup();
    const uploaded = await handleTemplateImport(uploadRequest(metadata, "template.studio3", studio), library);
    const result = await uploaded.json() as { templateId: string; version: { packageHash: string; files: Array<{ fileId: string; contentHash: string; byteLength: number }> } };
    const file = result.version.files[0]!;

    expect(uploaded.status).toBe(201);
    expect(file.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(file.byteLength).toBe(studio.byteLength);
    expect(JSON.stringify(result)).not.toContain(directory!);
    expect(JSON.stringify(result)).not.toContain("template-originals");
    const listed = await handleTemplateList(new Request("http://localhost/api/templates"), library);
    expect(await listed.json()).toMatchObject({ templates: [{ versions: [{ version: "5", packageHash: result.version.packageHash }] }] });
    const verified = await handleTemplateVerify(new Request("http://localhost"), result.templateId, "5", library);
    expect(await verified.json()).toMatchObject({ status: "available", selection: { packageHash: result.version.packageHash } });
    const mismatched = await handleTemplateVerify(new Request("http://localhost"), result.templateId, "5", library, "f".repeat(64));
    expect(await mismatched.json()).toMatchObject({ status: "hash-mismatch", selection: { packageHash: "f".repeat(64) } });
    const downloaded = await handleTemplateFileDownload(new Request("http://localhost"), file.fileId, library);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(studio);
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("rejects malformed inputs and metadata above the limit with clear status", async () => {
    const { library } = await setup();
    const malformed = await handleTemplateImport(uploadRequest(metadata, "bad.svg", new TextEncoder().encode("<svg><g>")), library);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "TEMPLATE_FILE_INVALID" });

    const oversizedMetadata = new FormData();
    oversizedMetadata.set("metadata", JSON.stringify({ ...metadata, name: "n".repeat(70_000) }));
    oversizedMetadata.append("files", new Blob([Buffer.from(studio)]), "template.studio3");
    const response = await handleTemplateImport(new Request("http://localhost/api/templates", { method: "POST", body: oversizedMetadata }), library);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "TEMPLATE_METADATA_TOO_LARGE" });
  });

  it("prevents deleting a template referenced by a Project and preserves its association", async () => {
    const { library, projects } = await setup();
    const response = await handleTemplateImport(uploadRequest(metadata, "template.studio3", studio), library);
    const uploaded = await response.json() as { templateId: string; version: { packageHash: string } };
    const selection = { templateId: uploaded.templateId, version: "5", packageHash: uploaded.version.packageHash };
    const project = projects.create(undefined, selection);

    const removed = await handleTemplateDelete(new Request("http://localhost"), uploaded.templateId, library);

    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ code: "TEMPLATE_REFERENCED", referenceCount: 1 });
    expect(projects.open(project.id).templateSelection).toEqual(selection);
  });

  it("reports absent originals without substituting or changing the selected hash", async () => {
    const { library } = await setup();
    const response = await handleTemplateImport(uploadRequest(metadata, "template.studio3", studio), library);
    const uploaded = await response.json() as { templateId: string; version: { packageHash: string; files: Array<{ fileId: string; contentHash: string }> } };
    const file = uploaded.version.files[0]!;
    await rm(join(directory!, "originals", file.contentHash.slice(0, 2), file.contentHash));

    const verified = await handleTemplateVerify(new Request("http://localhost"), uploaded.templateId, "5", library);

    expect(await verified.json()).toMatchObject({ status: "missing", selection: { packageHash: uploaded.version.packageHash } });
    const downloaded = await handleTemplateFileDownload(new Request("http://localhost"), file.fileId, library);
    expect(downloaded.status).toBe(410);
    expect(await downloaded.json()).toMatchObject({ code: "TEMPLATE_FILE_MISSING" });
  });
});
