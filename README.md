# claude-token-killer

A Claude Code mod that shrinks what tool calls print before the model reads
them. It runs in-process as a function hook: no external binary, no `PATH`
changes, no process spawns.

This is the Claude-native take on [rtk](https://github.com/rtk-ai/rtk) and
[PTK](https://github.com/Riaku/ptk) — same idea, executed inside Claude Code
instead of in a wrapper around it.

You get two kinds of saving, at two points in a tool call:

- **Before the call runs**, four commands are rewritten into forms whose output
  is cheaper to produce and to parse.
- **After it runs**, the output of the commands in [What it saves](#what-it-saves)
  is compacted: repository state and search results, cluster tables, CI logs,
  and test runs.

Both stages offer a way back: an elision line names the command to re-run
tagged `# tk:raw`, and that command prints every line, untrimmed. For the four
commands the mod rewrites, you get the compact form rather than the original
pretty-printed one; for everything else, you get the same output you would have
seen, whole.

Under the prompt, the plugin keeps a running total for the session:

```
  ⚠ token-killer: 6778 B saved this session
```

Bytes, because bytes are what the hook measured. The total survives `--resume`,
starts clean in a new session, and only moves on a call that actually shrank.
Nothing is painted outside the terminal, so `-p` output and the SDK see no line.

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

**Requirements:** Claude Code 2.1.287 or later in the terminal, or 2.1.286 or
later in the Desktop app. Mods are on by default in both. If you set
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` during early access, remove it: 2.1.287 and
later ignore the variable. See
[Mods](https://code.claude.com/docs/en/plugins/mods/overview).

## What it saves

Each row compares the bytes the model receives with the mod against the bytes
the same command printed without it. One representative run per row, measured on
this project's own workspace, a 40-file working tree, and a 240-line pod log.
Rows for toolchains that were not installed here replay fixtures whose headers
say they were written to each tool's documented output shape.

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
| `kubectl get nodes -o wide` | 888 B | 701 B | 21% | padding squeezed; the extra `wide` columns are kept |
| `kubectl logs` | 16,719 B | 1,652 B | 90% | repeated lines collapsed to `line  xN`, head and tail kept, every error and warning line rescued |
| `kubectl exec -- ls -la` | 841 B | 194 B | 77% | the inner listing is compacted as if it had run locally |
| `flux get` | 432 B | 351 B | 19% | tabwriter output compacted |
| `docker ps` | 1,248 B | 887 B | 29% | padded columns reduced to value rows, one line per container |
| `gh run view --log` † | 63,911 B | 10,256 B | 84% | one block per job and step, timestamps and runner markers dropped, failures kept verbatim |
| `gh pr checks` | 102 B | 33 B | 68% | the job URL becomes the job id that `gh run view --job <id> --log` takes |
| `ps aux` | 6,318 B | 5,636 B | 11% | column padding squeezed, trailing command kept intact, rows capped |
| `df -h` | 2,201 B | 1,138 B | 48% | same squeeze |
| `free -h` | 207 B | 106 B | 49% | same squeeze |
| `docker images` | 181 B | 149 B | 18% | same squeeze; `CREATED` is kept verbatim |
| `kubectl top pods` | 2,040 B | 1,341 B | 34% | same squeeze |
| `pytest` | 1,206 B | 941 B | 22% | failure blocks, short-summary lines, and the totals line; progress output dropped |
| `vitest run` | 1,845 B | 1,504 B | 18% | result lines and failures; worker progress dropped |
| `playwright test` | 582 B | 475 B | 18% | results and failure blocks; per-worker progress dropped |
| `cargo test` | 997 B | 522 B | 48% | per-binary result lines and failure blocks |
| `go test` | 519 B | 380 B | 27% | failure blocks and package result lines |
| `go build`, `go vet` | 170 B | 47 B | 72% | module download chatter dropped, repeated diagnostics collapsed, every diagnostic kept |
| `npm install` | 146 B | 143 B | 2% | summary lines only; a clean non-interactive install has little to trim |
| `Get-ChildItem` | 1,406 B | 202 B | 86% | `path (N entries):` plus names and sizes; headers, owner, and timestamps dropped |
| `Get-ChildItem -Recurse` † | 589,492 B | 7,462 B | 99% | one line per directory with its entry count, budgeted by directory, so the first directory cannot spend it all and the rest of the tree still shows |
| `Get-Process` | 1,470 B | 578 B | 61% | `name id ws cpu` per process; Handles, NPM, PM, VM and SI dropped, `SI` hoisted to the legend when it is constant |
| `Get-Command` † | 37,040 B | 9,844 B | 73% | one line per command with the header printed once; column padding and the dash rule dropped |
| `Get-Help <cmdlet> -Full` | 7,257 B | 1,801 B | 75% | section titles, the description's opening lines, one line per parameter; the `Required?`/`Position?` boilerplate and RELATED LINKS dropped |
| `Get-Module -ListAvailable` | 1,782 B | 1,070 B | 40% | one heading per install root, one line per module; column padding and the dash rule dropped |

† Measured with the compressor directly. In a live session an output that size
is saved to a file before the mod sees it (see [Limits](#limits)), so the model
reads that log from the file instead.

The table lists the commands whose output shape is stable and whose saving was
measured. `rg` reuses the grep row, and `gh issue list` and `gh run list` share
the `gh pr` list compactor. `gh pr view` is compacted but has no row: its output
is mostly the pull request body, so the saving depends on that body rather than
on anything this table could generalize.

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

- **Results over 30,000 bytes never reach the mod.** Claude Code writes larger
  output to a file and gives the model a stub of about 2.2 KB naming that file,
  so there is nothing to compress. Measured on this repository: 30,000 bytes
  arrived whole; 31,000, 33,000, 58,000, 64,000, 70,000 and 86,000 bytes arrived
  as stubs. A large commit or log is read from the file at full size; only
  results under the limit benefit.
- **Native Windows gets no Bash compression.** The gate treats only
  `OS=Windows_NT` as Windows, so the Bash handlers stay inert there; under WSL
  the platform reports Linux and they apply. The PowerShell handler covers the
  native case.
- **No compound commands.** Splitting on `&&` or `;` would mean deciding which
  side effects are safe to enter, which cannot be done reliably.

## PowerShell tool

On Windows, Claude Code registers a `PowerShell` tool alongside `Bash`, and the
mod registers a handler for it. Every cmdlet table in PowerShell is the same
`Format-Table` shape with a dash rule under its header, so one parser reads them
all and only the column policy differs.

| Cmdlet | What the model gets |
| --- | --- |
| `Get-ChildItem` (also `gci`, `ls`, `dir`) | `path (N entries):`, `dir/`, `file (size)`; headers, owner, and timestamps dropped; with `-Recurse`, one line per directory and one entry budget across the whole tree |
| `Get-Process` (also `ps`, `gps`) | one line per process: working set, CPU, Id, name; Handles, NPM, PM, VM and SI dropped |
| `Get-Service` (also `gsv`) | one line per service: status and name; `DisplayName` dropped, because it is the name with spaces |
| `Get-NetTCPConnection` | one line per connection: addresses, ports, state; a column every row shares becomes one legend entry |
| `Get-Command` (also `gcm`) | one line per command: type, name, source; `Version` dropped when every row has one, and the rows stay whole when a few built-in functions have neither a version nor a source |
| `Get-CimInstance` (also `gcim`) | the same squeeze; `CommandLine` is kept whole when it contains spaces |
| `Get-Module -ListAvailable` (also `gmo`) | one heading per install root, one line per module; `PreRelease` and `PSEdition` dropped when the rows split cleanly, whole rows otherwise |
| `Get-WinEvent` | one line per event: timestamp, Id, level, the start of the message; wrapped message lines counted and dropped |
| `Get-Help <cmdlet> -Full` | section titles, the description's opening lines, one line per parameter; the `Required?`/`Position?` boilerplate, RELATED LINKS and the reprinted text dropped |
| `dotnet build`, `dotnet test` | every compiler diagnostic once (MSBuild repeats one per project), passing tests counted instead of listed, the failed test's assertion and stack frames kept, summary kept |

The header names are all the parser trusts, so a table it cannot split back onto
its own headers is left whole rather than spliced into the wrong columns: pwsh
separates wide columns with two spaces and two narrow neighbours with one, and a
value containing a space defeats both. Two rows of the same listing can even
split differently, so the split is chosen once for the whole command.

CI runs every one of these against the real cmdlet on `windows-latest`, which is
the only place `Get-Service`, `Get-NetTCPConnection`, `Get-CimInstance` and
`Get-WinEvent` exist. From that run: `Get-Service` 14,421 B to 9,083 B,
`Get-NetTCPConnection` 9,415 B to 2,532 B, `Get-CimInstance Win32_Process`
12,549 B to 5,789 B, `Get-WinEvent` 2,317 B to 1,547 B.

The cmdlet parsers gate on Windows: `Get-Service`, `Get-NetTCPConnection` and
`Get-WinEvent` do not exist elsewhere. The gate is one memoized environment read,
and no process is spawned to decide it. The shared Bash compressors below the
cmdlet list are not gated - they read output that is identical on every platform.

### Cross-platform commands through the PowerShell tool

`git status`, `git diff`, `git log`, `kubectl logs`, `gh pr view` and the rest of
the Bash-side compressors print the same text whichever shell launched them, so a
PowerShell session uses the same planners instead of getting nothing. A rewrite
is taken only when it means the same thing in both shells: a flag appended at the
end (`git status --porcelain=v1 -b`) is one string either way, but a rewrite that
quotes is not - `'x'` is a literal in PowerShell and a shell-quoted word in bash,
a backtick escapes rather than substitutes, and `$name` is a variable. Those
commands run exactly as written, uncompressed, and `git commit -m 'msg'` is the
common case.

## The session counter

The line under the prompt is the plugin's own pinned status line, so it needs no
configuration and no `settings.json` edit: it appears after the first call that
shrank something, and a session that has saved nothing shows no line at all.

- **Bytes, not tokens.** The hook counts UTF-8 bytes, which is what the text
  actually costs; a token count would need an invented bytes-per-token ratio.
- **Per session.** The total lives in the plugin's own store under
  `saved:<session id>`, so a new session starts at zero and `--resume` picks its
  total back up.
- **Only real savings count.** A refusal, an error, an interrupt, a command the
  planner declines, and output the compressor could not shrink all add nothing.
- **Bounded.** At session start the plugin drops every entry untouched for 14
  days, and every entry past the newest 100, keeping the session being resumed
  whatever its age.
- **Terminal only.** `$.ui.status` is pinned in the TUI; under `-p` or the SDK
  nothing is rendered, though the total still accumulates.

The store is
`<CLAUDE_CONFIG_DIR>/plugins/store/token-killer_<suffix>.json`, with one entry
per session. If you keep your own `statusLine` and want the number there too,
read that file and look up `saved:<session_id>`; each value is
`{"bytes": N, "at": <ms>}`.

`/clear` starts a new session id without a new `session.start`, so the old total
stays on screen until the next call shrinks something; that call switches the
counter to the new id and clears the line.

## Performance

No path spawns a process. The platform gate is a memoized in-process environment
read, and the planner chain returns before that read for any command the mod
does not cover. The counter costs a store read at session start (one per stored
session while pruning) and one small JSON write per compressed call; the
in-process total means a tool call never reads the store back.

## Change the limits

Caps are defaults, not policy. You can change them per project:

```bash
claude plugin configure token-killer
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxStatusFiles` | 200 | changed and untracked entries listed before elision (50, 100, 200, 500, 1000) |
| `maxDiffLinesPerFile` | 60 | kept hunk lines per file (20, 40, 60, 100, 200) |
| `maxDiffTotalLines` | 400 | kept diff lines across all files (150, 400, 800, 1500, 3000) |
| `maxGrepPerFile` | 8 | kept matches per file (3, 5, 8, 15, 30) |
| `maxGrepTotal` | 150 | kept matches across all files (50, 100, 150, 300, 600) |
| `maxLineLen` | 200 | truncate longer match lines (80, 120, 200, 300, 500) |
| `maxDirEntries` | 200 | entries listed before elision (50, 100, 200, 500, 1000); `ls`, `find` and a recursive `Get-ChildItem` spend one budget across every directory, a non-recursive multi-path call gets it per directory |
| `maxCmdletRows` | 200 | rows kept from `Get-Process`, `Get-Service`, `Get-NetTCPConnection`, `Get-CimInstance`, `Get-Command`, `Get-Module` and `Get-WinEvent`, and lines kept per section of a `Get-Help -Full` topic (50, 100, 200, 500, 1000) |
| `maxDiagLines` | 40 | compiler diagnostics kept from `dotnet build` and `dotnet test` before the rest are counted (10, 20, 40, 80, 160); a diagnostic repeated per project counts once |
| `notify` | `true` | show a toast with bytes saved when at least 200 bytes were saved |

Each cap is a pick-list, not a free-text number, so `claude plugin configure`
opens with its default already selected and `Save configuration` needs no
typing. That is not a design taste: Claude Code only prefills boolean and
pick-list fields in that dialog, and leaves a `number` row blank, so a
numbers-typed cap would greet every fresh install with seven empty fields.
A stored value outside its list is treated as unset, and the shipped default
applies - Claude Code drops it, and the hook rejects it as well, so a value the
picker never offered can never become a live cap.

The eight options above are the ones worth setting: seven of them decide how
much of a common command's output you see, and `notify` controls the toast. The
hook fixes every other limit:

- the commit count in `git log`, and the head, total and tail splits in pod logs
- the failure counts in pytest, vitest and playwright, and the warning count in
  pytest
- the row count of a table, host rows for `ps`, `df`, `free`, `docker images` and
  `kubectl top`, and the length of a `gh` list
- where npm, cargo and go output is cut

The hook sets each so that ordinary output for that command passes through
whole. When output is not ordinary, the elision line names the command that
re-runs it.

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
Windows, and `test:live` on Linux with pytest, Go and Rust installed. The point
of the last one is version drift: the fixtures hold output captured once or
written by hand to the documented shape, so a change in how `pytest -q` or
`cargo test` formats a failure would otherwise reach users unnoticed.

Each `hooks/*.ts` module owns its planner, its compressor, and its default caps;
`register.ts` owns only the planner chain, the platform gate, and the fail-open
boundary.

```
.claude-plugin/   plugin.json + marketplace.json
hooks/
  hooks.json      names the module
  register.ts     the tool.call hook: planner chain, wiring, guards, fail-open
  plan.ts         git status/diff + grep: command -> rewrite planner
  ansi.ts         the single escape-sequence definition: strip and retry
  compress.ts     git status/diff + grep: output compressors
  gitshow.ts      git show: planner + header compaction, diff body from compress.ts
  gitlog.ts       git log: planner + one-line-per-commit compaction
  ls.ts           ls long format: planner + entry compaction
  find.ts         find: planner (side-effect flags bail) + directory grouping
  tables.ts       docker ps / kubectl get: column-table compactor (space + tab) + planners
  kubectllogs.ts  kubectl logs: planner (streams and unknown flags bail) + compaction
  flux.ts         flux get: planner; table body from tables.ts
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
  dotnet.ts       dotnet build / dotnet test output compaction
  powershell.ts   PowerShell handler: route a command, Get-ChildItem listings
  pwshcmdlets.ts  Format-Table parser and the cmdlet column policies
  pwshevents.ts   Get-WinEvent tables: one line per event
  pwshhelp.ts     Get-Help -Full topics: sections, not parameter boilerplate
tests/            claude-code/testing suites, one file per module
types/            vendored claude-code.d.ts for typechecking
```

## License

MIT
