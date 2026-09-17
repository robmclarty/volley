**Online-only probe** — the sandbox must have registry access for this one.

- `slugify` is declared in `package.json` under `dependencies` and installed in the workspace (`node_modules/slugify` resolves)
- `slug.mjs` exports `slug(text)` and implements it **using `slugify`**, not a hand-rolled reimplementation
- Behavior (lowercase, diacritics folded, punctuation stripped, spaces to single hyphens):
  - `slug('Héllo, World!')` === `'hello-world'`
  - `slug('Node.js Rocks!')` === `'nodejs-rocks'`
  - `slug('')` === `''`
- `node check.mjs` exits 0 in the workspace
