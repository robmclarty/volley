# all-Claude example (v3 comparison baseline)

Builder **and** critic on Claude via the `claude_cli` provider, on the host, with
**no Docker**. This is the reference arm of the v3 model-vs-transport comparison;
its twin is `examples/all-local`. Both run the **same task, criteria, checkride
gate, and caps** (`volley.config.ts` in each is identical but for provider, model,
transport, and containment), so diffing their `.volley/summary.json` `comparison`
blocks isolates what the model and transport actually changed.

## Why no Docker here

`claude_cli` has its own permission model, so volley never containerizes it:
`--sandbox` is a no-op on this path and the `--dry-run` preflight never
exits 5. Containment is the local-builder story (`examples/all-local`), not this
one.

## Run

```
cd examples/all-claude/workspace
pnpm install --ignore-workspace   # once — the workspace ships a pinned manifest
cd -
volley --config examples/all-claude/volley.config.ts
```

(`--ignore-workspace` keeps the repo's own `pnpm-workspace.yaml` from capturing
the install.)

The workspace ships a minimal `checkride.config.json` (types + test). `check:
'auto'` detects it and gates each builder iteration on `tsc` + `vitest`; the
critic (`reviewer` preset) then judges the criteria. On convergence,
`.volley/summary.json` carries the `comparison` block (iterations-to-converge,
wall-clock, cost, verdict, check trajectory, local salvage rate, transports).

## Confounds this arm holds constant (disclosed, not narrowed)

- **Transport:** builder + critic are `claude_cli` (a CLI subprocess), recorded as
  `builder_transport`/`critic_transport: "claude_cli"`. The all-local twin runs
  `ai_sdk`. Transport is therefore a real second variable, kept clean on purpose.
- **Containment:** host, no Docker here; Docker sandbox + worktree there. The
  containment mechanisms differ by construction (fascicle `claude_cli`
  bwrap/greywall vs volley's Docker) — volley owns its own sandbox and does not
  harden the CLI via fascicle's, so this confound stays disclosed.
- **Cost:** this arm spends real Claude tokens; the local arm targets $0. Compare
  iterations-to-converge and salvage rate, not just dollars.
- **Local salvage rate** is 0 here: the `claude_cli` builder runs its own loop and
  reports no volley tool calls. It only carries signal on the local arm.
