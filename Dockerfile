# volley sandbox image (s2 D5 / D11; B′/D5): the hardened container the *whole*
# volley builder runs inside (shape B′), not just its `bash` commands. It carries
# the workspace dev toolchain — so the in-container builder can self-run `pnpm
# check` / checkride against the bind-mounted worktree — *and volley itself*, and
# its entrypoint runs volley. The operator/example launches it with `docker run
# <hardened flags> <image> <volley args>` (B′-2, the invocation spec in
# src/sandbox.ts) and volley detects it is already contained. Override the whole
# image with `--sandbox-image <tag>`.
#
# Runtime hardening — non-root *as the worktree owner* (`--user`), cap-drop,
# read-only rootfs + tmpfs, memory/cpu/pids caps, and the egress policy — is
# applied on `docker run` by the invocation spec (D11/D12), not baked here. The
# default `node` user (uid/gid 1000) only satisfies the "never root by default"
# floor; the invocation re-maps it to the host worktree owner at run time.

# Pinned to the workspace's Node engine (package.json engines: node >=24).
FROM node:24-bookworm-slim

# Dev toolchain the workspace check pipeline needs: git (worktree + checkride),
# CA certs (HTTPS to the package registry / host LLM endpoint), and a C toolchain
# (build-essential + python3) so any dependency with a native addon can build
# under `pnpm install` rather than dead-ending the builder.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    build-essential \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned to the workspace's packageManager (pnpm@11.1.2).
# COREPACK_HOME is a world-readable global path so the cached pnpm resolves no
# matter which uid the invocation maps in with `--user` at run time.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
  && corepack prepare pnpm@11.1.2 --activate \
  && chmod -R a+rX "$COREPACK_HOME"

# Build volley into the image (B′): the whole builder loop runs in here, so the
# image ships volley — not just the toolchain. It lives under /opt/volley, out of
# /workspace (the bind-mounted worktree overlays that at run time). Manifests
# first for a cached dependency layer, then the source + build. `a+rX` so any
# `--user`-mapped uid can read and execute it under the read-only rootfs.
WORKDIR /opt/volley
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
  && chmod -R a+rX /opt/volley

# The B′-2 containment marker: volley *detects* it is running inside its sandbox
# (rather than starting the container itself) by this env being set, so the
# safety gate admits a local builder here without `--allow-unsandboxed-builder`
# (src/config.ts `detect_containment`).
ENV VOLLEY_CONTAINED=1

# The bind-mounted worktree lands here; volley's file tools + in-container `bash`
# resolve workspace-relative paths against it. The pnpm store is mounted at run
# time (a named volume under the read-only rootfs, D11), so it is not created here.
WORKDIR /workspace
USER node

# The entrypoint runs volley (B′): `docker run <image> --prompt … --workspace
# /workspace …` becomes a full volley builder/critic loop inside the container.
ENTRYPOINT ["node", "/opt/volley/dist/cli.js"]
