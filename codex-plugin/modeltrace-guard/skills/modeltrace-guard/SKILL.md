---
name: modeltrace-guard
description: Start, configure, inspect or stop background Codex model fingerprint monitoring using disposable forks of a frozen task snapshot. Configure tool intervals, retries and languages; open the dashboard, report mismatches and stop original work when every configured retry mismatches. Installation alone does not enable monitoring.
---

# ModelTrace Guard

Use `../../scripts/guard.mjs` relative to this skill directory; resolve its absolute path. Requires Node.js 18+ and a compatible local Codex app-server runtime. The runner uses Codex's configured account/provider. Generation consumes Codex inference usage; scoring uses the bundled offline ModelTrace bank.

## Enable and configure

Only enable monitoring when the user asks for this task. Installation alone does not enable it. Use the real `CODEX_THREAD_ID`, or a trusted hook's actual session ID if unavailable; never invent a task ID. Preserve a user-defined task name. When a verified app task title is available, pass it to `start --name`; never use the shared workspace name as a task title. The background snapshot also captures the native task title without reading transcript contents. Do not derive a model identity from the classifier's prediction.

Run `node <guard> doctor` to verify bundled files. `doctor --fork true` additionally creates native snapshot/ephemeral forks without inference, checks runtime settings, trusted synchronous tool blocking and native async background hooks, then queues deletion of its temporary base. Read the returned readiness and cleanup status honestly. If runtime selection is ambiguous, the user may set `MODELTRACE_CODEX_PATH` to the absolute executable used by their Codex app. Never fix this by changing an unrelated provider/account or bypassing hook trust.

Run `start` with only the requested overrides:

- `--expected <exact-label>` sets the comparison label; `--expected auto` follows Codex metadata. `models` lists bank labels. Missing metadata and a nonempty unlisted model are different outcomes; neither is a mismatch.
- `--tool-min 16 --tool-max 32` sets a random interval of observed work-tool completions (the default). Equal values fix the interval. Existing tasks retain their saved intervals until configured. No elapsed-time scheduling or turn/task count caps.
- `--retry-count 3` sets additional tests after an initial mismatch; default 3, allowed 1–100. A request such as “复测改成 5 次” maps to `configure --retry-count 5`.
- `--pending-seconds 180` is the issuance-to-completion deadline, not sampling frequency. Changes apply only to newly issued checkpoints.
- `--languages zh,en,ja,ko,fr,de,es,pt,ru,ar` selects the random language pool. Default `zh,en`; one language fixes it.

`configure` updates future scheduling without clearing evidence or counters. The active retry batch retains its original target, language, number count, model comparison, bank and frozen context.

## Fork-only checkpoints

`start` queues the first checkpoint and returns immediately. Native async `SessionStart`, `UserPromptSubmit` and `PostToolUse` hooks run the fork worker in the background; normal task work and its final answer do not wait for normal probes. **Do not execute `probe`, poll status, wait or narrate each normal checkpoint.** Normal results are saved silently for the dashboard and on-demand status. An external terminal's `start` queues work for the target task's next loaded hook; it cannot wake an idle task.

**Never generate, type, copy or submit probe numbers in the monitored task.** Direct `submit --numbers` input is not supported. Never substitute the app's ordinary fork tool, a subagent, another model or a hand-written provider API request when the runner fails. The foreground `probe` command is only a manual diagnostic explicitly requested by the user, not the automatic monitoring path.

The runner creates one native, persisted baseline fork from the task's stored history and never starts a model turn in that baseline. The initial probe and every retry each fork this SAME baseline at the SAME turn boundary. Each probe is ephemeral and text-only; the runner closes its Codex process after completion. Raw arrays remain in the local sample store, not the parent tool result. The shared baseline is deleted after the normal probe or the whole retry batch. A retained baseline can briefly appear in Codex's task list; do not use or edit it. Cleanup refuses original tasks, altered baselines and baselines with new persisted descendants.

The baseline preserves Codex's persisted history, not unseen in-flight memory. A mid-turn fork can contain Codex's interruption marker. Probe arrays stay outside the parent task; its existing messages remain unchanged. Language variation and a fixed prefix do not guarantee an invisible test or a cache hit. Report returned cached-token counts when available; null means unavailable. A fork samples its own continuation, not proof of how an earlier parent request was routed.

