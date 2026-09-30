import type { UrlAdapter } from "../types";
import { archidektUrlAdapter } from "./archidekt";
import { cubeCobraUrlAdapter } from "./cubecobra";
import { mtgTop8UrlAdapter } from "./mtgtop8";
import { mtgWtfUrlAdapter } from "./mtg-wtf";
import { scryfallUrlAdapter } from "./scryfall";

export { archidektUrlAdapter, cubeCobraUrlAdapter, mtgTop8UrlAdapter, mtgWtfUrlAdapter, scryfallUrlAdapter };

export const URL_ADAPTERS: readonly UrlAdapter[] = Object.freeze([
  archidektUrlAdapter,
  cubeCobraUrlAdapter,
  scryfallUrlAdapter,
  mtgWtfUrlAdapter,
  mtgTop8UrlAdapter,
]);
