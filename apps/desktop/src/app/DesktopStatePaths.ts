export type JoinPath = (first: string, ...segments: string[]) => string;

// Development and production keep their state in sibling directories under the
// app-data base, so a `pnpm dev:desktop` run and an installed build never share
// `desktop-settings.json`, logs, or the Chromium profile.
export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
}): string {
  return input.joinPath(input.baseDir, input.isDevelopment ? "dev" : "userdata");
}
