---
name: firmware-update-pr-review
description: Use this skill when reviewing any pull request against the zwave-js/firmware-updates repo that touches firmware definition files (`firmwares/<vendor>/*.json`), regardless of author. Covers title normalization, changelog formatting via the submission pipeline (prettier markdown, style-preserving), fixing typos and indentation, and pushing fixups back to the PR's branch.
---

# Firmware Update PR Review

## Overview

PRs that add or modify `firmwares/<vendor>/*.json` often arrive with:
- Non-canonical titles (missing vendor, `.json` suffix, unusual phrasing)
- Changelogs with stray whitespace or malformed bullets
- Typos in text fields
- Spaces instead of tabs for indentation

This skill is the workflow for reviewing **one** such PR: inspect, normalize the title, clean up the firmware JSON, and push fixup commits back to the PR's branch.

Focus on one PR per invocation. Batch-multi-PR runs are possible but rare; if needed, repeat the per-PR loop.

## Step 1: Inspect the PR

```bash
gh pr view <n> --json number,title,author,headRepository,headRefName,maintainerCanModify
gh pr diff <n>
```

Verify `maintainerCanModify: true`. If `false`, you can only comment on the PR; you cannot push changelog fixups. Leave a review comment with the needed changes instead.

## Step 2: Normalize the title

The title should carry these pieces of information, in this order:

1. **Verb** — `Add` when the PR introduces a new file or a new upgrade entry; `Update` when it only modifies an existing entry in place.
2. **Vendor / brand / manufacturer** — `Zooz`, `Shelly`, `Aeotec`, `Leviton`, etc. Always present; read it from the JSON's `devices[].brand` if unclear.
3. **Model** — bare model ID plus any variant suffixes from the filename (e.g. `ZEN71-V04-800-LR`, `ZSE42-V02`). Keep the suffix so the variant stays identifiable. Never include the `.json` extension.
4. **Region(s)** — *optional* when the device supports only one region; the region is obvious from the body in that case. When present, use a consistent format: `US`, `EU`, `US and EU`, `US / AUS / EU` (slash-separated for 3+ regions, space-padded).
5. **Added firmware version(s)** — *optional* when the PR touches multiple devices, since listing them all makes the title unreadable. Either `1.30` or `1.30.0` is fine; keep all three parts when the patch is non-zero (`1.30.1` stays `1.30.1`). Spell as `firmware <V>` normally; contract to `FW <V>` when the title is otherwise too long.

Typical shapes:

```
<Verb> <Vendor> <Model>, firmware <Version>                             # single region implicit
<Verb> <Vendor> <Model>, <Region>, firmware <Version>                   # explicit region
<Verb> <Vendor> <Model>, <Region1> and <Region2>, firmware <Version>    # two regions
<Verb> <Vendor> <Model>, <R1> / <R2> / <R3>, firmware <Version>         # three or more
Update <Vendor> <Model1> to <V1>, <Model2> [<Region>] to <V2>           # two-device compact
<Verb> <Vendor> <Model1>, <Model2>, ... firmware updates                # multi-device bundle (3+)
```

Use the compact two-device shape when exactly two devices are touched and the combined title reads cleanly. When there are three or more devices, or the two-device form would read as a run-on, fall back to the `firmware updates` bundle shape.

Examples:

- `Add Zooz ZEN71-V04-800-LR, US, firmware 4.20`
- `Update Zooz ZSE11-V02-800-LR, US and EU, firmware 2.20`
- `Add Zooz ZSE70-V01-800-LR, US / AUS / EU, firmware 1.30.1`
- `Update Zooz ZST39 to 1.2.0, ZEN88-800 EU to 10.80.55`
- `Add Shelly Wave Plug S, 1PM, Pro Shutter firmware updates` (version omitted for multi-device)

### Shortening overly long titles

Length is not a hard limit — carrying all the relevant information matters more than staying under any character count. Don't truncate to the point of being cryptic. But when a title genuinely reads as long, apply these shortenings in order, stopping as soon as it reads well:

