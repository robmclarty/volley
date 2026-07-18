Implement `roman.mjs` exporting `toRoman` and `fromRoman` for the range 1–3999.

## `toRoman(n)`

- Returns the standard Roman numeral for an integer `1 ≤ n ≤ 3999`, using
  subtractive notation (`IV`, `IX`, `XL`, `XC`, `CD`, `CM`). Examples:
  `toRoman(4)` === `'IV'`, `toRoman(58)` === `'LVIII'`, `toRoman(1994)` ===
  `'MCMXCIV'`, `toRoman(3999)` === `'MMMCMXCIX'`.
- Throws a `RangeError` for anything outside 1–3999 or non-integer — `0`, `-1`,
  `4000`, `3.5`.

## `fromRoman(text)`

- The inverse: parses a **well-formed** uppercase numeral back to its integer.
  `fromRoman('MCMXCIV')` === `1994`, `fromRoman('LVIII')` === `58`.
- Throws a `SyntaxError` for **any** malformed input:
  - too many repeats — `'IIII'`, `'VV'`, `'MMMM'`
  - illegal subtractive pairs — `'IL'`, `'IC'`, `'XM'`, `'VX'`
  - the empty string `''`
  - lowercase (`'iv'`) or non-Roman characters (`'ABC'`)

## Round-trip

- For every integer `n` in 1–3999, `fromRoman(toRoman(n))` === `n`.

## Gate

- `node --test` exits 0 in the workspace.
