/**
 * The shell around the volley flow (`./flow.ts`): set up the workspace, wrap
 * the run in the worktree lifecycle, execute the flow with a single `run` call,
 * and turn its outcome into the run summary. No hand-rolled runner — rounds,
 * abort threading, signal handlers, and cleanup order all belong to the
 * substrate.
 *
 *   run_volley
 *   ├─ initialize the workspace (or preserve it, on resume)
 *   ├─ with_worktree                    off unless --worktree
 *   │  ├─ capture the change baseline
 *   │  ├─ run_loop                      run(build_flow(...)), then the final summary
 *   │  └─ integrate                     a successful --worktree --git run only
 *   └─ report a kept checkout, or a salvaged branch (re-stamping the summary)
 */
import { existsSync, readFileSync } from 'node:fs';
import { run } from 'fascicle';
import { filesystem_logger } from 'fascicle/adapters';
import type { Engine } from 'fascicle';
import type { BashExecutor } from './builder/tools.js';
import { capture_baseline } from './changes.js';
import { create_volley_engine } from './engine.js';
import { build_flow } from './flow.js';
import { run_result_from_state } from './iteration.js';
import { initial_state, status_of } from './loop_state.js';
import { write_run_summary } from './summary.js';
import type { Renderer } from './render/renderer.js';
import { error_kind } from './types.js';
import type { LoopState, ResolvedConfig, RunResult, RunStatus } from './types.js';
import {
  initialize_workspace,
  integrate_worktree,
  volley_path,
  write_resolved_config,
} from './workspace.js';
import {
  build_root,
  report_worktree_fate,
  with_worktree,
  worktree_branch,
  worktree_fate,
} from './worktree.js';

export type OrchestratorDeps = {
  renderer: Renderer;
  engine?: Engine;
  abort?: AbortSignal;
  install_signal_handlers?: boolean;
};

export async function run_volley(
  config: ResolvedConfig,
  deps: OrchestratorDeps,
  resume_from: LoopState | null = null,
): Promise<RunResult> {
  const { renderer } = deps;

  if (resume_from === null) {
    initialize_workspace(config.workspace);
    write_resolved_config(config);
  } else {
    initialize_workspace(config.workspace, { preserve: true });
  }

  // Say what this run will do with its effects before it spends anything — the
  // same notice `--dry-run` prints, repeated here so a run started without a dry
  // run still hears it (the same predict-then-warn shape).
  report_worktree_fate(config, renderer);

  // The worktree lifecycle wraps the whole builder loop: created before the
  // first iteration, torn down after the last. Off unless `--worktree` is set
  // (config.worktree), so the default path never touches git here.
  const branch = worktree_branch(config.run_id);
  const fate = worktree_fate(config);
  const outcome = await with_worktree<RunResult>(
    {
      enabled: config.worktree,
      workspace: config.workspace,
      branch,
      log: (message) => renderer.info(message),
      // The one case teardown must keep rather than force-delete: a converged run
      // that integrated nothing, whose only copy of its work is the worktree.
      salvage: (result) => fate === 'salvage' && result.status === 'success',
    },
    async () => {
      // Whole-process containment: volley runs *inside* its hardened
      // container already — the operator/example's `docker run … <volley args>`
      // launched it — so there is no container lifecycle to orchestrate here. `bash`
      // is the local `host_bash_executor` running in-container (null executor,
      // the host `spawnSync` default) and the file tools write straight to the
      // bind-mounted worktree; the retired `docker exec` path is gone. The
      // hardened `docker run` invocation spec the example uses lives in
      // `src/sandbox.ts`.
      // The commit every iteration's change set is measured against, read after
      // the worktree exists and before the builder writes anything. Null when the
      // build root is not a git repo — then the run reports no changes at all
      // rather than guessing at them.
      const baseline = capture_baseline(build_root(config.workspace, config.worktree));
      const result = await run_loop(config, deps, resume_from, null, baseline);
      // Integration: a *successful* `--worktree --git` run squash-merges the
      // phase branch's checkpoints onto the workspace branch before teardown
      // discards it. Any non-success outcome (cost cap, budget, interrupt,
      // error) is abandoned — teardown discards the branch wholesale, nothing
      // integrated. Gated on `--git` too (`fate === 'integrate'`), so volley only
      // commits to the workspace branch when the operator opted into checkpoints;
      // without it the same work is salvaged onto its own branch instead.
      if (fate === 'integrate' && result.status === 'success') {
        integrate_worktree(config.workspace, branch, `volley run ${config.run_id}: integrate worktree (squash)`);
        renderer.info(`worktree: squash-merged ${branch} onto the workspace branch`);
      }
      return result;
    },
  );

  if (outcome.kept_path !== null) {
    renderer.warn(
      `worktree: could not commit this run's work onto ${branch}, so the checkout at ` +
        `${outcome.kept_path} was left standing rather than deleted — its files are intact, and ` +
        'the next --worktree run rotates the directory aside instead of destroying it.',
    );
  }
  if (outcome.salvaged_branch === null) return outcome.value;
  renderer.info(
    `worktree: this run was not integrated; its work is preserved on branch ` +
      `${outcome.salvaged_branch} (git switch ${outcome.salvaged_branch}, or cherry-pick it).`,
  );
  // Teardown salvaged the branch *after* `run_loop` wrote the final summary, so
  // re-stamp it: `.volley/summary.json` and `--json` both name the survivor.
  const salvaged: RunResult = { ...outcome.value, salvaged_branch: outcome.salvaged_branch };
  write_run_summary(config, salvaged);
  return salvaged;
}

