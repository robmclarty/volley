# all-local example (v3 local path)

Builder **and** critic on a free local model via Ollama on the `ai_sdk` transport
(D1/C5), gated by checkride, running inside volley's **hardened Docker sandbox**
(B′/D5) over a **per-run git worktree** (s2 D3). The builder's `fetch` tool is
enabled; the run targets **$0** and — once deps are warmed — **offline**. This is
the local arm of the v3 comparison; its twin is `examples/all-claude`. Both run
the **same task, criteria, checkride gate, and caps**, so diffing their
`.volley/summary.json` `comparison` blocks isolates model-vs-transport.

## Prerequisites

- **Ollama** on the host with the model pulled: `ollama pull qwen3:32b` (swap the
  model in `volley.config.ts` for whatever you run).
- **Docker** ≥ 19.03 and the volley sandbox image built (`docker build -t
  volley-sandbox:latest .` from the repo root — the image carries node/pnpm + the
  checkride toolchain **and** volley itself, so the whole builder runs in-container).
- **The workspace is its own git repo** — `--worktree` requires it:
  ```
  cd examples/all-local/workspace && git init && git add -A && git commit -m init && cd -
  ```
- **Allowlist bridge** (host, once, for the `allowlist` posture): create volley's
  dedicated network and install the `DOCKER-USER` default-deny rules scoped to its
  subnet. Both the network name/subnet and the exact `iptables` lines are the
  invocation spec in `src/sandbox.ts` (`SANDBOX_NETWORK_NAME`,
  `SANDBOX_NETWORK_SUBNET`, and the `SandboxNetwork` doc comment). A fully offline
  run skips this and uses `--network none` (below).

## Run: launch volley *inside* its container

A local builder is refused unless volley detects containment (B′-2), so the
operator's `docker run` is what starts it. The image bakes `VOLLEY_CONTAINED=1`,
and the run injects `VOLLEY_MODEL_HOST=host.docker.internal` so the in-container
model client crosses the boundary to the host Ollama daemon (the base-url
normalizer consumes it — `src/engine.ts`, OQ-8). The hardened flag set below is
what `sandbox_invocation` + `format_docker_run` render in `src/sandbox.ts` — treat
that module as the source of truth; the exact mounts are finalized when the pair
is run (verification §4).

```
docker run --rm \
  --network volley-sandbox-net --add-host host.docker.internal:host-gateway \
  --user "$(id -u):$(id -g)" \
  --memory=4g --memory-swap=4g --memory-swappiness=0 --cpus=2 --pids-limit=1024 \
  --ulimit nofile=8192:16384 --ulimit core=0 \
  --cap-drop=ALL --security-opt no-new-privileges --init \
  --read-only --tmpfs /tmp --tmpfs /run --tmpfs /home/node/.cache \
  -e HOME=/home/node -e VOLLEY_MODEL_HOST=host.docker.internal \
  -v "$PWD/examples/all-local/workspace:/workspace" \
  -v volley-pnpm-store:/home/node/.local/share/pnpm/store \
  -w /workspace \
  volley-sandbox:latest \
  volley run --config /workspace/../volley.config.ts
```

For a **fully offline** run (model + deps already warmed in-container), swap the
network flags for `--network none` and drop `VOLLEY_MODEL_HOST`: `fetch` then has
no route and degrades cleanly to a returned error result, and the loop continues.

Before spending anything, dry-run the containment preflight from inside the
container (toolchain present, worktree creatable, host endpoint reachable — exit 5
on any failure):

```
… volley-sandbox:latest volley run --config … --dry-run
```

## Confounds this arm carries (disclosed, not narrowed — s2 D9)

- **Transport:** builder + critic run `ai_sdk` (recorded as
  `builder_transport`/`critic_transport: "ai_sdk"`), against `claude_cli` on the
  twin. Kept as a clean second variable — the AI-SDK layer is shared across both
  arms only in that both *have* one; the CLI arm does not route through it.
- **Containment:** Docker sandbox + worktree here vs host/no-Docker there. volley
  owns this sandbox and does **not** harden the CLI arm via fascicle's `claude_cli`
  sandbox (D10), so the two containment mechanisms differ by construction.
- **Tool surface:** the local builder uses volley's own tools (`bash`, file tools,
  `fetch`); `fetch` ≠ Claude Code's `WebFetch`. Different tool surfaces are part of
  the confound.
- **Local salvage rate** is meaningful here: it is the share of builder tool calls
  recovered from assistant text (D5). A high rate means the local model's native
  tool-call encoding is drifting from `ai-sdk-ollama`'s parser — read it alongside
  iterations-to-converge when judging where the local model got stuck.
