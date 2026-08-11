import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  extractEnvironmentValue,
  listLoginShellCandidates,
  mergePathValues,
  readEnvironmentFromLoginShell,
  readEnvironmentFromWindowsShell,
  readPathFromLaunchctl,
  readPathFromLoginShell,
  resolveKnownWindowsCliDirs,
  resolveWindowsEnvironment,
  WindowsShellEnvironment,
  type ExecFileSyncLike,
} from "../src/shell.ts";

describe("listLoginShellCandidates", () => {
  it("prefers $SHELL, then the account shell, then the platform default", () => {
    assert.deepEqual(listLoginShellCandidates("darwin", "/bin/fish", "/bin/bash"), [
      "/bin/fish",
      "/bin/bash",
      "/bin/zsh",
    ]);
  });

  it("drops blanks and duplicates without losing order", () => {
    assert.deepEqual(listLoginShellCandidates("linux", "   ", "/bin/bash"), ["/bin/bash"]);
    assert.deepEqual(listLoginShellCandidates("linux", "/bin/bash", "/bin/bash"), ["/bin/bash"]);
  });

  it("has no fallback shell on win32", () => {
    // Empty rather than `undefined`: an omitted `userShell` falls back to the
    // real account shell, which would make this depend on the host.
    assert.deepEqual(listLoginShellCandidates("win32", "", ""), []);
  });
});

describe("mergePathValues", () => {
  it("keeps the preferred value's entries ahead of the inherited ones", () => {
    assert.equal(
      mergePathValues("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", "linux"),
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  // Quotes and case are normalized for the duplicate check only; the entry is
  // emitted exactly as written, because Windows tooling does accept quoted
  // segments and rewriting them is not this function's job.
  it("dedupes win32 entries case-insensitively without rewriting them", () => {
    assert.equal(
      mergePathValues('"C:\\Tools";C:\\Node', "c:\\tools;C:\\Other", "win32"),
      '"C:\\Tools";C:\\Node;C:\\Other',
    );
  });

  it("is undefined when nothing survives", () => {
    assert.isUndefined(mergePathValues(undefined, "   ", "linux"));
  });
});

describe("readEnvironmentFromLoginShell", () => {
  // The whole point of the fenced markers: a login shell prints the user's
  // profile banners too, and none of that is the value we asked for.
  it("reads only the fenced value out of noisy profile output", () => {
    const execFile: ExecFileSyncLike = (_file, args) => {
      const command = args[1] ?? "";
      const start = command.slice(
        command.indexOf("__APP_ENV_PATH_START__"),
        command.indexOf("__APP_ENV_PATH_START__") + "__APP_ENV_PATH_START__".length,
      );
      return [
        "Welcome to your shell!",
        start,
        "/opt/homebrew/bin:/usr/bin",
        "__APP_ENV_PATH_END__",
        "have a nice day",
      ].join("\n");
    };

    assert.equal(readPathFromLoginShell("/bin/zsh", execFile), "/opt/homebrew/bin:/usr/bin");
  });

  it("invokes the shell as both interactive and login", () => {
    const seen: Array<ReadonlyArray<string>> = [];
    const execFile: ExecFileSyncLike = (_file, args) => {
      seen.push(args);
      return "";
    };

    readEnvironmentFromLoginShell("/bin/zsh", ["PATH"], execFile);
    assert.equal(seen[0]?.[0], "-ilc");
  });

  it("does nothing when asked for no names", () => {
    const execFile: ExecFileSyncLike = () => {
      throw new Error("should not run");
    };
    assert.deepEqual(readEnvironmentFromLoginShell("/bin/zsh", [], execFile), {});
  });
});

describe("extractEnvironmentValue", () => {
  it("is undefined when the fence is absent or unterminated", () => {
    assert.isUndefined(extractEnvironmentValue("nothing here", "PATH"));
    assert.isUndefined(extractEnvironmentValue("__APP_ENV_PATH_START__\n/usr/bin", "PATH"));
  });

  it("is undefined for an empty value", () => {
    assert.isUndefined(
      extractEnvironmentValue("__APP_ENV_PATH_START__\n__APP_ENV_PATH_END__", "PATH"),
    );
  });
});

describe("readPathFromLaunchctl", () => {
  it("returns the trimmed value", () => {
    const execFile: ExecFileSyncLike = () => "/usr/bin:/bin\n";
    assert.equal(readPathFromLaunchctl(execFile), "/usr/bin:/bin");
  });

  it("swallows a launchctl failure", () => {
    const execFile: ExecFileSyncLike = () => {
      throw new Error("launchctl missing");
    };
    assert.isUndefined(readPathFromLaunchctl(execFile));
  });
});

describe("readEnvironmentFromWindowsShell", () => {
  it("falls through to powershell.exe when pwsh.exe is unavailable", () => {
    const attempted: string[] = [];
    const execFile: ExecFileSyncLike = (file) => {
      attempted.push(file);
      if (file === "pwsh.exe") throw new Error("not installed");
      return "__APP_ENV_PATH_START__\r\nC:\\Node\r\n__APP_ENV_PATH_END__";
    };

    assert.deepEqual(readEnvironmentFromWindowsShell(["PATH"], {}, execFile), {
      PATH: "C:\\Node",
    });
    assert.deepEqual(attempted, ["pwsh.exe", "powershell.exe"]);
  });

  it("passes -NoProfile unless the profile was explicitly requested", () => {
    const seen: Array<ReadonlyArray<string>> = [];
    const execFile: ExecFileSyncLike = (_file, args) => {
      seen.push(args);
      return "";
    };

    readEnvironmentFromWindowsShell(["PATH"], {}, execFile);
    assert.include(seen[0] ?? [], "-NoProfile");

    seen.length = 0;
    readEnvironmentFromWindowsShell(["PATH"], { loadProfile: true }, execFile);
    assert.notInclude(seen[0] ?? [], "-NoProfile");
  });
});

describe("resolveKnownWindowsCliDirs", () => {
  it("only lists directories whose base variable is set", () => {
    assert.deepEqual(resolveKnownWindowsCliDirs({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }), [
      "C:\\Users\\a\\AppData\\Roaming\\npm",
    ]);
    assert.deepEqual(resolveKnownWindowsCliDirs({}), []);
  });
});

describe("resolveWindowsEnvironment", () => {
  it.effect("layers the known CLI dirs and the shell PATH over the inherited one", () =>
    Effect.gen(function* () {
      const patch = yield* resolveWindowsEnvironment({
        Path: "C:\\Windows",
        APPDATA: "C:\\Users\\a\\Roaming",
      }).pipe(Effect.provideService(WindowsShellEnvironment, () => ({ PATH: "C:\\Node" })));

      assert.equal(patch.PATH, "C:\\Users\\a\\Roaming\\npm;C:\\Node;C:\\Windows");
    }),
  );

  it.effect("still returns the inherited PATH when the shell probe throws", () =>
    Effect.gen(function* () {
      const patch = yield* resolveWindowsEnvironment({ PATH: "C:\\Windows" }).pipe(
        Effect.provideService(WindowsShellEnvironment, () => {
          throw new Error("powershell blocked by policy");
        }),
      );

      assert.equal(patch.PATH, "C:\\Windows");
    }),
  );
});
