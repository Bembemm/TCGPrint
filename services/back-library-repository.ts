import { mkdirSync } from "node:fs";
import { appDataPaths } from "../artwork/storage/paths";
import { ArtworkOriginalStore } from "../artwork/storage/original-store";
import { ArtworkRepository } from "../artwork/storage/repository";
import { BackLibraryRepository } from "../persistence/back-library/repository";
import { openArtworkDatabase } from "../persistence/sqlite";
import { BackLibraryService } from "./back-library";

let service: BackLibraryService | undefined;

export function getBackLibraryService(): BackLibraryService {
  if (service) return service;
  const dataDirectory = process.env.TCGPRINT_DATA_DIR ?? process.cwd();
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const paths = appDataPaths(dataDirectory);
  mkdirSync(paths.rootDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(paths.originalsDirectory, { recursive: true, mode: 0o700 });
  const database = openArtworkDatabase(paths.databaseFile);
  const artworkRepository = new ArtworkRepository(database);
  const originalStore = new ArtworkOriginalStore(paths.originalsDirectory, artworkRepository);
  service = new BackLibraryService(new BackLibraryRepository(database), originalStore);
  return service;
}
