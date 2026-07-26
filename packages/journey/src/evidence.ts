import type { Journey } from "@app/contracts";

export interface EvidenceLink {
  readonly raw: string;
  readonly kind: "hunk" | "file" | "symbol";
  readonly path: string;
  readonly symbol?: string;
}

const LINK = /tl:(hunk|file|symbol)\/([^\s)>\]]+)/g;

export function evidenceLinks(markdown: string): ReadonlyArray<EvidenceLink> {
  const links: Array<EvidenceLink> = [];
  for (const match of markdown.matchAll(LINK)) {
    const raw = match[0];
    const kind = match[1] as EvidenceLink["kind"];
    const target = match[2];
    if (target === undefined) continue;
    if (kind === "symbol") {
      const index = target.lastIndexOf("#");
      if (index <= 0 || index === target.length - 1) continue;
      links.push({ raw, kind, path: target.slice(0, index), symbol: target.slice(index + 1) });
    } else {
      links.push({ raw, kind, path: target });
    }
  }
  return links;
}

export function validateEvidence(
  journey: Journey,
  fileContents: ReadonlyMap<string, string>,
): ReadonlyArray<string> {
  const narratives = [
    journey.overview.brief,
    journey.overview.whereToBegin,
    ...journey.clusters.flatMap((cluster) => [
      cluster.narrative,
      cluster.mapEntry,
      ...cluster.resurfaced.map((item) => item.note),
    ]),
    ...journey.hints.map((hint) => hint.body),
  ];
  const hunkIds = new Set(journey.hunks.map((hunk) => hunk.id));
  const paths = new Set(fileContents.keys());
  const invalid: Array<string> = [];

  for (const narrative of narratives) {
    for (const link of evidenceLinks(narrative.markdown)) {
      if (link.kind === "hunk" && !hunkIds.has(link.path as never)) invalid.push(link.raw);
      if (link.kind === "file" && !paths.has(link.path)) invalid.push(link.raw);
      if (
        link.kind === "symbol" &&
        (link.symbol === undefined || !fileContents.get(link.path)?.includes(link.symbol))
      ) {
        invalid.push(link.raw);
      }
    }
  }
  return invalid;
}

export function downgradeInvalidEvidence(
  markdown: string,
  invalidLinks: ReadonlySet<string>,
): string {
  return markdown.replaceAll(/\[([^\]]+)\]\((tl:[^)]+)\)/g, (whole, label: string, href: string) =>
    invalidLinks.has(href) ? label : whole,
  );
}
