import type { HunkId, Narrative, RepositoryPath } from "@app/contracts";

import { isRepositoryPath, repositoryPath } from "./repositoryPath.ts";

export type EvidenceLink =
  | {
      readonly kind: "hunk";
      readonly uri: string;
      readonly hunkId: HunkId;
    }
  | {
      readonly kind: "file";
      readonly uri: string;
      readonly path: RepositoryPath;
    }
  | {
      readonly kind: "symbol";
      readonly uri: string;
      readonly path: RepositoryPath;
      readonly symbol: string;
    };

export type EvidenceLinkParseResult =
  | {
      readonly ok: true;
      readonly link: EvidenceLink;
    }
  | {
      readonly ok: false;
      readonly uri: string;
      readonly message: string;
    };

export interface LocatedEvidenceLink {
  readonly start: number;
  readonly end: number;
  readonly result: EvidenceLinkParseResult;
}

export interface PinnedFile {
  readonly old: string | null;
  readonly new: string | null;
  readonly headExists: boolean;
}

export type PinnedFileLookup = (path: string) => PinnedFile | undefined;
export type PinnedFileManifest =
  | ReadonlyMap<string, PinnedFile>
  | Readonly<Record<string, PinnedFile>>;

export interface EvidenceViolation {
  readonly code:
    | "evidence-invalid-uri"
    | "evidence-hunk-missing"
    | "evidence-file-missing"
    | "evidence-symbol-missing";
  readonly uri: string;
  readonly message: string;
}

const decodePart = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

export const parseEvidenceLink = (uri: string): EvidenceLinkParseResult => {
  if (!uri.startsWith("tl:")) {
    return { ok: false, uri, message: `Evidence URI must start with "tl:": ${uri}` };
  }

  const value = uri.slice(3);
  if (value.startsWith("hunk/")) {
    const rawId = value.slice("hunk/".length);
    const hunkId = decodePart(rawId);
    if (hunkId === undefined || !/^h[1-9]\d*$/u.test(hunkId)) {
      return { ok: false, uri, message: `Invalid hunk evidence URI: ${uri}` };
    }
    return {
      ok: true,
      link: { kind: "hunk", uri, hunkId: hunkId as HunkId },
    };
  }

  if (value.startsWith("file/")) {
    const path = decodePart(value.slice("file/".length));
    if (path === undefined || path.includes("#") || !isRepositoryPath(path)) {
      return { ok: false, uri, message: `Invalid file evidence URI: ${uri}` };
    }
    return {
      ok: true,
      link: { kind: "file", uri, path: repositoryPath(path) },
    };
  }

  if (value.startsWith("symbol/")) {
    const target = value.slice("symbol/".length);
    const fragmentIndex = target.indexOf("#");
    const path = decodePart(fragmentIndex === -1 ? "" : target.slice(0, fragmentIndex));
    const symbol = decodePart(fragmentIndex === -1 ? "" : target.slice(fragmentIndex + 1));
    if (
      path === undefined ||
      symbol === undefined ||
      !isRepositoryPath(path) ||
      symbol.length === 0
    ) {
      return { ok: false, uri, message: `Invalid symbol evidence URI: ${uri}` };
    }
    return {
      ok: true,
      link: {
        kind: "symbol",
        uri,
        path: repositoryPath(path),
        symbol,
      },
    };
  }

  return { ok: false, uri, message: `Unknown evidence URI kind: ${uri}` };
};

