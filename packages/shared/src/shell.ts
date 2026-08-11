// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Reading the user's real `PATH` out of their login shell.
 *
 * A GUI-launched app does not inherit a login shell. On macOS, double-clicking
 * the app (or launching it from the Dock) gives the process the launchd
 * environment — typically `/usr/bin:/bin:/usr/sbin:/sbin` — not the `PATH` the
 * same user sees in a terminal. Anything installed by Homebrew, nvm, fnm,
 * volta, mise, asdf, or a package manager's shim directory is invisible.
 *
 * The fix is the one every Electron app converges on: shell out to the user's
 * login shell once at startup, read what it thinks `PATH` is, and merge that on
 * top of what we inherited. Every read here is best-effort — a user with a
 * broken shell profile must still get a running app.
 *
 * @module shell
 */

const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;

export type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) => string;

export interface WindowsEnvironmentProbeOptions {
  readonly loadProfile?: boolean;
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(NodeOS.userInfo().shell);
  } catch {
    return undefined;
  }
}

/**
 * Shells to try, best first: `$SHELL`, then the shell recorded on the user
 * account, then the platform default. `$SHELL` can be missing or stale in a
 * GUI-launched process, which is exactly the case this whole module exists for.
 */
export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

function envCaptureStart(name: string): string {
  return `__APP_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__APP_ENV_${name}_END__`;
}

// Values are fenced by markers rather than read from the raw output: a login
// shell prints whatever the user's profile prints (banners, version notices,
// fortune), and only the bytes between the markers are ours.
function buildEnvironmentCaptureCommand(names: ReadonlyArray<string>): string {
  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");
}

function buildWindowsEnvironmentCaptureCommand(names: ReadonlyArray<string>): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      return [
        `Write-Output '${envCaptureStart(name)}'`,
        `$value = [Environment]::GetEnvironmentVariable('${name}')`,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${envCaptureEnd(name)}'`,
      ];
    }),
  ].join("; ");
}

export function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  const value = output
    .slice(valueStartIndex, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

/**
 * `-ilc`: interactive **and** login. Some managers (nvm, mise) only export into
 * one of the two profile paths, so dropping either flag loses users.
 */
export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = NodeChildProcess.execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(names)], {
    encoding: "utf8",
    timeout: 5000,
  });

  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
};

export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync,
): string | undefined {
  return readEnvironmentFromLoginShell(shell, ["PATH"], execFile)["PATH"];
}

/**
 * macOS fallback for when no login shell answered. `launchctl getenv PATH`
 * reports the session-wide value, which is still better than the bare launchd
 * default the GUI process started with.
 */
export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync,
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  } catch {
    return undefined;
  }
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

function normalizePathEntryForComparison(entry: string, platform: NodeJS.Platform): string {
  const normalized = stripWrappingQuotes(entry.trim());
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Concatenates two `PATH` values, preferred first, dropping duplicates. Order
 * is the point: the login shell's entries have to win, because that is where
 * the version-manager shims live that decide which `node` or `git` we get.
 *
 * Comparison is case-insensitive and quote-stripped on Windows only.
 */
export function mergePathValues(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = pathDelimiterForPlatform(platform);
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of [preferredPath, inheritedPath]) {
    if (!rawValue) continue;

    for (const entry of rawValue.split(delimiter)) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;

      const normalized = normalizePathEntryForComparison(trimmed, platform);
      if (normalized.length === 0 || seen.has(normalized)) continue;

      seen.add(normalized);
      merged.push(trimmed);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  // Windows env keys are case-insensitive but Node preserves whatever case the
  // parent used, so all three spellings have to be checked.
  return env["PATH"] ?? env["Path"] ?? env["path"];
}

export type WindowsShellEnvironmentReader = (
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
) => Partial<Record<string, string>>;

export function readEnvironmentFromWindowsShell(
  names: ReadonlyArray<string>,
  options: WindowsEnvironmentProbeOptions = {},
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync as ExecFileSyncLike,
): Partial<Record<string, string>> {
  if (names.length === 0) {
    return {};
  }

  const command = buildWindowsEnvironmentCaptureCommand(names);
  const args = [
    "-NoLogo",
    ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
    "-NonInteractive",
    "-Command",
    command,
  ];

  for (const shell of WINDOWS_SHELL_CANDIDATES) {
    try {
      const output = execFile(shell, args, { encoding: "utf8", timeout: 5000 });

      const environment: Partial<Record<string, string>> = {};
      for (const name of names) {
        const value = extractEnvironmentValue(output, name);
        if (value !== undefined) {
          environment[name] = value;
        }
      }
      return environment;
    } catch {
      continue;
    }
  }

  return {};
}

/** Injectable for tests; defaults to really running PowerShell. */
export const WindowsShellEnvironment = Context.Reference<WindowsShellEnvironmentReader>(
  "@app/shared/shell/WindowsShellEnvironment",
  {
    defaultValue: () => readEnvironmentFromWindowsShell,
  },
);

/**
 * Per-user install locations that Windows tooling routinely writes to without
 * putting them on the machine `PATH`.
 */
export function resolveKnownWindowsCliDirs(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const appData = env["APPDATA"]?.trim();
  const localAppData = env["LOCALAPPDATA"]?.trim();
  const userProfile = env["USERPROFILE"]?.trim();

  return [
    ...(appData ? [`${appData}\\npm`] : []),
    ...(localAppData ? [`${localAppData}\\Programs\\nodejs`, `${localAppData}\\Volta\\bin`] : []),
    ...(localAppData ? [`${localAppData}\\pnpm`] : []),
    ...(userProfile
      ? [`${userProfile}\\.local\\bin`, `${userProfile}\\.bun\\bin`, `${userProfile}\\scoop\\shims`]
      : []),
  ];
}

function readWindowsEnvironmentSafely(
  readEnvironment: WindowsShellEnvironmentReader,
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
): Partial<Record<string, string>> {
  try {
    return readEnvironment(names, options);
  } catch {
    return {};
  }
}

/**
 * The Windows counterpart: read `PATH` from PowerShell (`-NoProfile`, so a slow
 * or interactive profile cannot stall startup), then layer the known per-user
 * CLI directories on top of whatever we inherited.
 *
 * Returns a patch to apply to the environment rather than mutating it, so the
 * caller decides what to do with it.
 */
export const resolveWindowsEnvironment = Effect.fn("shell.resolveWindowsEnvironment")(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Partial<NodeJS.ProcessEnv>> {
  const readEnvironment = yield* WindowsShellEnvironment;
  const inheritedPath = readEnvPath(env);
  const shellPath = readWindowsEnvironmentSafely(readEnvironment, ["PATH"], {
    loadProfile: false,
  })["PATH"];
  const mergedPath = mergePathValues(shellPath, inheritedPath, "win32");
  const knownCliPath = resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER);
  const baselinePath = mergePathValues(knownCliPath, mergedPath, "win32");
  return baselinePath ? { PATH: baselinePath } : {};
});
