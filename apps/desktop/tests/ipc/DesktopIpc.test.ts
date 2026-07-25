import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { vi } from "vitest";

import * as DesktopIpc from "../../src/ipc/DesktopIpc.ts";

const invokeMethod: DesktopIpc.DesktopIpcMethod<never, never> = {
  channel: "desktop.test.invoke",
  handler: () => Effect.void,
};

const syncMethod: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
  channel: "desktop.test.sync",
  handler: () => Effect.void,
};

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn<(channel: string) => void>(),
    handle: vi.fn<(channel: string, listener: DesktopIpc.DesktopIpcHandleListener) => void>(),
    removeAllListeners: vi.fn<(channel: string) => void>(),
    on: vi.fn<(channel: string, listener: DesktopIpc.DesktopIpcSyncListener) => void>(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect("preserves invoke registration context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("invoke registration failed");
      const ipcMain = makeIpcMain({
        handle: () => {
          throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const error = yield* Effect.flip(Effect.scoped(ipc.handle(invokeMethod)));

      assert.instanceOf(error, DesktopIpc.DesktopIpcRegistrationError);
      assert.isTrue(DesktopIpc.isDesktopIpcError(error));
      assert.strictEqual(error.handlerKind, "invoke");
      assert.strictEqual(error.channel, invokeMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "invoke");
      assert.include(error.message, invokeMethod.channel);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("preserves sync unregistration context and cause in the finalizer defect", () =>
    Effect.gen(function* () {
      const cause = new Error("sync unregistration failed");
      let removeCount = 0;
      const ipcMain = makeIpcMain({
        removeAllListeners: () => {
          removeCount += 1;
          if (removeCount === 2) throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const exit = yield* Effect.exit(Effect.scoped(ipc.handleSync(syncMethod)));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, DesktopIpc.DesktopIpcUnregistrationError);
      assert.isTrue(DesktopIpc.isDesktopIpcError(error));
      assert.strictEqual(error.handlerKind, "sync");
      assert.strictEqual(error.channel, syncMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("keeps the desktop run id on asynchronous invoke callback logs", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipcMain = makeIpcMain({
        handle: (_channel, registered) => {
          listener = registered;
        },
      });
      const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const recordingLogger = Logger.make((options) => {
        records.push(Logger.formatStructured.log(options));
      });
      const method: DesktopIpc.DesktopIpcMethod<never, never> = {
        channel: "desktop.test.callback",
        handler: () => Effect.logInfo("ipc callback handled"),
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* DesktopIpc.make(ipcMain).handle(method);
          if (listener === undefined) {
            return yield* Effect.die("invoke listener was not registered");
          }
          yield* Effect.promise(() => Promise.resolve(listener?.({}, undefined)));
        }),
      ).pipe(
        Effect.annotateLogs({ scope: "desktop", runId: "ipc-run-test" }),
        Effect.provide(Logger.layer([recordingLogger])),
      );

      const record = records.find((candidate) => candidate.message === "ipc callback handled");
      assert.equal(record?.annotations.runId, "ipc-run-test");
      assert.equal(record?.annotations.channel, method.channel);
    }),
  );

  it.effect("logs asynchronous invoke failures without their sensitive detail", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipcMain = makeIpcMain({
        handle: (_channel, registered) => {
          listener = registered;
        },
      });
      const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const recordingLogger = Logger.make((options) => {
        records.push(Logger.formatStructured.log(options));
      });
      const failure = {
        _tag: "ExpectedInvokeFailure",
        message: "invoke-secret-sentinel",
      } as const;
      const method: DesktopIpc.DesktopIpcMethod<typeof failure, never> = {
        channel: "desktop.test.invoke-failure",
        handler: () => Effect.fail(failure),
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* DesktopIpc.make(ipcMain).handle(method);
          if (listener === undefined) {
            return yield* Effect.die("invoke listener was not registered");
          }
          const invoke = listener;
          const rejected = yield* Effect.promise(() =>
            Promise.resolve(invoke({}, undefined)).then(
              () => false,
              () => true,
            ),
          );
          assert.isTrue(rejected);
        }),
      ).pipe(
        Effect.annotateLogs({ scope: "desktop", runId: "ipc-failure-run-test" }),
        Effect.provide(Logger.layer([recordingLogger])),
      );

      const record = records.find(
        (candidate) => candidate.message === "desktop IPC operation failed",
      );
      assert.equal(record?.level, "WARN");
      assert.equal(record?.annotations.component, "desktop-ipc");
      assert.equal(record?.annotations.channel, method.channel);
      assert.equal(record?.annotations.errorType, failure._tag);
      assert.equal(record?.annotations.runId, "ipc-failure-run-test");
      assert.notInclude(JSON.stringify(record), failure.message);
    }),
  );

  it.effect("logs synchronous invoke defects without their sensitive detail", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcSyncListener | undefined;
      const ipcMain = makeIpcMain({
        on: (_channel, registered) => {
          listener = registered;
        },
      });
      const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const recordingLogger = Logger.make((options) => {
        records.push(Logger.formatStructured.log(options));
      });
      const sensitiveMessage = "sync-secret-sentinel";
      const method: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
        channel: "desktop.test.sync-failure",
        handler: () => Effect.die(new TypeError(sensitiveMessage)),
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* DesktopIpc.make(ipcMain).handleSync(method);
          if (listener === undefined) {
            return yield* Effect.die("sync listener was not registered");
          }
          const invoke = listener;
          const threw = yield* Effect.sync(() => {
            try {
              invoke({ returnValue: undefined });
              return false;
            } catch {
              return true;
            }
          });
          assert.isTrue(threw);
        }),
      ).pipe(
        Effect.annotateLogs({ scope: "desktop", runId: "ipc-defect-run-test" }),
        Effect.provide(Logger.layer([recordingLogger])),
      );

      const record = records.find(
        (candidate) => candidate.message === "desktop IPC operation failed",
      );
      assert.equal(record?.level, "WARN");
      assert.equal(record?.annotations.component, "desktop-ipc");
      assert.equal(record?.annotations.channel, method.channel);
      assert.equal(record?.annotations.errorType, "TypeError");
      assert.equal(record?.annotations.runId, "ipc-defect-run-test");
      assert.notInclude(JSON.stringify(record), sensitiveMessage);
    }),
  );
});
