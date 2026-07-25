import type { CommitSha, Journey, PullRequestJourneyState, ReadState } from "@app/contracts";
import { deriveProgress } from "@app/journey/progress";

export const derivePullRequestJourneyState = (
  journey: Journey,
  readState: ReadState | null | undefined,
  currentHeadSha: CommitSha,
): PullRequestJourneyState => {
  const progress = deriveProgress(journey, readState).journey;
  return {
    journeyId: journey.id,
    progress: progress.fraction,
    markedFiles: progress.markedFiles,
    clusterFiles: progress.clusterFiles,
    stale: journey.pinned.headSha !== currentHeadSha,
    pinnedHeadSha: journey.pinned.headSha,
  };
};
