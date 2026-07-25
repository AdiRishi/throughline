const URL_PATTERN = /(?:file|https?|wss?):\/\/[^\s"'\\)]+/giu;
const JSON_SECRET_PATTERN =
  /("(?:access[_-]?token|app[_-]?bootstrap[_-]?token|authorization|bootstrap[_-]?token|credential|desktop[_-]?bootstrap[_-]?token|password|secret|token)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)"/giu;
const AUTHORIZATION_SCHEME_PATTERN =
  /(?<![A-Za-z0-9/_-])\b(Authorization\s*[:=]\s*(?:Basic|Bearer))\s+(?!\[redacted\])[\w.+~=/-]+/giu;
const ASSIGNMENT_SECRET_PATTERN =
  /\b(access[_-]?token|app[_-]?bootstrap[_-]?token|authorization|bootstrap[_-]?token|credential|desktop[_-]?bootstrap[_-]?token|password|secret|token)\s*([=:])\s*(?!\[redacted\]|Basic\b|Bearer\b)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/giu;
const AUTHENTICATION_SCHEME_PATTERN =
  /(?<![A-Za-z0-9/_-])\b(Basic|Bearer)\s+(?!\[redacted\])[\w.+~=/-]+/giu;
const KNOWN_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,})\b/gu;
const SECRET_FIELD_PATTERN =
  /^(?:access[_-]?token|app[_-]?bootstrap[_-]?token|authorization|bootstrap[_-]?token|credential|desktop[_-]?bootstrap[_-]?token|password|secret|token)$/iu;
const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const DIAGNOSTIC_URL_PROTOCOLS = new Set([
  "app:",
  "app-dev:",
  "file:",
  "http:",
  "https:",
  "ws:",
  "wss:",
]);

export const DEFAULT_DIAGNOSTIC_TEXT_LIMIT = 8 * 1024;

export function sanitizeDiagnosticUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!DIAGNOSTIC_URL_PROTOCOLS.has(url.protocol)) {
      return "[unsupported-url]";
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[invalid-url]";
  }
}

export function sanitizeDiagnosticText(
  value: string,
  maxLength = DEFAULT_DIAGNOSTIC_TEXT_LIMIT,
): string {
  const sanitized = value
    .replace(URL_PATTERN, sanitizeDiagnosticUrl)
    .replace(JSON_SECRET_PATTERN, '$1[redacted]"')
    .replace(AUTHORIZATION_SCHEME_PATTERN, "$1 [redacted]")
    .replace(AUTHENTICATION_SCHEME_PATTERN, "$1 [redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1$2[redacted]")
    .replace(KNOWN_TOKEN_PATTERN, "[redacted]");
  const truncationMarker = "…[truncated]";

  return sanitized.length <= maxLength
    ? sanitized
    : `${sanitized.slice(0, Math.max(0, maxLength - truncationMarker.length))}${truncationMarker}`;
}

function sanitizeDiagnosticValue(value: unknown, fieldName?: string): unknown {
  if (fieldName !== undefined && SECRET_FIELD_PATTERN.test(fieldName)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return sanitizeDiagnosticText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeDiagnosticValue(item, key)]),
    );
  }
  return value;
}

export function sanitizeDiagnosticJsonLine(line: string): string {
  try {
    return JSON.stringify(sanitizeDiagnosticValue(JSON.parse(line)));
  } catch {
    return JSON.stringify({
      message: "diagnostic record could not be parsed",
      annotations: {
        component: "diagnostics",
        text: sanitizeDiagnosticText(line),
      },
    });
  }
}

export function safeDiagnosticErrorType(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "_tag" in error) {
      const tag = (error as { readonly _tag?: unknown })._tag;
      if (typeof tag === "string" && SAFE_ERROR_TYPE.test(tag)) {
        return tag;
      }
    }
    if (error instanceof Error && SAFE_ERROR_TYPE.test(error.name)) {
      return error.name;
    }
  } catch {
    return "UnknownError";
  }
  return "UnknownError";
}
