# claude-token-killer

A Claude Code mod that kills wasted tokens at the source: it intercepts the
three most chatty commands an agent runs — `git status`, `git diff` and
recursive `grep` — rewrites them into compact forms on the fly, and
compresses their output before the model ever sees it.

This is the Claude-native take on
[rtk (Rust Token Killer)](https://github.com/rtk-ai/rtk) and
[PTK](https://github.com/Riaku/ptk): same idea, but instead of shelling
out to an external binary, the rewrite happens **inside** Claude Code as a
function-hook mod. No binary to install, no PATH to poison, no wrapper to
trust — one plugin, three files of logic.

> **PoC status.** Linux only (the mod no-ops on other platforms). Three
> commands covered. Caps and formats are opinionated; tune them via plugin
> options.

## What it does

| Command | Rewrite | Output |
| --- | --- | --- |
| `git status` | `git status --porcelain=v1 -b -uall` | `* branch [ahead N]` + one line per file, untracked capped |
| `git diff` | `git diff --no-color` | `N files changed, +A -R`, per-file `path +x -y`, context collapsed to 1 line, per-file and total caps with recovery hints |
| `grep -r pat dir/` | `grep -n -r pat dir/` | `K matches in F files`, grouped by file, per-file and total caps, long lines truncated |

Every rewrite is guarded: compound commands (pipes, `&&`, redirects, command
substitution), machine formats the compressor can't parse (`-z`,
`--porcelain=2`, `--stat`, `--count`, `--name-only`, …), failed commands,
and anything else run **exactly as the model wrote them**. A compressor that
would make the output *longer* is discarded. If the mod itself throws, the
dispatch is replayed untouched (fail-open).

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
  register.ts     the tool.call hook (wiring, guards, fail-open)
  plan.ts         command -> rewrite planner (safety-critical, pure)
  compress.ts     output compressors (pure, no I/O)
tests/            claude-code/testing suites
types/            vendored claude-code.d.ts for typechecking
```

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit against the vendored types
npm run validate     # claude plugin validate .
npm test             # claude plugin test .
```

## License

MIT
