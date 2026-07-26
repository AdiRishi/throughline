# One Harness Session Per Narration Run

Stage 1 (the plan) uses one harness session for the whole stage, including its repair rounds. Stage 2 opens a **fresh session per cluster**, and one more for the Overview.

Repair rounds belong in the same conversation: a correction is a correction _to that answer_, and resuming the thread is what makes it cost one cheap turn instead of a re-read of the whole diff. But narration runs are not corrections of each other. Giving each cluster its own session is what makes the technical spec's claim true — "each run's context is one cluster deep, not forty thousand lines wide" — and it is what will let these run in parallel later without touching anything else in the pipeline.

Reusing one session for every cluster would have been simpler to write and is the tempting shape. It is wrong twice: context grows without bound across a large journey, and cluster N's prose starts being shaped by cluster N−1's conversation rather than by cluster N's code.

There is a harness-specific trap behind this that is easy to reintroduce. In the Codex SDK a `Thread` models **one turn**: calling `runStreamed` on the same instance twice spawns no process and never settles, wedging the job with nothing alive to point at. Continuing a conversation means `resumeThread(threadId, …)` with the id captured from the `thread.started` event. Every harness turn also carries a hard timeout, because "the agent always commits" is only an invariant if every rung of the ladder terminates.
