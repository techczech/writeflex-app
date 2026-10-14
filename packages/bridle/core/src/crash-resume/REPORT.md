# Adversarial crash-and-resume findings

## Summary

- **Probe (a) is red: the direct side effect ran twice.** The first process was killed after appending its marker and before Core recorded a capability outcome. Repeating the same prompt in a new process appended a second marker.
- **Probe (b) is red: the Action Proposal side effect ran twice.** The durable Proposal survived, but its in-process Adoption claim did not. The restarted process adopted the still-proposed action again.
- **Probe (c) is red: `continue-recent` exposed no unknown-outcome warning.** The resumed transcript contained the original user message and an empty assistant message. A subsequent prompt could silently issue the same action again.
- **No production code changed.** The red assertions remain in the suite as acceptance tests for the later reliability work.

## Invocation

The suite is opt-in because it spawns and kills three real Bun processes. Run it from the repository root:

```sh
BRIDLE_RUN_CRASH_TESTS=1 bun run check
```

For the diagnostic suite alone:

```sh
BRIDLE_RUN_CRASH_TESTS=1 bun test packages/core/src/crash-resume/adversarial-crash-resume.test.ts
```

The suite ran on 8 August 2026 with Bun 1.3.10 on macOS arm64. All three child processes reached the capability's blocking window and then exited with code 137 after the parent sent `SIGKILL`.

## Probe (a): direct capability call

**Verdict: defect reproduced (red); no execution-outcome guard is present at this seam.**

Observed sequence:

1. A public `createBridle()` handle started a persisted scripted session and received `Perform the action.`.
2. The model called `fixture.side_effect` through the public session path.
3. The capability appended `{"probe":"direct","phase":"crash","value":"same-logical-action",...}` to `side-effects.jsonl`, published its crash-window marker, and blocked.
4. The parent sent `SIGKILL`; the child exited with code 137.
5. A public Recorder query found no matching `policy.decision`, `capability.executed`, or `capability.failed` audit record from the killed execution.
6. A new process opened the same app data directory and received the same `Perform the action.` prompt.
7. The capability appended `{"probe":"direct","phase":"restart","value":"same-logical-action",...}`.
8. The Recorder then exposed `policy.decision` and `capability.executed` for the restarted execution.

The marker file contained **two lines for one logical action**. The safety assertion requires one line and therefore remains red.

## Probe (b): Action Proposal adoption

**Verdict: defect reproduced (red); the Adoption duplicate-suppression claim does not survive process death.**

Observed sequence:

1. A public `createBridle()` handle staged `fixture.side_effect` as an Action Proposal.
2. The Recorder contained one `proposal_created` record.
3. The host called `bridle.proposals.adopt(id)` through the public Proposal store.
4. The capability appended `{"probe":"adoption","phase":"crash","value":"same-logical-action",...}`, published its crash-window marker, and blocked.
5. The parent sent `SIGKILL`; the child exited with code 137 before settlement.
6. A new process opened the same app data directory and found the Proposal still in `proposed` state.
7. Calling `bridle.proposals.adopt(id)` again appended `{"probe":"adoption","phase":"restart","value":"same-logical-action",...}` and settled the Proposal.
8. The Recorder then contained one `proposal_settled` record.

The marker file contained **two lines for one Action Proposal**. The local baseline for this fixture is a stable snapshot anchor so that the existing filesystem stale check does not mask the Adoption claim under test. The safety assertion requires one marker line and therefore remains red.

## Probe (c): resumed session

**Verdict: defect reproduced (red); the model-visible transcript does not surface the interrupted action as an unknown outcome.**

Observed sequence:

1. A public `createBridle()` handle started with `sessionResume: "continue-recent"` and received `Perform the action.`.
2. The model called `fixture.side_effect` through the public session path.
3. The capability appended `{"probe":"resume","phase":"crash","value":"same-logical-action",...}`, published its crash-window marker, and blocked.
4. The parent sent `SIGKILL`; the child exited with code 137.
5. A new process opened the same app data directory with `sessionResume: "continue-recent"`.
6. Before any new prompt, `bridle.transcript()` returned exactly two projected messages: the original user message with text `Perform the action.`, followed by an assistant message with empty text and `isError: false`.
7. The transcript contained no `unknown outcome` or `may have completed` indication and no tool-result message.
8. After `Continue safely.`, the scripted model issued the same logical action. The capability appended `{"probe":"resume","phase":"restart","value":"same-logical-action",...}`.

The marker file contained **two lines for one logical action**. The first safety assertion requires an explicit unknown-outcome indication, and the second requires one marker line. Both remain red; the first failing assertion is the transcript guard.

## Scope and limitations

The child entry script imports Core only through `packages/core/src/index.ts`. It drives `createBridle()`, the exported session factory, `bridle.prompt()`, `bridle.proposals`, `bridle.transcript()`, and the exported Recorder queries. It does not import the executor, Proposal implementation, Recorder store, Pi runtime, or any other internal module.

The fixture's block occurs after the side effect has completed but before the capability returns to the harness. This creates the specified execute-before-outcome-record window deterministically. The suite does not claim that every instruction after a capability returns has been probed; no public seam can pause Core between the capability promise resolving and its next internal durable write without changing production code.
