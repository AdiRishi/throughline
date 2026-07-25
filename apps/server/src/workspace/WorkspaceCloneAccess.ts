// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { GitHubOwner, GitHubRepositoryName } from "@app/contracts";

import * as GitHub from "../github/GitHub.ts";

export interface CloneAccess {
  readonly remoteUrl: string;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

export class WorkspaceCloneAccessError extends Schema.TaggedErrorClass<WorkspaceCloneAccessError>()(
  "WorkspaceCloneAccessError",
  {
    detail: Schema.String,
  },
) {}

export class WorkspaceCloneAccess extends Context.Service<
  WorkspaceCloneAccess,
  {
    readonly get: (repository: {
      readonly owner: GitHubOwner;
      readonly repo: GitHubRepositoryName;
    }) => Effect.Effect<CloneAccess, WorkspaceCloneAccessError>;
  }
>()("@app/server/workspace/WorkspaceCloneAccess") {}

export const layer = (service: WorkspaceCloneAccess["Service"]) =>
  Layer.succeed(WorkspaceCloneAccess, WorkspaceCloneAccess.of(service));

export const make = Effect.map(GitHub.GitHub, (github) =>
  WorkspaceCloneAccess.of({
    get: ({ owner, repo }) =>
      github.cloneCredentials().pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceCloneAccessError({
              detail: error.detail,
            }),
        ),
        Effect.map((credential) => ({
          remoteUrl: `https://github.com/${owner}/${repo}.git`,
          environment: {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${NodeBuffer.Buffer.from(
              `${credential.username}:${credential.password}`,
            ).toString("base64")}`,
          },
        })),
      ),
  }),
);

export const liveLayer = Layer.effect(WorkspaceCloneAccess, make);