async function run_loop(
  config: ResolvedConfig,
  deps: OrchestratorDeps,
  resume_from: LoopState | null,
  bash_executor: BashExecutor | null,
  baseline: string | null,
): Promise<RunResult> {
  const { renderer } = deps;

  const engine =
    deps.engine ??
    create_volley_engine({
      workspace: config.workspace,
      builder_provider: config.builder_provider,
      critic_provider: config.critic_provider,
    });

  const flow = build_flow({ engine, config, renderer, bash_executor, baseline }, resume_from);

  try {
    const { value, converged } = await run(
      flow,
      { resume_from },
      {
        trajectory: filesystem_logger({
          output_path: volley_path(config.workspace, 'trajectory.jsonl'),
        }),
        ...(deps.abort !== undefined ? { abort: deps.abort } : {}),
        ...(deps.install_signal_handlers !== undefined
          ? { install_signal_handlers: deps.install_signal_handlers }
          : {}),
      },
    );
    const status = status_of(value, converged);
    const result = run_result_from_state(config, value, status, new Date().toISOString());
    write_run_summary(config, result);
    return result;
  } catch (err) {
    finalize_failed_run(config, err);
    throw err;
  } finally {
    await engine.dispose();
  }
}

/** Best-effort status stamp on the run summary when the loop threw; the
 * on-disk iteration state is already consistent (record runs per round). */
function finalize_failed_run(config: ResolvedConfig, err: unknown): void {
  const kind = error_kind(err);
  const cause = kind === 'phase_error' ? error_kind((err as { cause?: unknown }).cause) : null;
  const status: RunStatus =
    kind === 'aborted_error' || cause === 'aborted_error' ? 'interrupted' : 'error';
  try {
    // Preserve accumulated totals when `record` already wrote a summary.
    const summary_path = volley_path(config.workspace, 'summary.json');
    const prior = existsSync(summary_path)
      ? (JSON.parse(readFileSync(summary_path, 'utf8')) as RunResult)
      : run_result_from_state(config, initial_state(), status, null);
    write_run_summary(config, {
      ...prior,
      status,
      completed_at: new Date().toISOString(),
    });
  } catch {
    // Never mask the original failure with a bookkeeping error.
  }
}
