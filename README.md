# claude-token-killer

A Claude Code mod that shrinks what tool calls print before the model reads
them. It runs in-process as a function hook: no external binary, no `PATH`
changes, no process spawns.

This is the Claude-native take on [rtk](https://github.com/rtk-ai/rtk) and
[PTK](https://github.com/Riaku/ptk) — same idea, executed inside Claude Code
instead of in a wrapper around it.

The mod does two things:

- **Rewrites** four commands into forms whose output is cheaper to produce
  and to parse.
- **Compresses** the output of 23 command families, from repository state and
  search results to cluster tables, CI logs, and test runs.

## Install

Add the marketplace, then install the plugin:

```bash
claude plugin marketplace add Riaku/claude-token-killer
claude plugin install token-killer@claude-token-killer
```

To try it without installing anything:

```bash
claude --plugin-dir /path/to/claude-token-killer
```

**Requirements:** Claude Code 2.1.287 or later, where mods are on by
default; the Desktop app needs 2.1.286 or later. The early-access
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` variable is ignored from 2.1.287 on, so it
is not needed.

## What it saves

Each row below compares the bytes the model receives with the mod against the
bytes the same command printed without it. One representative run per row,
measured on this project's own workspace, a 40-file working tree, a 240-line
pod log, and recorded fixtures for the toolchains not installed here.

| Command | Raw | With the mod | Saved | What changes |
| --- | --- | --- | --- | --- |
| `git status` | 629 B | 195 B | 69% | branch line plus one line per file; untracked directories stay collapsed |
| `git diff` | 2,434 B | 1,143 B | 53% | per-file `path +added -removed` summary, hunk context trimmed, caps with recovery hints |
| `git show` | 55,400 B | 18,680 B | 66% | commit header on one line, diff body compacted like a plain diff |
| `git log` | 14,416 B | 1,042 B | 93% | one line per commit, message bodies reduced to a line count |
| `grep -rn` | 15,384 B | 9,506 B | 38% | match count up front, matches grouped by file, long lines truncated |
| `git grep -n` | 44,267 B | 12,293 B | 72% | same grouping as a recursive grep |
| `ls -la` | 841 B | 194 B | 77% | `dir/` and `file (size)`; owner, group, and timestamps dropped |
| `find` | 2,014 B | 1,419 B | 30% | results grouped by parent directory with counts |
| `kubectl get pods` | 2,647 B | 1,555 B | 41% | padded columns reduced to value rows |
| `kubectl get nodes -o wide` | 888 B | 701 B | 21% | same treatment; `wide` is a padded table, not a machine format |
| `kubectl logs` | 16,719 B | 1,652 B | 90% | repeated lines collapsed to `line  xN`, head and tail kept, every error and warning line rescued |
| `kubectl exec -- ls -la` | 841 B | 194 B | 77% | the inner listing is compacted as if it had run locally |
| `flux get` | 432 B | 351 B | 19% | tabwriter output compacted |
| `gh run view --log` † | 63,911 B | 10,256 B | 84% | one block per job and step, timestamps and runner markers dropped, failures kept verbatim |
| `gh pr checks` | 102 B | 33 B | 68% | the job URL becomes the job id, which is what re-runs that job |
| `ps aux` | 6,318 B | 5,636 B | 11% | column padding squeezed, trailing command kept intact, rows capped |
| `df -h` | 2,201 B | 1,138 B | 48% | same squeeze |
| `free -h` | 207 B | 106 B | 49% | same squeeze |
| `kubectl top pods` | 2,040 B | 1,341 B | 34% | same squeeze |
| `pytest` | 1,206 B | 941 B | 22% | failure blocks, short-summary lines, and the totals line; progress output dropped |
| `vitest run` | 1,845 B | 1,504 B | 18% | result lines and failures; worker progress dropped |
| `playwright test` | 582 B | 475 B | 18% | results and failure blocks; per-worker progress dropped |
| `cargo test` | 997 B | 522 B | 48% | per-binary result lines and failure blocks |
| `go test` | 519 B | 380 B | 27% | failure blocks and package result lines |
| `go build`, `go vet` | 170 B | 47 B | 72% | module download chatter dropped, repeated diagnostics collapsed, every diagnostic kept |
| `npm install` | 146 B | 143 B | 2% | summary lines only; a clean non-interactive install has little to trim |
| `Get-ChildItem` | 1,406 B | 202 B | 86% | `path (N entries):` plus names and sizes; headers, owner, and timestamps dropped |

† Measured with the compressor directly. In a live session an output that size
is saved to a file before the mod sees it (see [Limits](#limits)), so the model
reads that log from the file instead.

Savings track output shape more than output size. A directory listing whose
entries are wrapped by the console width, or a search whose hits are one per
file, barely shrinks at all — in which case the mod keeps the original
text rather than replacing it with something no shorter.

## How it works

### Rewrites

Four commands are rewritten before they run. Everything else executes exactly
as written.

| Command | Runs as | Why |
| --- | --- | --- |
| `git status` | `git status --porcelain=v1 -b` | one line per file, no section headers, untracked directories collapsed by git itself |
| `git diff` | `git diff --no-color` | escape sequences never enter the parser |
| `git show` | `git show --no-color` | same, plus the header is folded onto one line |
| `grep -r` | `grep -n -r` | line numbers are what make grouping by file possible |

A trailing `2>&1` is split off before planning and re-appended verbatim after
any flags a rewrite added, so the redirect still behaves as written.

### Compression

| Area | What the model gets |
| --- | --- |
| Repository state | Branch and ahead/behind state, one line per changed file, per-file diff summaries, one line per commit |
| Search results | Match totals, matches grouped by file, truncated long lines |
| Directory listings | Entry counts and entries, locally or inside a container |
| Cluster and CI tables | Value rows without column padding, capped with a recovery hint |
| Logs and run output | Job and step structure, collapsed repeats, every error and warning preserved |
| Checks and pull requests | Job identifiers instead of URLs, metadata kept, long bodies capped |
| Host listings | CPU, memory, and disk tables with padding squeezed and the trailing field kept verbatim, so a command name containing spaces survives |
| Test runners and builds | Failure blocks and result summaries, with progress noise dropped |

### What is never touched

The mod returns the original output, or the original command, in every case
below:

- Compound commands: pipes, `&&`, `;`, redirects, command substitution,
  backticks, and comments.
- Machine formats the compressor cannot parse, such as `-z`, `--json`,
  `-o json`, `--stat`, `--name-only`, `-c`, and `-l`.
- Options that ask for live or interactive output.
- Side-effecting search predicates that run a command per hit or delete matches.
- Failed, refused, and interrupted commands.
- Any compression that would not make the output shorter.

If the mod itself throws, the call is replayed untouched.

## Get the raw output

Compression never strands the model. Whenever lines are elided, the elision
line carries the exact command that brings them back:

```
... +140 lines elided - raw: git diff -- big.txt # tk:raw
```

Copy that line and run it as printed. The `# tk:raw` marker makes the planner
bail, so the output arrives uncompressed. There is no recall store to consult
and no cache to expire.

## Limits

- **Results over 30 KB never reach the mod.** When a command prints more than
  30,000 bytes, Claude Code writes the output to a file and gives the model a
  stub of about 2.2 KB that names the file, so there is nothing for the mod to
  compress. Measured on this repository: a 30,000-byte output arrived whole,
  while outputs of 31,000, 33,000, 58,000, 64,000, 70,000 and 86,000 bytes all
  arrived as stubs. A large commit or log is therefore read from that file at
  full size; only results under the limit benefit.
- **Native Windows gets no Bash compression.** The gate treats only Windows
  as Windows, so the Bash handlers stay inert there; under WSL the platform
  reports Linux and they apply. The PowerShell handler covers the native case.
- **No compound commands.** Splitting on `&&` or `;` would mean deciding which
  side effects are safe to enter, which cannot be done reliably.

## PowerShell tool

On Windows, Claude Code registers a `PowerShell` tool alongside `Bash`. The mod
registers a second handler for the cmdlet with the fattest output.

| Cmdlet | Rewrite | What the model gets |
| --- | --- | --- |
| `Get-ChildItem` (also `gci`, `ls`, `dir`) | none | `path (N entries):`, `dir/`, `file (size)`; headers, owner, and timestamps dropped, entry cap with the recovery hint |

The handler is compression-only by design: PowerShell parameter semantics are
riskier to rewrite than bash's, and the six-column `Format-Table` is where the
tokens actually go. The parser reads each row from the back — name last, size
before it — so both the Windows (`Mode LastWriteTime Length Name`) and the Linux
pwsh (`UnixMode User Group LastWriteTime Size Name`) layouts work. Names that
the console wraps onto a second line are joined back together before parsing;
at the default 80 columns that is the common case, not the edge case.

The handler stays inert unless the platform reports Windows: the gate is one
memoized environment read, and no process is spawned to decide it. This mod
does not trim output when the PowerShell tool is enabled on Linux or macOS.

## Performance

Startup cost is zero. Nothing runs at session start, and no path spawns a
process. The platform gate is a memoized in-process environment read, and the
planner chain returns before that read for any command the mod does not cover.

## Change the limits

Caps are opinionated defaults, not policy. Adjust them per project:

```bash
claude plugin configure token-killer
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxStatusFiles` | 200 | untracked files listed before elision |
| `maxDiffLinesPerFile` | 60 | kept hunk lines per file |
| `maxDiffTotalLines` | 400 | kept diff lines across all files |
| `maxGrepPerFile` | 8 | kept matches per file |
| `maxGrepTotal` | 150 | kept matches across all files |
| `maxLineLen` | 200 | truncate longer match lines |
| `maxDirEntries` | 200 | entries listed per directory before elision |
| `notify` | `true` | show a toast with bytes saved when at least 200 bytes were saved |

## Develop

```bash
npm install
npm run typecheck    # tsc --noEmit against the vendored types
npm run validate     # claude plugin validate .
npm test             # claude plugin test .
npm run test:live    # real pytest, go, cargo, git output through the compressors
```

`test:live` needs the tools it exercises and skips the ones that are missing,
so it is safe to run anywhere: it prints `ok`, `SKIP` or `FAIL` per family and
exits non-zero on a failure. `test:live:windows` does the same for
`Get-ChildItem` against the real `pwsh`.

CI runs the unit suite on Linux, macOS and Windows, the PowerShell check on
Windows, and `test:live` on Linux with pytest, Go and Rust installed. The
point of the last one is version drift: the fixtures replay output recorded
once, so a change in how `pytest -q` or `cargo test` formats a failure would
otherwise reach users unnoticed.

Every module is self-contained: a planner that returns a rewrite or nothing, a
compressor that returns its input unchanged when it does not recognize the
format, and its own default caps. The hook module owns only the planner chain
and the shared guards.

```
.claude-plugin/   plugin.json + marketplace.json
hooks/
  hooks.json      names the module
  register.ts     the tool.call hook: planner chain, wiring, guards, fail-open
  plan.ts         git status/diff + grep: command -> rewrite planner
  ansi.ts         the one escape-sequence definition: stripAnsi + parse-then-retry
  compress.ts     git status/diff + grep: output compressors
  gitshow.ts      git show: planner + header compaction, diff body via compress.ts
  gitlog.ts       git log: planner + one-line-per-commit compaction
  ls.ts           ls long format: planner + entry compaction
  find.ts         find: planner (side-effect flags bail) + directory grouping
  tables.ts       docker ps / kubectl get: column-table compactor (space + tab) + planners
  kubectllogs.ts  kubectl logs: planner (streams and unknown flags bail) + compaction
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

## License

MIT
