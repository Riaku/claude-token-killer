# claude-token-killer

A Claude Code mod that kills wasted tokens at the source: it intercepts the
commands an agent runs most — `git status`, `git diff`, `git show`, `git log`,
recursive `grep` (plus `rg` and `git grep`), `ls` (local, or inside a pod via
`kubectl exec -- ls`), `find`, `docker ps`, `kubectl get`, `kubectl logs`,
`flux get`, `gh … list`, `gh run view --log`, `gh pr checks`, `gh pr view`,
`pytest`, `vitest`, `playwright test`, `npm install`, `cargo test`, `go test`,
`go build`, `go vet`, `ps`, `df`, `free`, `kubectl top`, `docker images` —
rewrites them into compact forms on the fly where that is provably safe, and
compresses their output before the model ever sees it.

This is the Claude-native take on
[rtk (Rust Token Killer)](https://github.com/rtk-ai/rtk) and
[PTK](https://github.com/Riaku/ptk): same idea, but instead of shelling
out to an external binary, the rewrite happens **inside** Claude Code as a
function-hook mod. No binary to install, no PATH to poison, no wrapper to
trust — one plugin, pure TypeScript, zero process spawns.

> **Ceiling worth knowing.** Claude Code caps what a `tool.call` hook receives
> for very large results: measured here, a 22.4 KB `kubectl logs` compressed
> end-to-end to 10.1 KB, while a 63.9 KB `gh run view --log` was compressed only
> in its first ~226 of 592 lines before the harness switched to persisted output
> plus a 2 KB preview. Below roughly 22 KB the mod sees everything; above it,
> the harness decides what the model reads.
>
> **Scope.** Bash handlers everywhere except Windows (non-Windows is treated
> as Linux); the `Get-ChildItem` handler is Windows-only. Everything runs
> in-process. Caps and formats are opinionated; tune them via plugin
> options. Only `git status`, `git diff`, `grep`, and `git show` are ever
> *rewritten* — every other command runs exactly as written and only its
> output is compressed. A trailing `2>&1` is understood: it is split off,
> the command in front of it is planned, and the redirect is re-appended
> verbatim after any flags the rewrite added.

## What it does

| Command | Rewrite | Output |
| --- | --- | --- |
| `git status` | `git status --porcelain=v1 -b -uall` | `* branch [ahead N]` + one line per file, untracked capped |
| `git diff` | `git diff --no-color` | `N files changed, +A -R`, per-file `path +x -y`, context collapsed to 1 line, per-file and total caps with recovery hints |
| `git show` | `git show --no-color` | commit header on one line (`sha7 subject (author, YYYY-MM-DD)`) + the same diff compaction as `git diff` |
| `git log` | none | one line per commit: `sha7 subject (author, YYYY-MM-DD)`, body reduced to `+N lines`, capped with a recovery hint |
| `git show --pretty/--format`, `git log --graph/--pretty/--format`, `git log --oneline` | none | untouched — user-chosen format or already compact |
| `grep -r pat dir/` | `grep -n -r pat dir/` | `K matches in F files`, grouped by file, per-file and total caps, long lines truncated |
| `ls`, `ls -la` | none — runs exactly as written | `dir/` and `file (size)`, timestamps/owner/group dropped |
| `find . -name …` | none | grouped by parent directory with counts (`dir/ (3): a.txt b.txt c.txt`) |
| `docker ps`, `kubectl get <kind>` | none | padded column tables compacted to value rows |
| `kubectl get … -o wide` | none | same table compaction — `wide` is a padded table, not a machine format; `json`/`yaml`/`name`/`jsonpath`/`custom-columns` still bail |
| `kubectl logs <target>` | none | ANSI stripped, runs of identical lines collapsed to `line  xN`, head + tail kept under a cap with every `error`/`warn`/`panic` line rescued from the elided middle; `-f`/`--follow` bail |
| `flux get <kind>` | none | the tab-separated table compacts like any other (flux uses a tabwriter, so this needs the tab path) |
| `kubectl exec <pod> -- ls -l …` | none | the inner command is routed to the `ls` compactor; anything other than a long-format `ls` (and `-R`, `-it`) bails |
| `gh run view --log`, `--log-failed` | none | one block per job/step, timestamps and runner section markers dropped, repeats collapsed to `line  xN`, per-step cap with every error/warn line rescued |
| `gh pr checks` | none | the job URL collapses to `job:<id>` — what `gh run view --job` wants — and rows are capped; `--watch` bails |
| `gh pr view` | none | metadata block kept verbatim, body capped with an elision hint, blank-line runs collapsed |
| `rg -n`, `git grep -n` | none | the same grouping as recursive grep; needs line numbers, and count/list/context/output modes bail |
| `ps`, `df`, `free`, `kubectl top`, `docker images` | none | column padding squeezed with the trailing field kept verbatim (so a `ps` COMMAND containing spaces survives), rows capped with error rows rescued |
| `playwright test` (also via `npx`/`pnpm exec`/`yarn`/`bunx`) | none | result lines and failure blocks kept, per-worker progress dropped, summary counts folded onto one line; `--reporter`, `--ui`, `--debug`, `--headed` bail |
| `go build`, `go vet` | none | `go: downloading/finding` chatter dropped, repeated identical diagnostics collapsed; every diagnostic line kept verbatim |
| `pytest`, `vitest run` | none | failure blocks and summaries kept, progress dots/bars/spinners dropped, counts on one line |
| `npm`/`pnpm`/`yarn install` | none | summary lines (`added N packages`, `N vulnerabilities`, `WARN`/`ERR`) only |
| `cargo test` | none | per-binary `test result:` lines and failure blocks; `error` lines always survive |
| `go test` | none | `--- FAIL` blocks and `ok`/`FAIL` package lines; `=== RUN` noise dropped |
| `gh pr/issue/run list` | none | padded table → one compact row per item |

Every rewrite is guarded: compound commands (pipes, `&&`, redirects, command
substitution), machine formats the compressor can't parse (`-z`,
`--porcelain=2`, `--stat`, `--count`, `--name-only`, `-o json`, `--json`,
`-json`, `--format`, `--reporter`, `--help`, …), user-requested live output
(`pytest -s`, `--pdb`, `cargo test --nocapture`), side-effecting `find`
predicates (`-exec`, `-delete`, `-fprint`, …), failed commands, and anything
else run **exactly as the model wrote them**. A compressor that would make
the output *longer* is discarded. If the mod itself throws, the dispatch is
replayed untouched (fail-open).

Measured live in Claude Code sessions against real commands (bytes the
model received vs raw stdout): `ls -la` 705 → 105, `git log` 1,179 → 329,
`git show HEAD` 527 → 171, `kubectl get pods -n apps` 2,588 → 1,529,
`gh pr list --limit 5` 708 → 627, `kubectl logs` of a 301-line pod log
3,927 → 45, `kubectl get nodes -o wide` 589 → 463, `flux get kustomizations -A`
431 → 351. Savings depend on shape, not just size:
a `find` whose results are one file per directory barely shrinks (165 → 164,
shorter by one byte), and the never-inflate guard leaves it alone.

## PowerShell tool (PoC)

On Windows, Claude Code registers a `PowerShell` tool alongside `Bash`. The
mod registers a second `tool.call` handler for it covering the cmdlet with
the fattest output: `Get-ChildItem` (and its aliases `gci` / `ls` / `dir`).

| Cmdlet | Rewrite | Output |
| --- | --- | --- |
| `Get-ChildItem` | none — runs exactly as written | `path (N entries):` + `dir/` / `file (size)`, table headers, user/group columns and timestamps dropped, entry cap with recovery hint |

Compression-only by design: PowerShell parameter semantics are riskier to
rewrite than bash's, and the six-column `Format-Table` is where the tokens
actually go. The parser reads rows from the back (name last, size before
it), so both the Windows (`Mode LastWriteTime Length Name`) and Linux pwsh
(`UnixMode User Group LastWriteTime Size Name`) column layouts work.
Measured on live `pwsh` output: **84% smaller** (2.9 KB → 0.5 KB for a
38-entry directory). Same safety rules as the Bash side: unrecognized
output, refusals, errors and interrupts pass through; the `# tk:raw`
comment marker disables the trim.

**Windows only, by explicit gate.** The engine registers the PowerShell
tool on Linux/macOS only when `CLAUDE_CODE_USE_POWERSHELL_TOOL=true` is
set; this mod deliberately does *not* trim that configuration. The gate
is a single in-process env read (`OS=Windows_NT`, set by every NT-family
shell, unset on Linux/macOS) - no process spawn, ever, on the PowerShell
path. Verified live: with the flag set on Linux, `Get-ChildItem` output
reaches the model raw and uncompressed.

## Startup cost

Zero. Nothing runs at session start and no path spawns a process. The
platform gate is a single memoized in-process env read: `OS=Windows_NT`
means Windows (set by every NT-family shell, unset on Linux/macOS),
everything else is treated as Linux. That is safe because the
compressors are format-driven with a never-inflate guard and git
porcelain / grep output is platform-identical - an unexpected platform's
output fails to match and passes through unchanged. Non-candidate
commands never even read the env: the plan check returns first.

## Getting the full output back

Compression never strands the model. Whenever lines are elided, the elision
line names the exact recovery command, tagged with the bail marker
`# tk:raw`:

```
... +140 lines elided - raw: git diff -- big.txt # tk:raw
```

The planner bails on any command containing a comment, so re-running the
hinted command verbatim reaches the shell untouched and its output is
never compressed — the same "recall" idea as PTK, without a recall store.
Failure paths are pass-through too: refusals, non-zero exits, and
interrupted commands all keep their real, uncompressed output.


## Install

```bash
claude plugin marketplace add Riaku/claude-token-killer
claude plugin install token-killer@claude-token-killer
```

Or try it without installing anything:

```bash
claude --plugin-dir /path/to/claude-token-killer
```

Requires Claude Code 2.1.287+ (mods). On builds where function hooks are
still gated, launch with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## Options

Set via `claude plugin configure token-killer`:

| Option | Default | Meaning |
| --- | --- | --- |
| `maxStatusFiles` | 200 | untracked files listed before elision |
| `maxDiffLinesPerFile` | 60 | kept hunk lines per file |
| `maxDiffTotalLines` | 400 | kept diff lines across all files |
| `maxGrepPerFile` | 8 | kept matches per file |
| `maxGrepTotal` | 150 | kept matches across all files |
| `maxLineLen` | 200 | truncate longer match lines |
| `notify` | `true` | toast with bytes saved when ≥ 200 bytes saved |

## Layout

```
.claude-plugin/   plugin.json + marketplace.json
hooks/
  hooks.json      names the module
  register.ts     the tool.call hook (planner chain, wiring, guards, fail-open)
  plan.ts         git status/diff + grep: command -> rewrite planner (safety-critical, pure)
  ansi.ts         the one escape-sequence definition: stripAnsi + the parse-then-retry guard
  compress.ts     git status/diff + grep: output compressors (pure, no I/O)
  gitshow.ts      git show: planner + header compaction, diff body via compress.ts
  gitlog.ts       git log: planner + one-line-per-commit compaction
  ls.ts           ls long format: planner + entry compaction
  find.ts         find: planner (side-effect flags bail) + directory grouping
  tables.ts       docker ps / kubectl get: generic column-table compactor (space + tab) + planners
  kubectllogs.ts  kubectl logs: planner (streams/unknown flags bail) + log compaction
  flux.ts         flux get: planner; table body via tables.ts
  ghrunview.ts    gh run view --log: job/step blocks, timestamps and runner noise dropped
  ghpr.ts         gh pr checks (URL -> job id) and gh pr view (metadata kept, body capped)
  grepalias.ts    rg and git grep reuse the grep compressor
  kubectlexec.ts  kubectl exec -- ls -l reuses the ls compactor
  sysinfo.ts      ps/df/free/kubectl top/docker images: padding squeeze + row cap
  pytest.ts       pytest output compaction
  vitest.ts       vitest output compaction
  playwright.ts   playwright test output compaction
  npm.ts          npm/pnpm/yarn install output compaction
  cargotest.ts    cargo test output compaction (error lines always survive)
  gotest.ts       go test output compaction
  gobuild.ts      go build / go vet output compaction
  gh.ts           gh pr|issue|run list table compaction
  powershell.ts   Windows-only PowerShell handler (Get-ChildItem)
tests/            claude-code/testing suites, one file per module
types/            vendored claude-code.d.ts for typechecking
```

Each command module is self-contained: a `planX(command)` that returns a
rewrite or `null`, a `compressX(text, caps)` that returns the original
unchanged when it doesn't recognize the format, and its own default caps.
`register.ts` only owns the chain and the shared guards.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit against the vendored types
npm run validate     # claude plugin validate .
npm test             # claude plugin test .
```

## License

MIT