1. `firmware <V>` → `FW <V>` (e.g. `firmware 17.88.1` → `FW 17.88.1`)
2. Drop an explicit region when the device is single-region (it's implied)
3. Drop a trailing `.0` from a version (e.g. `1.30.0` → `1.30`)
4. Fall back to the multi-device bundle shape without a version list

Prefer keeping the model variant suffix — that's the most important identifier — and shortening the boilerplate parts first.

Apply the edit via REST API, not `gh pr edit` — the latter currently fails with a GraphQL "Projects classic deprecated" error on this repo:

```bash
gh api --method PATCH repos/zwave-js/firmware-updates/pulls/<n> \
  -f title="<new title>" --jq '.number,.title'
```

## Step 3: Clean up the firmware JSON

Each of the following is a separate class of change. A single commit may bundle them, in which case the commit message should describe the combined intent (e.g. `clean up firmware entry`) rather than the narrow `format changelog`.

### 3a. Indentation

This repo uses **tabs** for indentation in `firmwares/**/*.json`. Submitters occasionally paste spaces. When you re-indent, convert the **entire file** to tabs in one pass — don't leave a mix of tabs and spaces. The mixed state is worse than either consistent one, and tab/space mixing trips up the schema-free JSON5 parsers downstream.

### 3b. Typos

Fix obvious typos in free-text fields (changelog, description). Leave URLs, hashes, hex IDs, version strings, and filenames alone.

If you spot typos in **unrelated** changelogs (entries the PR didn't touch) while reviewing the file, fix them too — they're worth a small extra commit while you're already in the file.

### 3c. Changelog formatting

#### Pipeline reference

The submission workflow runs this transformation (see `.github/scripts/firmware-submission/process-submission.mts:1782-1794`):

```
raw.trim().replace(/\r\n/g, "\n")
  → prettier.format(text, { ...resolvedConfig, parser: "markdown" })
  → .trim()
```

Resolved prettier config at the repo root: tabs width 4, printWidth 80, endOfLine `lf`.

#### Extract the in-scope changelogs

Only changelog strings that appear on the **+** side of the PR diff (new entries or modified entries) are in scope. Pre-existing untouched entries are left alone.

#### Run the pipeline (dry-run)

Use the bundled helper; it resolves prettier from the repo's `node_modules` and prints a diff per changelog that would change:

```bash
node .claude/skills/firmware-update-pr-review/format-changelogs.cjs \
  firmwares/<vendor>/<file>.json [more.json ...]
```

Pass the file(s) the PR touches. The script parses each one with JSON5, walks the `upgrades` array, runs the pipeline on every `changelog` string, and prints BEFORE / AFTER for any that differ.

#### Style decision

Prettier's markdown parser makes two stylistic changes:

1. **Bullet char flip (`*` → `-`)**
2. **Blank line inserted between intro prose and the first bullet**

Default preference: **the prettier output**. Apply it to new files or when the surrounding changelogs in the same file already match prettier output.

Exception: when the rest of the file uses `*` bullets and no blank-line-before-list, keep consistent with the file. Changing half a file's changelogs to `-` while the rest stays `*` is worse than either consistent style.

So: decide per-file by reading the other (unchanged) changelogs in the same JSON. Match what's there.

Regardless of the style decision, genuine normalizations (trimmed stray whitespace, fixed malformed bullets, escape-fix for bad markdown) are always worth committing.

#### Real normalizations seen in the wild

- **Trailing space before `\n`**: `"…2.50. \n* Updated"` → `"…2.50.\n* Updated"`
- **Stray leading space on a bullet**: `"\n * Improved"` → `"\n* Improved"`
- **Malformed bullet (space-asterisk-no-space)**: `"\n *Fixed"` — prettier would escape this to `\*Fixed`, which is wrong. Manually rewrite as `"\n* Fixed"` before considering the pipeline done.

## Step 4: Commit and push

```bash
gh pr checkout <n>
# edit firmwares/<vendor>/<file>.json in place
git diff                                    # sanity check
git add firmwares/<vendor>/<file>.json
git commit -m "<message>"
git push
git checkout main
```

Commit message depends on what was changed:

- `format changelog` — only when the commit contains changelog whitespace/bullet normalizations (Step 3c).
- Pick a more descriptive message when the commit also touches typos, indentation, or multiple concerns — e.g. `fix typo in changelog`, `reindent with tabs`, `clean up firmware entry`. Lowercase, no period, no body.

Commit author: the local git identity (the maintainer), **not** `zwave-js-bot`. No `--author` override.

## Step 5: Verify

- `gh pr diff <n>` shows only the intended changelog bytes changed; no whitespace changes elsewhere.
- `gh pr view <n> --json title,statusCheckRollup` — confirm new title and that CI (`test-and-release.yml`, `check-integrity.cjs`) re-runs cleanly on the new head.
- If the pipeline output was nontrivial, re-run it once more against the committed text — should now be idempotent under the style-preserving comparison.

## Gotchas

- `gh pr edit --title` fails with a GraphQL error on this repo. Use `gh api` PATCH instead.
- Run the helper via `node .claude/skills/firmware-update-pr-review/format-changelogs.cjs <file>` from the repo root — prettier must resolve against the project's `node_modules`.
- When a modified entry has pre-existing formatting issues the submitter didn't touch (e.g. a leading-space bullet introduced in an older PR), they are still in-scope if the current PR's diff **touches that changelog string**. Fix them.
- Some submitters already use `-` bullets; the pipeline typically produces zero diff for those. Title-only edits in that case.
- Changelogs may contain unescaped `"` or Markdown special chars — always edit via the `Edit` tool on the JSON string, never regex-replace across the file.
- Indentation is the one exception to "touch only what the PR touched" — if the file has mixed tabs/spaces, fix the whole file in one pass so it ends up consistently tabbed.
