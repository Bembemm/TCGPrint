import type { UrlAdapter } from "../types";
import { mtgTop8UrlAdapter } from "./mtgtop8";
import { mtgWtfUrlAdapter } from "./mtg-wtf";
import { scryfallUrlAdapter } from "./scryfall";

export { mtgTop8UrlAdapter, mtgWtfUrlAdapter, scryfallUrlAdapter };

export const URL_ADAPTERS: readonly UrlAdapter[] = Object.freeze([
  scryfallUrlAdapter,
  mtgWtfUrlAdapter,
  mtgTop8UrlAdapter,
]);
