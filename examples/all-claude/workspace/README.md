Scratch workspace for the paired all-Claude example. The builder writes
`src/slug.ts` + `src/slug.test.ts` here; `check: 'auto'` gates on the
`checkride.config.json` alongside this file (types + test). Install the workspace
toolchain once (`pnpm install --ignore-workspace` — the manifest is pinned here)
so the gate can run.
