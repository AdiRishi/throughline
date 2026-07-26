/**
 * `Atom.family`, for a *group* of atoms rather than one.
 *
 * `Atom.family` stores each entry in a `WeakRef` and drops it when the value is
 * collected. That is exactly right when the value is an atom: the registry
 * holds every atom it has ever evaluated, so a live atom stays reachable and
 * the family keeps handing back the same one.
 *
 * It is quietly wrong when the value is a plain object *containing* atoms.
 * Nothing holds that object between renders — a component calls the family,
 * reads the atoms, and drops the wrapper — so a garbage collection clears the
 * `WeakRef` and the next call builds a whole new set of atoms. The old ones
 * stay alive (they are `keepAlive`, and they own the live subscriptions), while
 * the component subscribes to fresh ones that nobody has answered yet. The
 * screen then waits forever on an atom no stream is feeding, and the socket
 * shows the same request going out again and again.
 *
 * That failure is invisible in short sessions and reliable in long ones, which
 * is the worst combination. So: a plain strong `Map`. There is one entry per
 * pull request the reviewer has opened, every atom inside is `keepAlive`
 * anyway, and holding the wrapper costs a pointer.
 *
 * @module state/bundle
 */

/** Memoize a group of atoms by key, strongly. */
export function atomBundle<A>(make: (key: string) => A): (key: string) => A {
  const bundles = new Map<string, A>();
  return (key: string): A => {
    const existing = bundles.get(key);
    if (existing !== undefined) return existing;
    const created = make(key);
    bundles.set(key, created);
    return created;
  };
}
