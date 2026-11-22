[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/bayuanwar8/csv-reader-fast/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/bayuanwar8/csv-reader-fast/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# csv-reader-fast

A faster drop-in for make.fun's own csv-reader 1.0.0: `solve.js` answers exactly
what csv-reader answers for every input `{text, header}` — the same broken-row
policy, the same `{columns, rows, errors}` — but much faster.

How it is fast: two tiers. Most records are clean (no quote, no stray CR) and go
through a fast path built only on native string operations (`indexOf` to find the
line, `slice` + `split(',')` for the fields), never touching the text one
character at a time. Records with a quote — quoted fields, fields spanning lines,
junk after a closing quote, an unclosed quote — or a stray CR go through a slow
path that walks the record with `indexOf` jumps while keeping every error and
line count identical to the reference.

`main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.
