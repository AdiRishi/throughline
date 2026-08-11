import { assert, beforeEach, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BrowserWindow } from "electron";
import { vi } from "vitest";

const { showMessageBoxMock, showOpenDialogMock, showErrorBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn<(...args: ReadonlyArray<unknown>) => Promise<unknown>>(),
  showOpenDialogMock: vi.fn<(...args: ReadonlyArray<unknown>) => Promise<unknown>>(),
  showErrorBoxMock: vi.fn<(title: string, content: string) => void>(),
}));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: showMessageBoxMock,
    showOpenDialog: showOpenDialogMock,
    showErrorBox: showErrorBoxMock,
  },
}));

import * as ElectronDialog from "../../src/electron/ElectronDialog.ts";

describe("ElectronDialog", () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset();
    showOpenDialogMock.mockReset();
    showErrorBoxMock.mockReset();
  });

  it.effect("preserves folder picker request context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("folder picker failed");
      const owner = { id: 7 } as BrowserWindow;
      showOpenDialogMock.mockRejectedValue(cause);
      const dialog = yield* ElectronDialog.ElectronDialog;

      const error = yield* Effect.flip(
        dialog.pickFolder({
          owner: Option.some(owner),
          defaultPath: Option.some("/workspace"),
          title: Option.none(),
        }),
      );

      assert.instanceOf(error, ElectronDialog.ElectronDialogPickFolderError);
      assert.strictEqual(error.ownerWindowId, 7);
      assert.strictEqual(error.defaultPath, "/workspace");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "window 7");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("preserves confirmation request context without leaking the prompt", () =>
    Effect.gen(function* () {
      const cause = new Error("message box failed");
      showMessageBoxMock.mockRejectedValue(cause);
      const dialog = yield* ElectronDialog.ElectronDialog;

      const error = yield* Effect.flip(
        dialog.confirm({ owner: Option.none(), message: "Discard changes?" }),
      );

      assert.instanceOf(error, ElectronDialog.ElectronDialogConfirmError);
      assert.isNull(error.ownerWindowId);
      assert.strictEqual(error.promptLength, "Discard changes?".length);
      assert.notProperty(error, "dialogMessage");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "Discard changes?");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("preserves error box request context and cause in the defect", () =>
    Effect.gen(function* () {
      const cause = new Error("error box failed");
      showErrorBoxMock.mockImplementation(() => {
        throw cause;
      });
      const dialog = yield* ElectronDialog.ElectronDialog;

      const exit = yield* Effect.exit(dialog.showErrorBox("Startup failed", "Could not start."));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, ElectronDialog.ElectronDialogShowErrorBoxError);
      assert.strictEqual(error.titleLength, "Startup failed".length);
      assert.strictEqual(error.contentLength, "Could not start.".length);
      assert.notProperty(error, "title");
      assert.notProperty(error, "content");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "Startup failed");
      assert.notInclude(error.message, "Could not start.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );
});
