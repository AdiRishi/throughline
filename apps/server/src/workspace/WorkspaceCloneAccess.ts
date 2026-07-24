import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { GitHubOwner, GitHubRepositoryName } from "@app/contracts";

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
