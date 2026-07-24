import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHubReadError, PrRef, TrimmedNonEmptyString } from "@app/contracts";

import * as GitHub from "../../src/github/GitHub.ts";
import * as CloneAccess from "../../src/workspace/WorkspaceCloneAccess.ts";

const decodePrRef = Schema.decodeUnknownSync(PrRef);
const decodeDetail = Schema.decodeUnknownSync(TrimmedNonEmptyString);

const unused = <A>(): Effect.Effect<A> => Effect.die("Unexpected GitHub test call.");

const githubWithCredentials = (
  cloneCredentials: GitHub.GitHub["Service"]["cloneCredentials"],
): GitHub.GitHub["Service"] =>
  GitHub.GitHub.of({
    identity: () => unused(),
    repositories: () => unused(),
    pullRequests: () => unused(),
    openPrs: () => unused(),
    recentlyMergedPrs: () => unused(),
    pr: () => unused(),
    refreshPrs: () => unused(),
    retry: () => unused(),
    resolveUrl: () => unused(),
    cloneCredentials,
  });

describe("WorkspaceCloneAccess", () => {
  it.effect("keeps the token out of argv and supplies one scoped Git header", () =>
    Effect.gen(function* () {
      const github = githubWithCredentials(() =>
        Effect.succeed({
          username: "x-access-token",
          password: "secret-token",
        }),
      );
      const access = yield* CloneAccess.make.pipe(Effect.provideService(GitHub.GitHub, github));
      const pr = decodePrRef({ owner: "octo", repo: ".github", number: 1 });

      const result = yield* access.get({ owner: pr.owner, repo: pr.repo });

      assert.strictEqual(result.remoteUrl, "https://github.com/octo/.github.git");
      assert.notInclude(result.remoteUrl, "secret-token");
      assert.deepStrictEqual(result.environment, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_0: "Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0LXRva2Vu",
      });
    }),
  );

  it.effect("maps credential failures without losing their user-facing detail", () =>
    Effect.gen(function* () {
      const failure = new GitHubReadError({
        reason: "unauthenticated",
        detail: decodeDetail("Run gh auth login."),
      });
      const github = githubWithCredentials(() => Effect.fail(failure));
      const access = yield* CloneAccess.make.pipe(Effect.provideService(GitHub.GitHub, github));
      const pr = decodePrRef({ owner: "octo", repo: "widgets", number: 1 });

      const error = yield* access.get({ owner: pr.owner, repo: pr.repo }).pipe(Effect.flip);

      assert.instanceOf(error, CloneAccess.WorkspaceCloneAccessError);
      assert.strictEqual(error.detail, failure.detail);
    }),
  );
});
