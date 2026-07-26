/**
 * Emphasis and dimming — the visual carrier of the cluster boundary.
 *
 * This is the product's single use of accent colour: hunks homed to the open
 * cluster are emphasised, hunks homed elsewhere are dimmed and labelled. The full
 * file is always present; the boundary is carried by emphasis, not exclusion,
 * which is also what makes the partition itself visible — every hunk on screen
 * declares where it belongs.
 *
 * **The mechanism, and why it is this one.** Every file `@pierre/diffs` renders
 * lives in its own open shadow root, so no global stylesheet and no `className`
 * can reach a code row. The library exposes exactly one seam that can: an
 * `onPostRender` callback handing us the host element (and therefore its shadow
 * root), plus an `unsafeCSS` string injected into that shadow root's lowest
 * cascade layer. So marking is: write `data-*` attributes onto rows, and let one
 * memoised stylesheet style them.
 *
 * **The subtlety that matters.** `data-line` is the row's *own-side* number. In a
 * unified diff an addition row's `data-line` is a new-side line and a deletion
 * row's is an old-side line, so a naive numeric range match highlights the wrong
 * code — new line 12 and old line 12 are different lines. Every lookup here
 * therefore branches on `data-line-type` first. (Verified against a real
 * `CodeView`, which is what turned this from a plausible design into a correct
 * one.)
 *
 * @module journey/emphasis
 */
import type { Hunk } from "@app/contracts";

/** A contiguous run of lines on one side of one file. */
export interface SideRange {
  readonly side: "old" | "new";
  readonly start: number;
  readonly end: number;
}

export interface FileEmphasis {
  /** Hunks homed to the open cluster: the accent. */
  readonly focus: ReadonlyArray<SideRange>;
  /** Hunks homed elsewhere: dimmed, and labelled with their home. */
  readonly dim: ReadonlyArray<SideRange>;
  /** Resurfaced hunks: emphasised, but marked as a revisit rather than new code. */
  readonly revisit: ReadonlyArray<SideRange>;
}

export const EMPTY_EMPHASIS: FileEmphasis = { focus: [], dim: [], revisit: [] };

/** Both sides of one hunk, skipping the zero-length half of a pure insert/delete. */
export function hunkRanges(hunk: Hunk): ReadonlyArray<SideRange> {
  const ranges: SideRange[] = [];
  if (hunk.oldLines > 0) {
    ranges.push({ side: "old", start: hunk.oldStart, end: hunk.oldStart + hunk.oldLines - 1 });
  }
  if (hunk.newLines > 0) {
    ranges.push({ side: "new", start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 });
  }
  return ranges;
}

/**
 * Group a journey's hunks into per-file emphasis for one open cluster.
 * `resurfacedIds` are hunks this cluster revisits; they are emphasised *and*
 * marked, because the reviewer must never lose the distinction between "known
 * code from a new angle" and "new code".
 */
export function emphasisByFile(input: {
  readonly hunks: ReadonlyArray<Hunk>;
  readonly clusterId: string;
  readonly resurfacedIds: ReadonlySet<string>;
}): ReadonlyMap<string, FileEmphasis> {
  const result = new Map<string, { focus: SideRange[]; dim: SideRange[]; revisit: SideRange[] }>();
  const bucket = (path: string) => {
    const existing = result.get(path);
    if (existing !== undefined) return existing;
    const created = { focus: [], dim: [], revisit: [] };
    result.set(path, created);
    return created;
  };

  for (const hunk of input.hunks) {
    const ranges = hunkRanges(hunk);
    if (ranges.length === 0) continue;
    const target = bucket(hunk.path);
    if (input.resurfacedIds.has(hunk.id)) target.revisit.push(...ranges);
    else if (hunk.home === input.clusterId) target.focus.push(...ranges);
    else target.dim.push(...ranges);
  }
  return result;
}

/** Which side a rendered row belongs to, from the library's own line-type value. */
export function rowSide(lineType: string | undefined): "old" | "new" {
  return lineType === "change-deletion" ? "old" : "new";
}

/** Only *changed* rows are marked; context is left alone so the page stays calm. */
export function isChangedRow(lineType: string | undefined): boolean {
  return lineType === "change-addition" || lineType === "change-deletion";
}

function inRanges(ranges: ReadonlyArray<SideRange>, side: "old" | "new", line: number): boolean {
  return ranges.some((range) => range.side === side && line >= range.start && line <= range.end);
}

export const MARK = {
  focus: "data-tl-focus",
  revisit: "data-tl-revisit",
  dim: "data-tl-dim",
  /** The library's own decoration hook, which composes with the diff tint. */
  decoration: "data-decoration-bg",
} as const;

