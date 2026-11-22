# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/anggianugrah214-eng/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/anggianugrah214-eng/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all of them:

- **unified diffs** — often with wrong line numbers, which `mend` corrects by
  taking the occurrence nearest the hunk's stated position;
- **SEARCH/REPLACE blocks** — one block per file, with the path on the line above;
- **V4A patches** — `*** Begin Patch` / `*** End Patch` sections that add, delete
  or update files, with `@@` anchors, a moving cursor and `*** End of File`;
- **JSON tool calls** — one edit object per line, or a JSON array of them.

Old lines are found at the first of three matching tiers — exact, trailing
whitespace ignored, leading and trailing whitespace ignored (with re-indentation)
— and `--strict` restricts matching to exact lines only. A context line is always
written back as the file's own line. Every file is changed or nothing is: a
failed edit is reported and no file is written.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, relative to the working directory (the root of the
tree); with no `PATCH`, or `-`, the patch is read from standard input.
`--format` is `auto` (the default), `unified`, `search-replace`, `v4a` or `json`.
`--check` does everything but write. Exit 0 lists what changed (`A`/`D`/`M`/`R`
one line per file, then `ok: <n> files`); exit 1 lists the edits that failed;
exit 2 reports a usage, missing-patch, format or parse error.

Node 22, standard library only. `SPEC.md` is the whole specification;
`runner.ts` is the kit's trial runner, kept as it is.

---

Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
