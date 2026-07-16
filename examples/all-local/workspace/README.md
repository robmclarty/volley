Scratch workspace for the paired all-local example. The builder writes
`src/slug.ts` + `src/slug.test.ts` here (inside the sandbox container, on a git
worktree); `check: 'auto'` gates on the `checkride.config.json` alongside this
file (types + test) — the sandbox image carries node/pnpm + the toolchain, so
the gate runs in-container. `--worktree` needs this workspace to be its own git
repo: `git init` it before the first run (see ../README.md).
