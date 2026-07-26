/**
 * The reading surfaces' keyboard language.
 *
 * Reading is one experience on two screens — the cluster page and free file
 * reading — so a keystroke has to mean the same thing on both: `r` marks the file
 * read, `n`/`p` walk the changed regions. Anything else would make the product's
 * primary interaction something the reviewer has to re-learn per route. The guard
 * lives here rather than beside either screen because both of them need it and a
 * second copy is a second chance to forget it.
 *
 * @module journey/keys
 */

/** Never steal a keystroke from a field the reviewer is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
