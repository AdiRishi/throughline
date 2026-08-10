import * as Schema from "effect/Schema";

/**
 * True when running inside the Electron shell. `preload.ts` installs
 * `window.desktopBridge` via contextBridge before any app code runs, so this is
 * reliable at module-load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

/**
 * Where a resolved target came from. It rides along on every failure so a bad
 * URL names the input that produced it — an env override, the page the app was
 * served from, or the shell's bootstrap.
 */
const ConnectionTargetSource = Schema.Literals(["configured", "window-origin", "desktop-managed"]);
export type ConnectionTargetSource = typeof ConnectionTargetSource.Type;

const ConnectionTargetUrlKind = Schema.Literals(["http-base-url", "websocket-base-url"]);
export type ConnectionTargetUrlKind = typeof ConnectionTargetUrlKind.Type;

export class ConnectionTargetUrlInvalidError extends Schema.TaggedError<ConnectionTargetUrlInvalidError>()(
  "ConnectionTargetUrlInvalidError",
  {
    source: ConnectionTargetSource,
    urlKind: ConnectionTargetUrlKind,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not parse ${this.urlKind} for the ${this.source} connection target.`;
  }
}

export class ConnectionTargetProtocolUnsupportedError extends Schema.TaggedError<ConnectionTargetProtocolUnsupportedError>()(
  "ConnectionTargetProtocolUnsupportedError",
  {
    source: ConnectionTargetSource,
    protocol: Schema.String,
  },
) {
  override get message(): string {
    return `The ${this.source} connection target uses unsupported protocol ${this.protocol}.`;
  }
}

export class DesktopServerBootstrapIncompleteError extends Schema.TaggedError<DesktopServerBootstrapIncompleteError>()(
  "DesktopServerBootstrapIncompleteError",
  {
    hasHttpBaseUrl: Schema.Boolean,
    hasWsBaseUrl: Schema.Boolean,
  },
) {
  override get message(): string {
    const missing = [
      ...(this.hasHttpBaseUrl ? [] : ["httpBaseUrl"]),
      ...(this.hasWsBaseUrl ? [] : ["wsBaseUrl"]),
    ];
    return `The desktop bootstrap is missing ${missing.join(" and ")}.`;
  }
}

export interface ConnectionTarget {
  readonly source: ConnectionTargetSource;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/**
 * The page origin, when there is a page. Doubles as the base for relative
 * overrides (`VITE_WS_URL=/` is a legitimate single-origin setting), and is
 * `undefined` under a test runner or any other window-less host.
 */
function pageOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const origin = window.location?.origin;
  return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}

/**
 * Parse a URL into a *classified* failure. A bare `new URL()` throws a
 * `TypeError` from wherever it happens to be called — inside an `Effect` that
 * is a defect, and a defect takes the whole runtime (and every atom on it) down
 * with it. These throws are caught at exactly one seam:
 * `resolveConnectionTargetResult`.
 */
function parseTargetUrl(input: {
  readonly rawValue: string;
  readonly baseUrl?: string | undefined;
  readonly source: ConnectionTargetSource;
  readonly urlKind: ConnectionTargetUrlKind;
}): URL {
  try {
    return input.baseUrl === undefined
      ? new URL(input.rawValue)
      : new URL(input.rawValue, input.baseUrl);
  } catch (cause) {
    throw new ConnectionTargetUrlInvalidError({
      source: input.source,
      urlKind: input.urlKind,
      cause,
    });
  }
}

/** Origin form: protocol + host, with path, query, fragment and trailing slash dropped. */
function toOrigin(url: URL): string {
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * One URL, both forms. Whatever scheme the input carries, the target exposes
 * the http(s) origin and the ws(s) origin of the same host — a secure input
 * stays secure. Anything that is not http(s)/ws(s) (a `file:` page in a
 * packaged shell, a typo'd scheme) is rejected rather than silently kept:
 * assigning `url.protocol` on a non-special scheme is a no-op, so a `file:`
 * URL would otherwise sail through as a "ws" base URL.
 */
function targetFromUrl(
  rawValue: string,
  source: ConnectionTargetSource,
  urlKind: ConnectionTargetUrlKind,
): ConnectionTarget {
  const url = parseTargetUrl({ rawValue, baseUrl: pageOrigin(), source, urlKind });
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const insecure = url.protocol === "http:" || url.protocol === "ws:";
  if (!secure && !insecure) {
    throw new ConnectionTargetProtocolUnsupportedError({ source, protocol: url.protocol });
  }

  const httpUrl = new URL(url);
  httpUrl.protocol = secure ? "https:" : "http:";
  const wsUrl = new URL(url);
  wsUrl.protocol = secure ? "wss:" : "ws:";

  return { source, httpBaseUrl: toOrigin(httpUrl), wsBaseUrl: toOrigin(wsUrl) };
}

/** Turn a ws(s) URL into its http(s) origin form. */
export function toHttpOrigin(wsUrl: string): string {
  return targetFromUrl(wsUrl, "configured", "websocket-base-url").httpBaseUrl;
}

/** Turn an http(s) origin into its ws(s) form. */
export function toWsOrigin(httpUrl: string): string {
  return targetFromUrl(httpUrl, "configured", "http-base-url").wsBaseUrl;
}

/**
 * The explicit override. Empty unless someone set `VITE_WS_URL` for the build
 * or dev run (the dev runner sets it for the web child): a served build has no
 * business baking in an address, because the only address that is right for
 * every visitor is the one they loaded the page from.
 */
function resolveConfiguredTarget(): ConnectionTarget | null {
  const configuredWsBaseUrl = import.meta.env.VITE_WS_URL?.trim();
  if (!configuredWsBaseUrl) return null;
  return targetFromUrl(configuredWsBaseUrl, "configured", "websocket-base-url");
}

/** The default: the app is served BY the server, so the page origin IS the server. */
function resolveWindowOriginTarget(): ConnectionTarget {
  return targetFromUrl(pageOrigin() ?? "", "window-origin", "http-base-url");
}

/** The shell's own answer: the supervised server's address, handed over the bridge. */
function resolveDesktopTarget(): ConnectionTarget | null {
  const bootstrap = window.desktopBridge?.getServerBootstrap();
  if (!bootstrap) return null;
  if (!bootstrap.httpBaseUrl || !bootstrap.wsBaseUrl) {
    throw new DesktopServerBootstrapIncompleteError({
      hasHttpBaseUrl: Boolean(bootstrap.httpBaseUrl),
      hasWsBaseUrl: Boolean(bootstrap.wsBaseUrl),
    });
  }
  return {
    source: "desktop-managed",
    httpBaseUrl: targetFromUrl(bootstrap.httpBaseUrl, "desktop-managed", "http-base-url")
      .httpBaseUrl,
    wsBaseUrl: targetFromUrl(bootstrap.wsBaseUrl, "desktop-managed", "websocket-base-url")
      .wsBaseUrl,
  };
}

/**
 * Resolve where the server lives (integration contract):
 * - In the shell: ask the bridge; fall back to the page origin.
 * - In the browser: an explicit `VITE_WS_URL` wins (a dev/override affordance),
 *   otherwise the page origin.
 *
 * Throws a classified error — never a bare `TypeError` — for a URL it cannot
 * make sense of. Call `resolveConnectionTargetResult` at any seam where a throw
 * would become a defect.
 */
export function resolveConnectionTarget(): ConnectionTarget {
  if (isElectron && window.desktopBridge) {
    return resolveDesktopTarget() ?? resolveWindowOriginTarget();
  }
  return resolveConfiguredTarget() ?? resolveWindowOriginTarget();
}

export type ConnectionTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: ConnectionTarget;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

/**
 * The one seam that turns a target failure into data. Everything that resolves
 * a target from inside an Effect (or a promise an Effect awaits) goes through
 * here, so a malformed URL is a value the caller classifies and the UI renders
 * — not a defect that kills the runtime.
 */
export function resolveConnectionTargetResult(
  readTarget: () => ConnectionTarget = resolveConnectionTarget,
): ConnectionTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}