/**
 * Write the markers onto one rendered file's rows.
 *
 * Both branches of every toggle are always written. `<diffs-container>` hosts are
 * pooled and re-used across items, and the library re-renders partially as rows
 * scroll in, so a marker set once and never cleared leaks onto another file's
 * code.
 */
export function applyEmphasis(shadowRoot: ShadowRoot, emphasis: FileEmphasis): void {
  const isSplit = shadowRoot.querySelector("pre[data-diff-type='split']") !== null;

  const markRow = (row: HTMLElement, side: "old" | "new") => {
    const line = Number(row.getAttribute("data-line") ?? row.getAttribute("data-column-number"));
    if (!Number.isFinite(line)) return;
    const lineType = row.getAttribute("data-line-type") ?? undefined;
    // A plain-file item has no changed rows at all — every row is `context` —
    // so just-the-code marks by range alone.
    const changed =
      isChangedRow(lineType) || lineType === "context-expanded" || lineType === "context";
    const focus = changed && inRanges(emphasis.focus, side, line);
    const revisit = changed && !focus && inRanges(emphasis.revisit, side, line);
    const dim = changed && !focus && !revisit && inRanges(emphasis.dim, side, line);

    row.toggleAttribute(MARK.focus, focus);
    row.toggleAttribute(MARK.revisit, revisit);
    row.toggleAttribute(MARK.dim, dim);
    row.toggleAttribute(MARK.decoration, focus || revisit);
  };

  if (isSplit) {
    // Split mode is two independent columns, each showing one side only.
    for (const column of [
      { selector: "[data-deletions]", side: "old" as const },
      { selector: "[data-additions]", side: "new" as const },
    ]) {
      for (const row of shadowRoot.querySelectorAll<HTMLElement>(
        `${column.selector} [data-line], ${column.selector} [data-column-number]`,
      )) {
        markRow(row, column.side);
      }
    }
    return;
  }

  for (const row of shadowRoot.querySelectorAll<HTMLElement>("[data-line]")) {
    markRow(row, rowSide(row.getAttribute("data-line-type") ?? undefined));
  }
  for (const cell of shadowRoot.querySelectorAll<HTMLElement>("[data-column-number]")) {
    markRow(cell, rowSide(cell.getAttribute("data-line-type") ?? undefined));
  }
}

/**
 * The stylesheet the markers above hang on, injected into every file's shadow
 * root. It is a module constant so its identity never changes: the library
 * rewrites the `<style>` node whenever the string differs, and a fresh string per
 * render would rewrite it on every frame.
 *
 * `--diffs-decoration-bg` feeds the library's own `--diffs-line-bg`, so hover,
 * selection, and the addition/deletion tint all still compose — the accent joins
 * the diff's colour language instead of overwriting it.
 *
 * One thing this stylesheet must NOT do: hide `[data-diffs-header]`.
 * `renderCustomHeader` portals its content into a slot *inside* that element, so
 * hiding it takes the per-file header — and with it Mark read, the product's
 * primary interaction — off the screen. The custom renderer already replaces the
 * default header's content, so there is nothing to hide.
 */
export const EMPHASIS_CSS = `
  [data-line][data-tl-dim],
  [data-column-number][data-tl-dim] {
    opacity: 0.32;
  }
  [data-line][data-tl-dim] [data-diff-span] {
    background-color: transparent;
  }
  [data-line][data-tl-focus],
  [data-column-number][data-tl-focus] {
    --diffs-decoration-bg: var(--tl-accent);
  }
  [data-line][data-tl-revisit],
  [data-column-number][data-tl-revisit] {
    --diffs-decoration-bg: var(--tl-accent);
  }
  [data-line][data-tl-revisit] {
    box-shadow: inset 2px 0 0 0 var(--tl-accent);
  }
`;

/**
 * Just-the-code mode: every trace of diff UI falls away, leaving the file's new
 * state as plain code with only a subtle margin marker showing which regions
 * changed. Hints still bind here, anchored to these markers.
 */
export const JUST_THE_CODE_CSS = `
  [data-line][data-tl-focus] {
    box-shadow: inset 3px 0 0 0 var(--tl-accent);
  }
  [data-line][data-tl-dim] {
    box-shadow: inset 3px 0 0 0 var(--tl-foreign);
    opacity: 1;
  }
  [data-line][data-tl-revisit] {
    box-shadow: inset 3px 0 0 0 var(--tl-accent);
  }
`;
