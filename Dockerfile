# volley sandbox image (s2 D5 / D11): the toolchain the local builder's `bash`
# tool `exec`s against. Shape B keeps volley (Node, model client, tools) on the
# host; only the builder's shell commands run in here, against a bind-mounted
# git worktree. This image just has to ship the workspace dev toolchain plus a
# non-root default user so the builder can self-run `pnpm check` / checkride
# inside the container. Override the whole image with `--sandbox-image <tag>`.
#
# Runtime hardening — non-root *as the worktree owner* (`--user`), cap-drop,
# read-only rootfs + tmpfs, memory/cpu/pids caps, and the egress policy — is
# applied by volley on `docker run` (D11/D12), not baked here. The default
# `node` user (uid/gid 1000) only satisfies the "never root by default" floor;
# volley re-maps it to the host worktree owner at run time.

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
# matter which uid volley maps in with `--user` at run time.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
  && corepack prepare pnpm@11.1.2 --activate \
  && chmod -R a+rX "$COREPACK_HOME"

# The bind-mounted worktree lands here; volley sets each `docker exec`'s cwd per
# command. The pnpm store is mounted at run time (a named volume under the
# read-only rootfs, D11), so it is not created here.
WORKDIR /workspace
USER node