On a runner error, report the recorded coverage gap. Do not fabricate a result or fall back to in-context generation. At most one checkpoint runs per task. Probe failures, expiry, compaction, changed comparison conditions and interruptions do not count as mismatches.

## Notify, retry, halt

On `agentAction: notify_user_now`, `stop_and_notify_user`, pending notifications in status, or a trusted notification hook, tell the user before another work tool or the final answer. Include the expected model, first candidate and checkpoint time. Say “fingerprint candidate,” not a verified backend identity or proof of reduced reasoning effort. Describe stronger evidence separately from a weak ranking disagreement.

Only AFTER sending that visible message, execute the returned `acknowledge --alert <ids>` command for the alerts actually described. Acknowledgement is the agent's report, not independent proof of delivery. Do not acknowledge silently.

The initial mismatch starts one bounded retry batch; it is not one of the N retries. Acknowledgement queues the next background fork checkpoint. Pause original work while the worker completes all N, even if one matches. A mismatching retry must be reported and acknowledged; matching retries advance automatically. After acknowledging, use the returned `wait --confirmation <id>` command until the next notification or batch completion. Each wait returns within 30 seconds and only observes progress; it never generates probes. This foreground wait is only for an active anomaly, never normal monitoring. Never start nested batches or capture a new baseline mid-batch. Every retry uses the initial baseline, never a previous child or the now-extended parent task.

Async output reaches the model at Codex's next safe boundary (after the current request/tools). It does not start a new turn in an idle task; an undelivered alert stays queued for the next user turn. The synchronous `PreToolUse` hook also checks pending alerts and confirmation state before supported work tools. Never promise immediate interruption of an already-running action. If the batch completes without a halt, summarize the retries and continue only if the original work is still requested; if interrupted, report the gap and follow the latest user request.

If all N valid retries disagree with the expected model (possibly different alternatives), `taskHalt` persists and supported subsequent work tools are denied by `PreToolUse`. **Stop original task work immediately**, summarize the initial result and all retry candidates, and wait for the user. Do not continue edits, commands, delegation or automatic work. Hosted tools, input to already-running terminals and opted-out tool paths are not a universal cancellation boundary; never claim the plugin killed Codex or cancelled every running action.

Acknowledgement, configuration, model changes and `stop`/`start` do not clear a halt. Only after the user explicitly requests resumption, read the current halt ID and run `resume --halt <current-id>`. Never resume just to finish an earlier assignment.

## Status, restart, dashboard and stopping

`status` reports current evidence, retry progress, hook freshness, background worker state, fork readiness and pending notifications. A startup/resume hook resets runtime verification and schedules an initial check for enabled tasks. Verification requires a new observed work tool and background hook in the current runtime, not just a historical timestamp. Long idle time is “waiting for work activity,” not proof of either healthy monitoring or a failure. Installation does not itself start monitoring or the web server.

On first use or after changed hook definitions, ask the user to review ModelTrace Guard in Codex CLI's `/hooks`. Do not run trust-changing commands on the user's behalf. Reload the updated plugin in a new task when required. If the fork guard is untrusted, inference is refused rather than falling back to an unsafe path.

When asked for the dashboard, run `dashboard` and open the returned local URL. It lists monitored tasks, offers names, configuration, stop controls, full-history paging, live alerts and optional browser desktop notifications. Notifications need permission and an open connected page; do not claim delivery was verified merely because an alert exists. The URL fragment is a local capability: never publish it, send it externally, or remove authentication/Origin protections. The page never exports probe arrays, transcripts or credentials.

`stop` cancels future sampling for this task, interrupts retries and preserves history and any halt. `dashboard-stop` stops only the web service. The web service is not required for hook monitoring. Cleanup of temporary native baselines is tracked separately; report pending/blocked deletion, never describe archiving as deletion. Do not delete unrelated tasks to fix cleanup.

See `../../README.md` for GitHub installation, cleanup diagnostics, storage and offline evaluation details. The bank is a packaged snapshot; do not collect or expand fingerprints unless the user separately requests it. Synthetic tests and score parity are not independent long-context/multilingual calibration.
