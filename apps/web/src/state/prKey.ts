/**
 * The string a pull request is keyed by.
 *
 * Every per-pull-request atom family is keyed on this one string, so journey
 * state and ingestion state for the same pull request are guaranteed to line up
 * — and it lives on its own so those two modules can depend on each other's
 * atoms without depending on each other's files.
 *
 * @module state/prKey
 */
import type { PrRef } from "@app/contracts";

export interface PrKey {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export function prKeyString(pr: PrKey): string {
  return `${pr.owner}/${pr.repo}/${pr.number}`;
}

export function parsePrKey(key: string): PrRef {
  const [owner = "", repo = "", number = "0"] = key.split("/");
  return { owner, repo, number: Number.parseInt(number, 10) };
}
