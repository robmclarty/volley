---
name: version
description: Bump the root package.json version (major|minor|patch), summarize every change since the last release into a new CHANGELOG.md entry, and commit the result with a `vX.Y.Z` message. Use when cutting a release or tagging a new version of volley.
argument-hint: "[major|minor|patch]"
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Bash(pnpm version*), Bash(git log*), Bash(git diff*), Bash(git status*), Bash(git add *), Bash(git commit *), Bash(node -e *), Bash(cat *)
---

# version

Bump the root `package.json` version, write a `CHANGELOG.md` entry summarizing everything since the last release, and commit. Volley is a single package with one manifest, so a bump rewrites exactly one version field: the root `package.json`.

## Arguments

`$ARGUMENTS` — one of `major`, `minor`, or `patch`. No default; fail fast if missing or anything else.

## Preflight context

- Current version: !`node -e "console.log(require('./package.json').version)"`
- Last release commit: !`git log -1 --extended-regexp --grep='^v[0-9]+\.[0-9]+\.[0-9]+$' --pretty=format:'%H %s'`
- Working tree status: !`git status --short`

The "last release commit" line finds the most recent commit whose message is a bare `vX.Y.Z` — that's how this skill marks releases (there are no git tags; volley has no remote to push them to). **If that line is empty, there is no prior release** and this is an initial release: summarize the full history.

(Commits since the last release are fetched in step 4 — preflight blocks can't use `$(...)` substitution under Claude Code's permission system, so we look up the range there instead.)

## Steps

1. **Validate the bump type.** `$ARGUMENTS` must be exactly `major`, `minor`, or `patch`. If it's empty or anything else, stop and tell the user the valid options — don't guess.

2. **Refuse to run on a dirty tree.** If `git status --short` above shows *any* uncommitted changes, stop. A release commit must contain *only* the version bump and changelog. The user needs to commit or stash first.

3. **Compute the new version.** Use the current version from the preflight context and apply the bump per semver:
   - `major`: `X.Y.Z` → `(X+1).0.0`
   - `minor`: `X.Y.Z` → `X.(Y+1).0`
   - `patch`: `X.Y.Z` → `X.Y.(Z+1)`

4. **Fetch and summarize the commits.** Get the commit list for the range:
   - If the preflight "last release commit" line held a SHA, run `git log <sha>..HEAD --no-merges --pretty=format:'%h %s'`.
   - If it was empty, run `git log --no-merges --pretty=format:'%h %s'` for the full history (initial release).

   Then write a tight, grouped changelog section. Target format:

   ```markdown
   ## vX.Y.Z — YYYY-MM-DD

   ### Added
   - <one line per user-visible addition>

   ### Changed
   - <behavior changes, refactors that matter externally>

   ### Fixed
   - <bug fixes>

   ### Internal
   - <tooling, tests, docs — keep this section short or omit>
   ```

   Rules for the summary:
   - Group by impact, not by commit. Collapse three commits that together land one feature into one bullet.
   - Omit any `Added/Changed/Fixed/Internal` section that has no entries.
   - Each bullet is one line. Reference commit hashes only if the line is genuinely ambiguous without one.
   - Write for a reader who didn't follow the work. "Run the critic on a local model instead of the API" beats "add local critic".
   - If there was no prior release, this is the first tagged release — summarize the notable capabilities as they stand, and title the section "vX.Y.Z — initial release" instead of listing every commit in repo history.

   **Print the drafted section back to the user** as a fenced `markdown` code block in your response text — the entire block, verbatim, exactly as it will be prepended to `CHANGELOG.md`. This is the user's one chance to see the prose in isolation before it's folded into the file and committed. Do this before moving on to step 5; don't summarize or abbreviate — print the raw markdown. The skill continues automatically after printing (no wait for confirmation); if the user wants to change the prose, they'll interrupt.

5. **Update `CHANGELOG.md`.** If it exists, prepend the new section above the existing content (keep a single `# Changelog` heading at the very top). If it doesn't exist, create it with:

   ```markdown
   # Changelog

   <new section here>
   ```

6. **Bump `package.json`.** Run:
   ```bash
   pnpm version <bump> --no-git-tag-version
   ```
   `--no-git-tag-version` is mandatory: it stops pnpm from auto-committing and auto-tagging, so we control the commit message and avoid surprise tags. Confirm the version pnpm wrote matches the version computed in step 3.

7. **Stage and commit.** Stage exactly `package.json` and `CHANGELOG.md`, nothing else:
   ```bash
   git add package.json CHANGELOG.md
   ```
   Confirm via `git status --short` that nothing else is staged — a release commit is not the place to sneak other changes in. Then commit with:
   ```bash
   git commit -m "vX.Y.Z"
   ```
   The message is literally `vX.Y.Z` — no prefix, no body, no footer. That bare `vX.Y.Z` message is exactly what the next bump's preflight greps for to find "the last release," so it must not carry a conventional-commit prefix.

8. **Report back.** Tell the user: the old version, the new version, the commit SHA, and the number of commits summarized. Do *not* push (volley has no remote). Do *not* create a git tag — releases are tracked by the `vX.Y.Z` commit message, not tags.

## When to use this skill

- Cutting a release, even an internal one (`patch`/`minor`/`major`).
- User asks to "bump the version" or "tag a new version".

## When NOT to use this skill

- There's no meaningful change since the last release (no commits between the last `vX.Y.Z` commit and HEAD). Tell the user and stop.
- The user wants to edit an existing CHANGELOG entry or retro-date an older release — that's a different workflow, not this skill.

## Edge cases

- **No prior release.** When the preflight "last release commit" line is empty, treat the entire history as the range and title the section `vX.Y.Z — initial release`. Volley's pre-skill commits use conventional-commit subjects (e.g. `feat(volley): … (v0.2)`), not bare `vX.Y.Z`, so the first run of this skill will correctly see no prior release.
- **`CHANGELOG.md` exists but has no `# Changelog` heading.** Prepend the new heading plus the new section; leave the old content below untouched.
- **Commit list contains merge commits.** Drop them from the summary unless they introduced something not present in the squashed commits. `--no-merges` on the log is fine if the output is noisy.
- **A commit is marked with `BREAKING:` or `!:` but the user asked for `patch` or `minor`.** Warn the user and ask if they meant `major`. Don't override silently.
- **No verify step is needed.** A version-string + CHANGELOG diff can't affect volley's only active checkride slot (`test`; `spell` and `docs` are disabled in `checkride.config.json`), so there is nothing to run. Release-readiness of the actual code is the user's concern before invoking this skill.