export const findEvidenceLinks = (markdown: string): readonly LocatedEvidenceLink[] => {
  const codeRanges: Array<readonly [number, number]> = [];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] !== "`") continue;
    let markerEnd = index + 1;
    while (markdown[markerEnd] === "`") markerEnd += 1;
    const marker = markdown.slice(index, markerEnd);
    const close = markdown.indexOf(marker, markerEnd);
    if (close === -1) {
      index = markerEnd - 1;
      continue;
    }
    codeRanges.push([index, close + marker.length]);
    index = close + marker.length - 1;
  }
  const inCode = (index: number): boolean =>
    codeRanges.some(([start, end]) => index >= start && index < end);
  const located = new Map<string, LocatedEvidenceLink>();
  const add = (uri: string, start: number): void => {
    if (!uri.startsWith("tl:") || inCode(start)) return;
    const end = start + uri.length;
    located.set(`${start}:${end}`, {
      start,
      end,
      result: parseEvidenceLink(uri),
    });
  };

  for (const match of markdown.matchAll(/<(tl:[^<>\s]+)>/gu)) {
    add(match[1]!, match.index + 1);
  }

  for (let index = 0; index < markdown.length - 1; index += 1) {
    if (markdown[index] !== "]" || markdown[index + 1] !== "(" || inCode(index)) {
      continue;
    }
    let escaped = 0;
    for (let before = index - 1; markdown[before] === "\\"; before -= 1) escaped += 1;
    if (escaped % 2 === 1) continue;

    let targetStart = index + 2;
    while (/\s/u.test(markdown[targetStart] ?? "")) targetStart += 1;
    if (markdown[targetStart] === "<") {
      const close = markdown.indexOf(">", targetStart + 1);
      if (close !== -1) {
        add(markdown.slice(targetStart + 1, close), targetStart + 1);
      }
      continue;
    }

    let targetEnd = targetStart;
    let depth = 0;
    while (targetEnd < markdown.length) {
      const character = markdown[targetEnd]!;
      if (character === "\\" && targetEnd + 1 < markdown.length) {
        targetEnd += 2;
        continue;
      }
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/u.test(character) && depth === 0) {
        break;
      }
      targetEnd += 1;
    }
    add(markdown.slice(targetStart, targetEnd), targetStart);
  }

  for (const match of markdown.matchAll(
    /^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*(?:<(tl:[^>\r\n]+)>|(tl:\S+))/gmu,
  )) {
    const uri = match[1] ?? match[2]!;
    add(uri, match.index + match[0].indexOf(uri));
  }

  return [...located.values()].toSorted((left, right) => left.start - right.start);
};

export const makePinnedFileLookup = (manifest: PinnedFileManifest): PinnedFileLookup => {
  if (manifest instanceof Map) {
    return (path) => manifest.get(path);
  }
  const files = manifest as Readonly<Record<string, PinnedFile>>;
  return (path) => files[path];
};

export const validateEvidenceLinks = (
  markdown: string,
  input: {
    readonly hunkIds: ReadonlySet<string>;
    readonly pinnedFile: PinnedFileLookup;
  },
): readonly EvidenceViolation[] => {
  const violations: EvidenceViolation[] = [];

  for (const located of findEvidenceLinks(markdown)) {
    if (!located.result.ok) {
      violations.push({
        code: "evidence-invalid-uri",
        uri: located.result.uri,
        message: located.result.message,
      });
      continue;
    }

    const link = located.result.link;
    if (link.kind === "hunk") {
      if (!input.hunkIds.has(link.hunkId)) {
        violations.push({
          code: "evidence-hunk-missing",
          uri: link.uri,
          message: `Evidence link ${link.uri} names unknown hunk ${link.hunkId}.`,
        });
      }
      continue;
    }

    const file = input.pinnedFile(link.path);
    if (file === undefined || !file.headExists) {
      violations.push({
        code: "evidence-file-missing",
        uri: link.uri,
        message: `Evidence link ${link.uri} names a file outside the pinned revisions.`,
      });
      continue;
    }

    if (link.kind === "symbol" && !(file.new?.includes(link.symbol) ?? false)) {
      violations.push({
        code: "evidence-symbol-missing",
        uri: link.uri,
        message: `Evidence link ${link.uri} names symbol "${link.symbol}" absent from the pinned head file.`,
      });
    }
  }

  return violations;
};

export const validateNarrativeEvidence = (
  narrative: Narrative | string,
  input: {
    readonly hunkIds: ReadonlySet<string>;
    readonly pinnedFile: PinnedFileLookup;
  },
): readonly EvidenceViolation[] =>
  validateEvidenceLinks(typeof narrative === "string" ? narrative : narrative.markdown, input);
