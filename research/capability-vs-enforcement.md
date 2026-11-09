# Capability vs enforcement: where the sandbox belongs

A research note, 2026-11-08, from a conversation about whether volley should own the
sandboxing of its builder or leave it to whatever hosts it. Nothing here is built. The
companion from the host's side is Runciter's
`docs/specs/runciter-builder-protocol-and-hosting.md`.

## The question

The local builder gets a real `bash`. volley refuses to run it unless it is contained,
ships the container image and the hardened `docker run` flags that contain it, and
exports those flags so a harness can render the same ones. Is that volley's job? Rob's
instinct: containment is a *serving* concern, set by the hosting environment, not by the
logic of the builder; but it is also directly about what the builder is capable of, so
the line is not obvious.

## What volley does today (v0.11.x)

- **Refuses before spend.** A builder other than `claude_cli` is refused unless
  `VOLLEY_CONTAINED=1` is set (baked into the image) or `--allow-unsandboxed-builder`
  opts out with a one-time warning. P1 (fail-before-spend).
- **Detects, does not start.** volley never launches the container. The operator (or a
  harness) runs `docker run <hardened flags> volley-sandbox:latest volley …`.
- **Ships the wall anyway.** The `Dockerfile`, `sandbox_run_args`, `network_run_args`,
  `SANDBOX_NETWORK_NAME`, `SANDBOX_NETWORK_SUBNET`, the state-mount convention
  (`SANDBOX_STATE_ROOT`) and `--sandbox-image` all live in `src/sandbox.ts` and the
  repo root.
- **Isolates effects separately.** `--worktree` puts a run on a `volley/<run id>` branch
  in a sibling worktree, independent of the container.
- **Under ACP, asks instead.** `volley acp` outside the container asks before every
  builder command and every check, offers no Auto mode, and keeps the seat keys from
  every child process.
- **Knows the token does not cross.** A Claude subscription login does not survive into
  the container, so a contained Claude seat must bill an API key.

## The split

Two things are tangled in "sandboxing", and they belong to different parties.

**Capability** is what the builder hands the model: a `bash` with write and exec in the
workspace, a `fetch`, file tools. Only volley knows this, because volley chose the tools.
It follows that volley is the right party to *declare* it ("this run gives a model a
shell in `<workspace>`, and it wants network to these hosts") and to *refuse* when the
declaration is not met with a boundary. The refusal is P1, and it stays.

**Enforcement** is the wall: the container, its mounts, its network policy, the user
mapping, the resource caps, the state directory's mount, the decision whether a given
seat may even run inside (the subscription token question). Only the host knows this,
because only the host knows the machine: whether Docker is Desktop or Engine, whether
egress rules are enforceable there, where the worktree is, which other runs share the
box. A builder that renders `docker run` is guessing at a machine it cannot see.

So: **the builder declares and verifies; the host provides and attests.** volley keeps
the first half and hands over the second.

## Leans

1. **The refusal stays in volley, exactly as it is.** A local or API-key tool-loop
   builder with no attestation fails before any model call. `--allow-unsandboxed-builder`
   stays as the escape hatch. *Because* fail-before-spend is volley's own principle, and
   the party that hands out the shell must be the one that checks for the wall.
2. **The image and the run-args leave volley.** `Dockerfile`, `src/sandbox.ts` and the
   `--sandbox-image` flag move to the host (Runciter's container executor) or to a small
   package of their own that hosts import. volley's README points at the host for "how
   to run a local builder contained" instead of carrying the `docker run` recipe.
   *Because* every line of that file is about a machine volley cannot see, and because a
   second host (a CI runner, a Linux box, the office) will want different flags.
3. **Attestation becomes a declared interface, not a baked variable.** volley documents:
   "set `VOLLEY_CONTAINED=1` only when the process runs inside a boundary that confines
   the filesystem to the workspace and the run directory and confines or denies
   network". A neutral name (shared with other builders) is a later nicety; the
   documented meaning is the thing. *Because* an attestation is a promise from the host,
   and a promise needs its terms written down.
4. **Worktree isolation stays available but optional, and a host-supplied workspace
   wins.** `--worktree` is useful standalone; under Runciter the daemon already made the
   worktree and passes `--workspace`. Nothing changes here; it is named so the line is
   clear: effects isolation is a convenience volley offers, blast-radius isolation is
   the host's.
5. **volley speaks `runciter.run/1` natively.** A `--protocol runciter.run/1` output mode
   (or an adapter binary in this repo) that writes the run's result in Runciter's shape,
   so Runciter's bespoke `volley` kind can be deleted and its version range with it.
   *Because* the party that knows `summary.json` is this one, and a host that has to
   parse a builder's artifacts is coupled to that builder's releases.
6. **Seat placement is the host's call.** volley keeps saying what it needs (a
   subscription seat needs the host's login; an API-key seat needs the key in its
   environment and nothing else), and stops reasoning about whether it is inside a
   container when deciding how a seat bills. *Because* that is the same machine question
   as the rest of enforcement.

## What stays volley's, listed so it is not lost in the move

- The tool contracts and the stateless-per-command `bash`, which is what makes the
  `subprocess.run` → `docker exec` swap possible at all.
- The in-process SSRF deny-list on `fetch`, since a host's egress rules may not be
  enforceable (Docker Desktop).
- Keeping seat keys from every child process (`omit_env`).
- `--state-dir` and the state layout, since a host must mount it; its *location* under
  the sandbox is the host's to choose.
- P2–P4 untouched.

## Risks

- **Standalone users lose the one-liner.** Someone running volley from a terminal with a
  local builder today copies one `docker run` from the README. After the move they need
  the host package. Mitigation: a thin `volley contained …` subcommand that depends on
  the extracted package and renders the same invocation, so the README keeps a
  one-liner without volley owning the flags.
- **Two repos change together.** Lean 5 and Runciter's kind deletion have to land in
  order: volley's protocol mode first, then Runciter's switch, then the deletion.
- **A neutral attestation name invites a second honor system.** It already is one (any
  process can set the variable); the threat model is the model, not the operator, so
  this is accepted and written down rather than solved.

## Sized

1. `--protocol runciter.run/1` output mode, with a fixture test against Runciter's
   conformance tool once it exists. 1–2 steps.
2. Extract `Dockerfile` and `src/sandbox.ts` to the package or host; `volley contained`
   as the thin wrapper; README rewritten to point at the host. 2 steps.
3. Attestation terms documented; `VOLLEY_CONTAINED` semantics unchanged. Doc-only.
4. Remove in-volley reasoning about container residency for seat billing, in favour of
   explicit `VOLLEY_AUTH_MODE` from the host. 1 step, after Runciter's seat placement.
