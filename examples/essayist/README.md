# essayist example (critic-swap generality)

The same loop that reviews code, judging prose. Every seat that makes
volley a *code* harness is swapped by configuration, nothing else:

| Seat | Swap |
|---|---|
| Task | `brief.md` — a prose commission (essay, thesis, sources), `@`-referenced as the prompt |
| Criteria | `rubric.md` — editorial acceptance criteria the critic echoes verbatim in `unmet_criteria` |
| Critic | `critic.md` — a custom editor prompt in place of the `reviewer` preset (`--critic <path>`) |
| Check | `workspace/check.mjs` — a dependency-free node script: word count, structure, citations-present |

The check gate holds the mechanical floor so the critic spends its judgment
where a script can't reach: is the thesis arguable, does each section advance
the argument, are the sources doing work.

The default seats embody the v3 finding: `qwen3.6:latest` writes well but
reproducibly dies **as critic** on Ollama's server-side tool-XML parser, so it
builds and `glm-4.7-flash:latest` (the fastest critic tested) judges. Swap
either model freely — just keep qwen3.6 out of the critic seat. Full analysis:
`research/v3-comparison-finding.md`.

## Prerequisites

- **Ollama** on the host with both models pulled (`ollama pull qwen3.6:latest`,
  `ollama pull glm-4.7-flash:latest` — or swap in what you run).
- For the contained run: everything in `examples/all-local/README.md`
  (sandbox image, network bridge, uid-owned store volume). The workspace here
  needs **no toolchain install** — the check gate is plain `node`.

## Dry-run, then run

From the repo root, prove the seats before any spend — config validity, the
endpoint probe, and the critic-seat canary through the real tool wiring:

```sh
VOLLEY_ALLOW_UNSANDBOXED_BUILDER=1 volley \
  --config examples/essayist/volley.config.ts --dry-run
```

A local builder is refused unless contained, so the real run launches
volley inside its sandbox container exactly as `examples/all-local/README.md`
documents — same hardened flags, this example dir as the mount. The config's
repo-root-relative paths are re-pointed at the mount with flag overrides
(`@` accepts absolute paths):

```sh
docker run --rm \
  --network volley-sandbox-net --add-host host.docker.internal:host-gateway \
  --user "$(id -u):$(id -g)" \
  --memory=4g --memory-swap=4g --memory-swappiness=0 --cpus=2 --pids-limit=1024 \
  --ulimit nofile=8192:16384 --ulimit core=0 \
  --cap-drop=ALL --security-opt no-new-privileges --init \
  --read-only --tmpfs /tmp --tmpfs /run --tmpfs /home/node/.cache \
  -e HOME=/home/node -e VOLLEY_MODEL_HOST=host.docker.internal \
  -v "$PWD/examples/essayist:/workspace" \
  -w /workspace \
  volley-sandbox:latest \
  --config /workspace/volley.config.ts \
  --prompt @/workspace/brief.md \
  --criteria @/workspace/rubric.md \
  --critic /workspace/critic.md \
  --workspace /workspace/workspace
```

The run writes `essay.md` into `workspace/` — the essay is the artifact, read
it. `.volley/` under the workspace carries the run state and
`summary.json`.

## Sweeping the critic seat

Which model makes the best editor is exactly what `volley matrix` measures.
Make the workspace its own git repo once (matrix forces `--worktree` per
combo), then sweep critics over the fixed brief:

```sh
cd examples/essayist/workspace && git init && git add -A && git commit -m init && cd -

volley matrix \
  --config examples/essayist/volley.config.ts \
  --builders qwen3.6:latest \
  --critics qwen3:8b,gemma4:12b,glm-4.7-flash:latest
```

One aggregate table: iterations, wall clock, salvage rate, degraded flag — per
prospective editor.

## Why there is no prose variant of the builder harness-append

The plan left room for a prose variant of
`src/builder/presets/harness_append_local.md` *if the preset proved
code-toned*. Judged against this brief, it doesn't: the append is domain-neutral
tool mechanics (read before you edit, one tool at a time, verify before
finishing), and its one code-leaning phrase — "run the project's checks or
tests" — applies literally here, because this workspace ships a check to run.
The brief carries all the domain. A variant would earn its place only if the
append acquired genuinely code-bound instructions (lint/typecheck workflows,
project-layout assumptions); today it would be a near-duplicate file to keep in
sync for no behavioral difference.
