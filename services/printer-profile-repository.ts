import { PrinterProfileRepository } from "../persistence/printer-profiles/repository";
import { getProjectDatabase } from "./project-repository";

let repository: PrinterProfileRepository | undefined;

export function getPrinterProfileRepository(): PrinterProfileRepository {
  repository ??= new PrinterProfileRepository(getProjectDatabase());
  return repository;
}
