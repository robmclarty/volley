`duration.mjs` must export exactly two functions, `parse` and `format`, meeting
every point below. The prompt is intentionally vague — these criteria are the
real spec, and the check gate enforces them.

## `parse(text)` → whole milliseconds

- Units are `ms`, `s`, `m`, `h`, `d` (1d = 24h). Components may be combined
  largest-first: `parse('1h')` === `3600000`, `parse('90m')` === `5400000`,
  `parse('1h30m')` === `5400000`, `parse('2h15m30s')` === `8130000`,
  `parse('500ms')` === `500`, `parse('1d')` === `86400000`.
- Whitespace between components is ignored: `parse('1h 30m')` === `5400000`.
- Empty input, or input with no recognized unit, throws a `SyntaxError`.
- A negative or fractional component (e.g. `'-1h'`, `'1.5h'`) throws a `RangeError`.

## `format(ms)` → canonical string

- Emits components largest-unit-first, omitting any zero component:
  `format(5400000)` === `'1h30m'`, `format(3600000)` === `'1h'`,
  `format(8130000)` === `'2h15m30s'`, `format(500)` === `'500ms'`.
- `format(0)` === `'0ms'` (the one case where a zero is emitted).
- A negative or non-integer argument throws a `RangeError`.

## Round-trip

- For every canonical string `s` above, `format(parse(s))` === `s`.

## Gate

- `node check.mjs` exits 0 in the workspace.
