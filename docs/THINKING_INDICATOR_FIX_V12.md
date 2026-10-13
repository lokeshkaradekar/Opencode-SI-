# Thinking indicator fix v12

## Why v9–v11 did not fix it
Those versions each fixed a real, separate problem in the render/reconciliation path
(`ensureActiveActivity`, the render fast-path's stale length check, and activity-record
creation on session reopen). All three are legitimate and are kept. None of them touched
the actual mechanism that stops the indicator from ever updating again after the first
one or two chats, which lives in a different part of the lifecycle: the native
`opencode.task` completion event and its interaction with the JS poll loop's `runId`
guard.

## Confirmed root cause
`app/js/agent.js`'s `Agent.poll()` is the only thing that reads task progress from the
server and drives the activity card. Each call increments `this.runId` and captures it
as `run`; every tick of that loop's `tick()` function checks `self.runId !== run` and
silently stops once a newer run exists. This guard is correct and is what makes a
*genuinely* superseded poll (cancel, restart, project switch) stop cleanly.

Separately, the native (Java) side fires one `opencode.task` event per task completion,
carrying only `sessionId` — `OpenCodeAgent.java`'s task table is keyed by `sessionId`
alone, and every message sent within one chat reuses the same `sessionId`
(`sendMessage()`'s `sameProject` check keeps the existing session). So a same-session
`opencode.task` event does not identify *which* task finished — only that *some* task on
this session did.

The old handler for that event was:

```js
Bridge.on('opencode.task', function (d) {
  ...
  if (Agent.status === 'working') {
    var rec = /* find the current activity record */;
    Agent.poll(rec);           // <-- always starts a NEW run
  }
});
```

Android's event delivery across the JS bridge is not guaranteed to be prompt or
exactly-once (the event is posted from a background thread in `OpenCodeAgent.fire()`,
subject to GC pauses, Doze/background throttling, and WebView message-queue lag). When a
task's completion event was delayed and arrived **after the next task had already
started and was still genuinely running**, the handler still matched on `sessionId` (same
session), saw `Agent.status === 'working'` (true — task N+1 was running), and called
`Agent.poll(rec)` again. That increments `runId`, which immediately orphans task N+1's
own in-flight poll loop: when its real response eventually arrives, `self.runId !== run`
is now true and the response is silently discarded. `Agent.status` never leaves
`'working'`, nothing is left running to resolve it, and the activity card freezes. The
header keeps saying "working" with no visible progress — exactly the reported symptom,
and it reproduces more easily the more tasks have run in the same chat (more
opportunities for the race), which matches "works for the first chat or two, then
stops."

### Reproduction (before the fix)
A new regression test sends two tasks back to back and fires the native event for task 1
while task 2's own poll is genuinely still in flight:
- `runId` jumps from 3 → 4 the instant the delayed event fires.
- A third, untracked `agentStatus()` call is started.
- Task 2's real server response (the second mocked call) never resolves anything visible
  again — `Agent.status` stays `'working'` forever.

## Fix
Gave each task its own identity, independent of `runId`:

- `Agent.taskId` is bumped once per `sendMessage()`/`resume()`/session-restore-poll call.
- `Agent.pollingTaskId` / `Agent.activePollRun` record which task and which run the live
  poll loop currently belongs to.
- `Agent.poll(rec, taskId)` now checks first: if `taskId` matches the task already being
  watched by a **still-current** run, it does not start a new run. It sets a `pollNudged`
  flag and returns the existing loop's promise.
- Inside the loop, the `setTimeout` wait between ticks is replaced with a `wait()` that
  also resolves early when `pollNudged` is set, so a same-task nudge still achieves the
  original goal (reconcile sooner than the next 1.5s tick) — it just does so by waking the
  existing loop instead of spawning a competing one.
- The `opencode.task` handler now passes `Agent.pollingTaskId` instead of blindly calling
  `Agent.poll(rec)`, so a stale/duplicate/delayed event for a task that's no longer the
  live one cannot match and cannot start a new run either (the task-id check fails, and
  `Agent.status` won't be `'working'` once the real task has finished via its own loop).

No other behavior changes: workspace alignment, Build/Plan mode, Restart Chat, undo,
session reopening, and task archiving are untouched.

## Files changed
- `app/js/agent.js` — the fix described above (`P.poll`, `sendMessage`, `resume`,
  `openSession`, `P.load`'s restart-recovery path, and the `opencode.task` listener).
- `tests/frontend/opencode.test.js` — updated the one existing test that encoded the old
  (buggy) behavior as expected (asserting the same-session event *always* bumps `runId`),
  and added a new test reproducing the exact delayed-event-across-tasks race.
- `tests/frontend/agent-thinking-indicator-regression.test.js` — new, ten-consecutive-task
  regression suite (see below).
- `package.json` — wired the new regression file into `npm run test:frontend`.

## Tests executed (real results)
```
npm test
```
- `test:daemon` (Python/unittest): **71 tests — all passed**
- `test:frontend` (Node's built-in test runner): **70 tests — all passed**, across
  `bridge.test.js`, `terminal.test.js`, `opencode.test.js`, `agent.test.js`, and the new
  `agent-thinking-indicator-regression.test.js`
- `test:java`: **55 + 5 + 206 checks — all passed** (unaffected by this change; run for
  completeness)

No test failed or timed out in the final run. One pre-existing test
(`opencode.test.js`, "the same-session opencode.task event reconciles immediately...")
had to be rewritten because it asserted the old, buggy `runId`-always-bumps behavior as
correct; its replacement — plus a second, new test — assert the corrected contract
instead and both pass.

### New regression coverage (`agent-thinking-indicator-regression.test.js`)
1. Ten consecutive tasks, each verified to show Thinking immediately after starting, with
   a stale native completion event from the *previous* task fired during every single one
   — all ten complete and show their real replies.
2. Tool activity updates land on the correct (current) card across many tasks, never a
   stale one.
3. A new task starts polling cleanly after the previous one completes.
4. Switching sessions (`openSession`) does not leave stale activity state behind.
5. Restart Chat does not break the next task's polling.
6. A transient poll failure (a few failed status reads) recovers and still resolves.
7. A late event from an old, already-superseded task cannot modify the new task's record.
8. Reopening an active session restores its activity indicator correctly.
9. Repeated/duplicate native nudges never create duplicate activity cards.
10. Header "working" status and the presence of a live activity card stay consistent
    across a long run of nudged tasks.

## Applying this to the existing Sketchware Pro project
Only `app/js/agent.js` changed on the production side (plus the test files, which are not
shipped in the APK). To apply:
1. In the Sketchware Pro project, locate the WebView asset bundle (or wherever
   `app/js/agent.js` is packaged — typically under the app's `assets/www/js/` or
   equivalent asset folder for this project).
2. Replace that single file's contents with the `app/js/agent.js` from this ZIP.
3. No Java file changed — the Java↔JS bridge contract (`Bridge.on('opencode.task', ...)`,
   `agentStatus`, `agentSend`, etc.) is unchanged; nothing on the Termux daemon or
   `OpenCodeAgent.java` side needs to change.
4. Rebuild the APK as usual in Sketchware Pro. No new permissions, no new native methods.

## Device-testing checklist (not yet performed — see distinction below)
This fix has been verified at the source/unit-test level only, inside this sandboxed
environment (Node's test runner, mocked `Bridge`). It has **not** been tested on an actual
Android device or inside the real WebView/Sketchware Pro shell, and no claim is made that
it has. Before considering this resolved in practice, please verify on the real device:

- [ ] Send 10 consecutive messages in the same chat, waiting for each task to finish
      before sending the next. Confirm the Thinking/activity card appears and updates for
      every one of the 10, not just the first one or two.
- [ ] Repeat with shorter gaps between messages (sending the next as soon as the previous
      finishes) to maximize the chance of the native-event race actually firing.
- [ ] While a task is running, switch to another app tab (Files/Terminal/Git/Health) and
      back to SI — confirm the live Thinking/activity card is still present and updating.
- [ ] Background the app (press Home) while a task is running, then return — confirm
      polling resumes and the card reflects real progress, not a frozen state.
- [ ] Use Restart Chat, then send several more consecutive messages — confirm the
      indicator keeps working afterward, not just for the first message post-restart.
- [ ] Switch projects mid-task (if reachable) and confirm no stale indicator appears in
      the new project's chat.
- [ ] Reopen a previously-run (completed) session from the task history list and confirm
      no indicator issues on subsequent new messages sent from that reopened chat.
- [ ] Watch `adb logcat` (or the in-app WebView console if available) during the above for
      any JavaScript exceptions — none should appear tied to activity rendering or
      polling.

## Verification performed vs. not performed
- **Performed (code-level):** full `npm test` run (daemon + frontend + Java), including a
  dedicated reproduction of the exact race condition before the fix and confirmation it no
  longer occurs after the fix; a 10-consecutive-task regression suite; review of every
  `poll()` call site and every `runId`/`activeActivity`/`pollingTaskId` reset path.
- **Not performed:** running the app on a physical Android device or inside Sketchware
  Pro's actual WebView. The checklist above lists exactly what still needs to happen there
  before this can be called fixed in production. If the device testing surfaces further
  issues, they are most likely WebView/Android lifecycle-specific (backgrounding, Doze,
  process death) rather than a repeat of this exact race, since the fix removes the
  specific mechanism (`runId` being bumped by a same-session, different-task event) that
  caused the originally reported symptom.
