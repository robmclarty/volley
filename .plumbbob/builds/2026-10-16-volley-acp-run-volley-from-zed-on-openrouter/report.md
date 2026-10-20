# Report: volley acp: run volley from Zed on OpenRouter

## What shipped

volley now runs from Zed's agent panel, and either seat can run on OpenRouter.

- **OpenRouter seats (step 1).** One `OPENROUTER_API_KEY` runs both seats, Claude included, from the plain CLI first, through fascicle's native transport and the same containment gate and preflight as a local builder.
- **Plumbing (steps 2-4).** `run_volley` takes per-seat tools, a builder approval handler, and an outside trajectory sink, and runs exactly as before without them. `--state-dir` moves run state out of the workspace. Under acp, the seats get fascicle's workspace tools and prompts that name them.
- **`volley acp` (steps 5-7).** It serves volley over stdio through `serve_acp`, one fresh run per prompt on the session's folder. Zed shows a **Round N** line per round, the check as a command card, the critic's verdict as a thought, and a closing summary. Uncontained, every builder command and every check asks first, and neither can read a seat's API key.
- **Proof and docs (steps 8-10).** An in-process ACP client drives a whole turn against a stub model server. The README documents `volley acp`, OpenRouter, the Zed setup, and a scripted live check.
- **fascicle 0.16.3 (step 11).** fascicle's own `additional_directories` and `modes` options replaced volley's session copy and always-ask wrapper. That brought back the edit diffs, the titled cards, and "Always allow" for an exact command line. OpenRouter cost now counts against `--max-cost-usd`.
- **Labels and the live run (steps 13, 12).** The critic's retry and fallback rows name every provider but `claude_cli`. Step 13 was built before step 12, so that the live run in Zed would be the build's last step, on the final code. That run held on every step but the check card's look while it asks.

## Decisions and why

- **D1 (stream-inner-run)**: with a sink, the inner run goes through `run.stream` and a tee'd logger, *because* fascicle records `model_chunk` only while streaming, and Zed builds its cards, its text, and the anchors for its prompts from those chunks.
- **D2 (seat-deps)**: `FlowDeps.engines` grew into per-seat `seats`, *because* growing the existing seam keeps "leaving them out changes nothing" testable.
- **D3 (openrouter-entry)**: an unset key is a config error that names the variable, *because* `with_providers` replaces a provider's whole entry, and fascicle's own message doesn't say where the key comes from.
- **D5 (state-layout)**: per-run state at `<root>/<run_id>/`, defaulting to `$XDG_STATE_HOME/volley` under acp, *because* a per-run folder never needs rotating, and the CLI's default doesn't move.
- **D10 (turn-task)**: each prompt's task and criteria are the rendered conversation, *because* a follow-up like "keep going" means nothing without the turns before it.
- **D13 (check-card)**: the check gets a card of its own, dressed as `execute`, *because* fascicle's approver anchors a prompt only on a card that a `tool_call_start` opened. The live run showed Zed overwrites that kind when the check asks (fascicle#16).
- **D14 (failed-turn)**: a run that fails still ends the turn with a summary, and only an abort cancels it, *because* `acp_agent` drops a thrown turn from the history, and a "try again" would find nothing to retry.
- **D15 (command-gate)** and **D25 (check-approval)**: uncontained, every builder command asks, and the check asks whenever a command would, offering Allow and Reject alone, *because* the user can switch modes mid-turn, and in Accept edits the builder can rewrite the code the check runs.
- **D16 (key-strip)**: commands and the check run without `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY`, from one list in `src/engine.ts`, *because* that list can't drift between the engine and the strip.
- **D21 (acp-iterations-3)**: three rounds per prompt under acp, *because* a prompt is one short exchange the user can follow, and `--max-cost-usd` caps its spend. This reason was rewritten after step 11, when OpenRouter cost began to count.
- **D24 (acp-seats-required)** and **D27 (startup-resolve)**: all four seat flags are required, and the whole config resolves once at startup, *because* a bad flag or a missing key should fail once, in Zed's agent log, and not on every prompt.
- **D28 (acp-agent-options)**: on fascicle 0.16.3, fascicle's own options keep Auto and extra folders out of an uncontained session, *because* fascicle keys a session's cards and prompts on the session object, so volley's copy of the session lost them.
- **D29 (retry-label)**: the diagram's retry and fallback rows say "every provider but `claude_cli`", *because* that is what `is_retryable_critic_error` and `is_degradable_critic_error` do.

