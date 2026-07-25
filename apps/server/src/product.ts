import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as JourneyAnalysis from "./analysis/JourneyAnalysis.ts";
import * as ServerConfig from "./config.ts";
import * as GitHub from "./github/GitHub.ts";
import * as AnalysisHarness from "./harness/AnalysisHarness.ts";
import * as Ingestion from "./ingestion/Ingestion.ts";
import * as JourneyStore from "./journeys/JourneyStore.ts";
import * as ProcessRunner from "./process/ProcessRunner.ts";
import * as Workspaces from "./workspace/Workspaces.ts";

const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(config.dataDir, { recursive: true });
    return SqliteClient.layer({
      filename: path.join(config.dataDir, "throughline.db"),
    });
  }),
);

const ProcessRunnerLive = ProcessRunner.layer;
const GitHubLive = GitHub.layer.pipe(Layer.provide(ProcessRunnerLive));
const JourneyStoreLive = JourneyStore.layer.pipe(Layer.provide(DatabaseLive));
const AnalysisHarnessLive = AnalysisHarness.layer;
const JourneyAnalysisLive = JourneyAnalysis.layer.pipe(Layer.provide(AnalysisHarnessLive));
const WorkspacesLive = Workspaces.layer.pipe(
  Layer.provide(Layer.mergeAll(GitHubLive, ProcessRunnerLive)),
);
const IngestionLive = Ingestion.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      GitHubLive,
      AnalysisHarnessLive,
      JourneyAnalysisLive,
      WorkspacesLive,
      JourneyStoreLive,
    ),
  ),
);

export const ProductServicesLive = Layer.mergeAll(
  GitHubLive,
  AnalysisHarnessLive,
  JourneyAnalysisLive,
  WorkspacesLive,
  JourneyStoreLive,
  IngestionLive,
);
