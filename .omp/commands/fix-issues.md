# Fix Issues Command

Diagnose, reproduce, then fix reproducible open GitHub issues in parallel: one clean worktree/issue; symlink build artifacts to avoid rebuilds.

## Arguments

`$ARGUMENTS` optional: space/comma-separated issue numbers/URLs, or GitHub-search qualifiers (`is:open`, `label:bug`, `author:foo`, ...) and/or time window (`3d`, `2w`, `12h`).

No issues/flags → all issues open and created within last 3 days.

## 1. Resolve issues

Parse `$ARGUMENTS`.

- Explicit numbers/URLs: use verbatim.
- Otherwise `github` `op: search_issues`. No args:

  ```
  github { op: "search_issues", query: "is:open", since: "3d", limit: 50 }
  ```

  User qualifiers verbatim in `query`; add `is:open` unless present. Time window (`3d`, `2w`, `12h`, ISO date; see `github` docs) → `since`. `dateField` defaults `created`; set `"updated"` only for explicitly requested recently-touched issues.

Print resolved set before fan-out for scope confirmation.

## 2. Parallel subagents

Use parallel `task` subagents: one/issue. Assignment: number, title, body summary, workflow below. Isolated work; `irc` only if issues clearly touch the same file.

Each subagent MUST:

### a. Read

1. Read `issue://<N>`; cross-repo: `issue://<owner>/<repo>/<N>`. Includes body/comments; comments often contain repro/fix hints. Append `?comments=0` only to explicitly skip comments.
2. Run `gh search prs` for issue number. Reasonable existing PR → review per `.omp/commands/review-prs.md`, report `existing-pr`; do NOT create competing fix.

### b. Diagnose/reproduce

MUST reproduce in current cwd on `main`, before any worktree.

1. Read relevant checkout source; state concrete 1–2-sentence failure hypothesis.
2. Under affected package, create focused `repro-issue-<N>-<slug>.test.ts` (or `.rs`, etc.): unique, greppable, deletable.
3. Run only that file, never suite; confirm expected failure.

- Reproduced → c.
- Not reproduced → stop; delete test; report `unreproduced`: hypothesis, non-failure evidence, unblockers (versions, OS, config, author repro snippet). No worktree/commit.
- Out-of-scope/not bug (user-config error, intended behavior, dup) → stop; report `not-a-bug` with issue-postable explanation.

### c. Worktree

Confirmed local repro required.

```bash
MAIN="$(git rev-parse --show-toplevel)"
ENC="$(printf '%s' "$MAIN" | sed 's|[/\\:]|-|g')"
WT="$HOME/.omp/wt/${ENC}/fix-issue-<N>"

git -C "$MAIN" fetch origin main
git -C "$MAIN" worktree add -B "fix/issue-<N>" "$WT" origin/main
```

Branch: `fix/issue-<N>`; `fix/issue-<N>-<slug>` for multiple fixes. Worktree path follows `pr_checkout` convention.

### d. Symlink artifacts, install deps

Before any worktree build/test, symlink build outputs (absolute paths) and install JS deps in the worktree:

```bash
cd "$WT"
ln -snf "$MAIN/target"       "$WT/target"

# JS deps: install them IN the worktree (bunfig.toml pins the hoisted linker; a warm install
# comes from bun's cache). Never symlink node_modules to the main checkout: `bun install` in the
# worktree writes through the link and corrupts the main checkout's tree. A reused worktree may
# still hold such a link from an older run: remove the link itself (never `rm -rf` through it).
if [ -L node_modules ]; then rm node_modules; fi
bun install --frozen-lockfile

# Only the .node binaries are expensive to rebuild. The rest of
# packages/natives/native/ is tracked by git, so folder-level symlinks would
# shadow real source files and break the fix.
for f in "$MAIN"/packages/natives/native/*.node; do
  [ -e "$f" ] && ln -snf "$f" "$WT/packages/natives/native/"
done
```

MUST NOT symlink whole `packages/natives/native/`: shadows tracked source. MUST NOT symlink `node_modules`: run `bun install --frozen-lockfile` in the worktree. If the install fails, retry once (parallel installs can hit a transient `Fail extracting tarball`); if it still fails (for example a lockfile out of sync with `package.json`), report it. MUST NOT drop `--frozen-lockfile` or commit `bun.lock` churn.

### e. Fix

1. Move, never copy, failing test from main into same worktree path; remove it from main.
2. Confirm failure in worktree/current branch.
3. Fix source, following `AGENTS.md` patterns: root cause, not symptom; no product-code stubs/mocks.
4. Re-run repro until passing.
5. If real contract changed, add/adjust adjacent unit/contract tests; run only affected files, never full suite.
6. `bun fmt` union of edited files.

### f. Commit

One logical conventional commit with `Fixes #<N>`:

```bash
git add -A
git commit -m "fix(<scope>): <one-line summary>

<short body explaining root cause and the fix>

Fixes #<N>."
```

Do NOT push; human pushes/opens PR.

### g. Report

```
Issue #<N>  <title>
Status:    fixed | unreproduced | not-a-bug | existing-pr (#<M>)
Repro:     <test path inside worktree>            (if applicable)
Worktree:  ~/.omp/wt/.../fix-issue-<N>            (if created)
Branch:    fix/issue-<N>                          (if created)
Commits:   <shas + one-liners>                    (if any)
Notes:     <root cause in one sentence; or what info is missing>
```

## 3. Aggregate

After all subagents, print:

```
| # | Title | Status | Branch / Notes |
|---|-------|--------|----------------|
```

Group worktree paths by status, `fixed` first, for batch `cd`/push.

## Rules

MUST: reproduce on current-cwd `main` before worktree; parallel one-issue subagents; check existing PR first and divert reasonable ones to `review-prs`; symlink `target` and native `*.node`, and `bun install --frozen-lockfile` (never a `node_modules` symlink), before worktree builds/tests; conventional commits with body `Fixes #<N>`.

MUST NOT: symlink entire `packages/natives/native/`; push, open PRs, or comment on issues; ship stubs, product-code mocks, or `TODO: implement` placeholders; expand beyond reported bug into adjacent code smells.

Failed repro → delete temporary cwd test before yielding; leave original checkout clean.