## Parked & harvested

Eight parks, all harvested:

- **Blockers (4), each folded into the plan.**
  - The `cwd_only` copy hiding fascicle's preview store, and the upgrade to fascicle 0.16.3: both went into D28 (acp-agent-options) as step 11.
  - The retry row's "local providers only": went into D29 (retry-label), in step 11.
  - The fallback row's "local critic": D29 (retry-label) took it on as step 13.
- **Tangents (4), deferred.**
  - A `--state-dir` inside the workspace leaks into the change list and `--git` checkpoints.
  - zod's peer loosened under fascicle 0.16.3.
  - The check request's `kind: 'other'`, sent on to step 12, where the live run confirmed it.
  - The check card losing its command look, filed as fascicle#16.

## Final status

Done. All 13 steps are on main, unpushed and unreleased. Every item on the frame's done list holds, with these differences:

- **The check's card in Zed.** It asks, runs as `pnpm test`, and shows its output, but it turns plain the moment it asks. The fix is upstream in fascicle#16.
- **Auto, uncontained.** Since D28 (acp-agent-options), Auto isn't offered at all uncontained, which replaced the frame's "in Auto, a command still asks".
- **OpenRouter cost.** The frame put it out of scope as a fascicle gap. fascicle 0.15 closed that gap, so it now counts against `--max-cost-usd`.

The release (`/version`, then the push) is yours.

## Deferred tangents

- **fascicle#16.** `permission_card` should send `kind` only when it has a presenter. volley gets the fix from the fascicle bump that ships it, with no change of its own.
- **zod.** Move off 4.4.3 (4.6.7 clears the 48-hour window) and reword C2 (exact-pins), whose zod hold no longer comes from fascicle.
- **`--state-dir` inside the workspace.** Exclude the state root's path, relative to the build root, in `changes.ts`.

## Checkpoints

- baseline 8ea348acf9c5ab2f79336fc73edd068e1dd22bed
- plan 02c41345f873b58d01f8b9fda8505fa7f6ccdff5
- step 1 2f27571ff950610c2ef388e9d2bff3216fa5ca6f
- step 2 a692f835ea505239c769857e497011334ddbdb5b
- step 3 562498bda6f19418ba4dc4faf8fdbf6ba990f6ab
- step 4 267c13feb71598fb4aa4d9274e0538ea087b6220
- step 5 497d57a1a3609524009717e12210794d82844ae2
- step 6 dde26aaf0c61c5a0b17024416cacaf7136c2c9aa
- step 7 534f3e53329bfef5e1493ee7144d1d61720dfa09
- step 8 bc9f19ce65d9c3609c2445b51c567eb674492f03
- step 9 f1fe913c0f8f2c8445af1e0f75bb4724652a3cf5
- step 10 74df9f510728b99e0b453dce50b2f4dc706306b6
- step 11 17ad5c7e9058ed88183dd9a48ed32ba76e73c9f4
- step 13 3eca833f96abb4e9c53b00d0bf765a9b1f05eeaf
- step 12 ec6c1df7bdb92fc2e506fa263c40162e3cfb8b89

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
| ---- | ---------- | -------------- | ------- | ---------- |
| 1 | 0 | 0 | 0 | 12m |
| 2 | 0 | 1 | 0 | 18m |
| 3 | 0 | 1 | 0 | 13m |
| 4 | 0 | 1 | 0 | 47m |
| 5 | 0 | 0 | 0 | 92m |
| 6 | 0 | 1 | 0 | 143m |
| 7 | 0 | 1 | 0 | 50m |
| 8 | 0 | 0 | 0 | 6m |
| 9 | 0 | 0 | 0 | 4m |
| 10 | 0 | 0 | 0 | 3583m |
| 11 | 0 | 1 | 0 | 7m |
| 12 | 0 | 0 | 0 | 18m |
| 13 | 0 | 0 | 0 | 4m |
| **total** | 0 | 6 | 0 | 3995m |
