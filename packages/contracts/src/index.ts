// Schema-only shared contracts. No runtime logic lives here — this package is
// the typed boundary between the shell, the server, and the renderer.
export * from "./baseSchemas.ts";
export * from "./auth.ts";
export * from "./server.ts";
export * from "./desktop.ts";
export * from "./ipc.ts";
export * from "./github.ts";
export * from "./journey.ts";
export * from "./harness.ts";
export * from "./ingestion.ts";
export * from "./productRpc.ts";
export * from "./rpc.ts";
