import { resolve } from "node:path";
import { TemplateRepository } from "../persistence/templates/repository";
import { TemplateFileStore } from "../templates/file-store";
import { MAX_TEMPLATE_ARCHIVE_BYTES } from "../templates/validation";
import { getProjectDatabase } from "./project-repository";
import { TemplateLibraryService } from "./template-library";

export function templateOriginalsPath(baseDirectory = process.env.TCGPRINT_DATA_DIR ?? process.cwd()): string {
  return resolve(baseDirectory, ".tcgprint", "template-originals");
}

let defaultTemplateLibrary: TemplateLibraryService | undefined;

/** Shares the Project database/FK domain and keeps template bytes in their own immutable store. */
export function getTemplateLibraryService(): TemplateLibraryService {
  defaultTemplateLibrary ??= new TemplateLibraryService(
    new TemplateRepository(getProjectDatabase()),
    new TemplateFileStore(templateOriginalsPath(), { maximumBytes: MAX_TEMPLATE_ARCHIVE_BYTES }),
  );
  return defaultTemplateLibrary;
}
