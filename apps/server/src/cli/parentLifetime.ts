// @effect-diagnostics nodeBuiltinImport:off - The lifetime channel is an inherited OS pipe.
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";

export const waitForParentLifetimeFdClose = Effect.fn("cli.waitForParentLifetimeFdClose")(
  (fd: number) =>
    Effect.callback<void>((resume) => {
      const stream = NodeFS.createReadStream("", { fd, autoClose: false });
      let settled = false;

      const complete = () => {
        if (settled) return;
        settled = true;
        resume(Effect.void);
      };

      stream.once("end", complete);
      stream.once("close", complete);
      stream.once("error", complete);
      stream.resume();

      return Effect.sync(() => {
        settled = true;
        stream.removeListener("end", complete);
        stream.removeListener("close", complete);
        stream.removeListener("error", complete);
        stream.destroy();
      });
    }),
);
