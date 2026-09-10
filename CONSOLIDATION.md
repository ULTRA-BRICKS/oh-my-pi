# Oh My Pi Repository Consolidation

Consolidated on 2026-09-09 20:38 UTC from:

- `~/xp/oh-my-pi-pr11401` (PR #11401 exclusive session pinning)
- `~/xp/oh-my-pi-hints` (extension command hints PR)

Original clones archived under `~/xp/_archive-oh-my-pi-consolidation/`.

## Canonical clone

`~/xp/oh-my-pi`

## Remotes

```
origin	https://github.com/alex-mextner/oh-my-pi.git (fetch)
origin	https://github.com/alex-mextner/oh-my-pi.git (push)
upstream	https://github.com/can1357/oh-my-pi.git (fetch)
upstream	https://github.com/can1357/oh-my-pi.git (push)
```

## Branch map

| Branch | Purpose | Tip commit | Source |
|--------|---------|------------|--------|
| `ultra` | Combined local work on top of `upstream/main` | `df6a63f7bbf5` | cherry-picks |
| `pr/11401-exclusive-session-pinning` | PR #11401 exclusive OAuth session pinning | `57b0823def89` | `oh-my-pi-pr11401` @ `feat/exclusive-session-pin` |
| `pr/extension-command-hints` | Extension slash-command inline hints PR | `3cb38fccf5` | `oh-my-pi-hints` @ `feat/extension-command-hints` |
| `feat/exclusive-session-pin` | Legacy feature branch from hints clone | `1303e7a8a3` | distinct object from pr11401 pin commit |
| `feat/extension-command-hints` | Legacy feature branch | `3cb38fccf5` | same tip as `pr/extension-command-hints` |

## Cherry-picks onto `ultra` (from `upstream/main` @ `2e6b5b79a0c5`)

| Order | Source commit | Result on `ultra` | Subject |
|-------|---------------|-------------------|---------|
| 1 | `57b0823def89` | `58f6ef045093` | feat(ai,coding-agent): exclusive OAuth account pinning for sessions |
| 2 | `63424bba7c` | `8031fe3929e6` | feat(coding-agent): extension slash commands get inline hints |
| 3 | `3cb38fccf5` | `df6a63f7bbf5` | docs: add extension-command-hints before/after screenshots |

## Notes

- `upstream/main` was fetched to `2e6b5b79a0c5b190797aace99f41fab6ae42e6c5` at consolidation time (includes merges after `61b1b8ae`).
- PR #11401 pin commit: `57b0823def891c0e52571891e1fb3be84230b084`.
- Hints clone had separate `feat/exclusive-session-pin` at `1303e7a8a3` (same message, different object).
- No force-push to upstream was performed.
- Old clone directories moved to `~/xp/_archive-oh-my-pi-consolidation/`.

## Current branches

```
feat/exclusive-session-pin         1303e7a8a3 [origin/feat/exclusive-session-pin: ahead 1, behind 1] feat(ai,coding-agent): exclusive OAuth account pinning for sessions
  feat/extension-command-hints       3cb38fccf5 [origin/feat/extension-command-hints] docs: add extension-command-hints before/after screenshots
  main                               71058a97d4 [origin/main] Merge pull request #11084 from gitpushoriginmaster/feat/rename-generated-title
  pr/11401-exclusive-session-pinning 57b0823def feat(ai,coding-agent): exclusive OAuth account pinning for sessions
  pr/extension-command-hints         3cb38fccf5 docs: add extension-command-hints before/after screenshots
* ultra                              df6a63f7bb [upstream/main: ahead 3] docs: add extension-command-hints before/after screenshots
```

## `ultra` recent history

```
df6a63f7bb docs: add extension-command-hints before/after screenshots
8031fe3929 feat(coding-agent): extension slash commands get inline hints
58f6ef0450 feat(ai,coding-agent): exclusive OAuth account pinning for sessions
2e6b5b79a0 Merge pull request #10958 from can1357/farm/2ad6a537/fix-streaming-write-highlighting
24cd853bb7 fix(tui): exact append check and args-complete flush for streaming write previews
15ee871919 fix(tui): eliminated write preview highlighting stalls
61b1b8aef6 chore: bump version to 18.1.16
f92a3d0aec Merge pull request #11398 from can1357/fix/rename-title-signal-guard
dfe0002e40 Merge pull request #11396 from PeterPonyu/docs/agents-md-vcs-paths
92c16517bb Merge pull request #11368 from can1357/fix/loop-vibe-entering-race
7716e74a04 fix(coding-agent): complete title signal stub in working-accent harness
4734d3de29 Merge pull request #11387 from PeterPonyu/test/coding-agent-setup-cli-venv-hermetic
4b031898d5 Merge pull request #11386 from PeterPonyu/fix/utils-which-fresh-per-call
22c63cb355 Merge pull request #11385 from PeterPonyu/test/ai-callback-ipv6-gate
85827094f9 docs: point AGENTS.md VCS helpers at natives/vcs
```
