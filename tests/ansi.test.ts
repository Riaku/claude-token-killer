import { describe, expect, test } from 'claude-code/testing'

import { hasAnsi, stripAnsi, stripRetry } from '../hooks/ansi.ts'
import { DEFAULT_CAPS, compressGitDiff, compressGitStatus, compressGrep } from '../hooks/compress.ts'
import { compressTable } from '../hooks/tables.ts'

// A colored table: the escape codes sit in front of the header cells and around
// one value, which is exactly what used to make the parser decline.
const PLAIN_TABLE = [
  'NAME                   READY   STATUS    RESTARTS   AGE',
  'drop-7d9f8c6b5-abcde   1/1     Running   0          2d',
  'drop-7d9f8c6b5-fghij   1/1     Running   0          2d',
  'drop-7d9f8c6b5-klmno   0/1     Pending   0          3m',
].join('\n')

const COLOR_TABLE = [
  `\x1b[1m${PLAIN_TABLE.split('\n')[0]}\x1b[0m`,
  ...PLAIN_TABLE.split('\n').slice(1).map((l) => l.replace('Running', '\x1b[32mRunning\x1b[0m')),
].join('\n')

// A colored diff, in the shape `git diff --color=always` emits.
const PLAIN_DIFF = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,2 @@',
  '-old line',
  '+new line',
].join('\n')

const COLOR_DIFF = [
  '\x1b[1mdiff --git a/a.txt b/a.txt\x1b[m',
  '\x1b[1m--- a/a.txt\x1b[m',
  '\x1b[1m+++ b/a.txt\x1b[m',
  '\x1b[36m@@ -1,2 +1,2 @@\x1b[m',
  '\x1b[31m-old line\x1b[m',
  '\x1b[32m+new line\x1b[m',
].join('\n')

describe('stripAnsi', () => {
  test('leaves clean text byte for byte', () => {
    for (const s of ['', 'plain text', 'a\tb\nc', 'crlf\r\nstyle']) {
      expect(stripAnsi(s)).toBe(s)
    }
  })

  test('removes CSI colour and OSC hyperlinks, keeps layout', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b[1;32mbold green\x1b[m')).toBe('bold green')
    // OSC 8 hyperlink, BEL-terminated
    expect(stripAnsi('\x1b]8;;https://x.test\x07link\x1b]8;;\x07')).toBe('link')
    // OSC 8 hyperlink, ST-terminated
    expect(stripAnsi('\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
  })

  test('does not touch carriage returns or tabs', () => {
    // \r carries progress redraws; the modules that model those collapse them,
    // a blanket control-character filter would silently destroy them here.
    expect(stripAnsi('a\rb\tc')).toBe('a\rb\tc')
  })

  test('hasAnsi is a plain byte check', () => {
    expect(hasAnsi('plain')).toBe(false)
    expect(hasAnsi('\x1b[31mred\x1b[0m')).toBe(true)
    expect(hasAnsi('')).toBe(false)
  })
})

describe('stripRetry', () => {
  test('adopts the first parse without stripping when it already worked', () => {
    const out = stripRetry('a\nb', (t) => t.replace('b', 'B'))
    expect(out).toBe('a\nB')
  })

  test('retries on a stripped copy only when the first parse declined', () => {
    const parse = (t: string) => (t.includes('keep') ? `parsed:${t.replace(/\x1b\[[0-9;]*m/g, '')}` : t)
    expect(stripRetry('\x1b[31mkeep\x1b[0m', parse)).toBe('parsed:keep')
  })

  test('returns the original text when the stripped copy still does not parse', () => {
    const raw = '\x1b[31mnot a table at all\x1b[0m'
    const parse = (t: string) => t // always declines
    expect(stripRetry(raw, parse)).toBe(raw)
  })

  test('clean text that does not parse is returned untouched', () => {
    expect(stripRetry('plain', (t) => t)).toBe('plain')
  })

  test('a parse that merely echoes the input back is not mistaken for a parse', () => {
    // Compressors that do not recognise their input return it, usually minus the
    // trailing newline. That is not a successful parse, so the stripped copy
    // still has to be tried - otherwise a coloured status never compresses.
    const raw = '\x1b[1m## main\x1b[m\n\x1b[31m M a.txt\x1b[m\n'
    // Recognises the header only when it starts the string, as a real parser does.
    const parse = (t: string) => (t.startsWith('## ') ? '* ' + t.slice(3).trimEnd() : t.trimEnd())
    expect(stripRetry(raw, parse)).toBe('* main\n M a.txt')
  })
})

describe('coloured tables now compress', () => {
  test('the plain table compresses', () => {
    const out = compressTable(PLAIN_TABLE, undefined, 'kubectl get pods')
    expect(out).toContain('# cols:')
    expect(out.length).toBeLessThan(PLAIN_TABLE.length)
  })

  test('the coloured table compresses to the same shape', () => {
    const plain = compressTable(PLAIN_TABLE, undefined, 'kubectl get pods')
    const color = compressTable(COLOR_TABLE, undefined, 'kubectl get pods')
    expect(color).toContain('# cols:')
    expect(color).toBe(plain)
    expect(color).not.toContain('\x1b')
    expect(color.length).toBeLessThan(COLOR_TABLE.length)
  })

  test('a coloured non-table is returned byte for byte', () => {
    const raw = '\x1b[31mError from server (NotFound): pods "x" not found\x1b[0m'
    expect(compressTable(raw)).toBe(raw)
  })
})

describe('coloured diffs now compress', () => {
  test('a coloured diff compresses like the plain one', () => {
    const plain = compressGitDiff(PLAIN_DIFF)
    const color = compressGitDiff(COLOR_DIFF)
    expect(color).toBe(plain)
    expect(color).not.toContain('\x1b')
    expect(color).toContain('+new line')
  })

  test('a coloured status compresses', () => {
    const out = compressGitStatus('\x1b[1m## main\x1b[m\n\x1b[31m M a.txt\x1b[m\n')
    expect(out).toContain('a.txt')
    expect(out).not.toContain('\x1b')
  })

  test('a coloured grep result compresses', () => {
    const line = (n: number) => `\x1b[35mhooks/ls.ts\x1b[m:\x1b[32m${n}\x1b[m:hit number ${n} in the listing helper`
    const out = compressGrep(Array.from({ length: 8 }, (_, i) => line(i + 1)).join('\n'))
    expect(out).toContain('hooks/ls.ts')
    expect(out).toContain('8 matches in 1 file')
    expect(out).not.toContain('\x1b[35m')
  })
})

describe('escape bytes that are data are never destroyed', () => {
  test('an added line containing a literal escape survives verbatim', () => {
    const diff = [
      'diff --git a/log.txt b/log.txt',
      '--- a/log.txt',
      '+++ b/log.txt',
      '@@ -1 +1 @@',
      '-old',
      '+\x1b[31mraw escape printed by the program under test\x1b[0m',
    ].join('\n')
    const out = compressGitDiff(diff)
    // The escape bytes are the content here, not formatting: they must survive.
    expect(out).toContain('\x1b[31mraw escape printed by the program under test\x1b[0m')
  })

  test('an unstructured blob of escapes comes back byte identical', () => {
    const blob = 'noise \x1b[2J\x1b[H more noise \x1b[0m end'
    expect(compressGitDiff(blob)).toBe(blob)
    expect(compressTable(blob)).toBe(blob)
    expect(compressGitStatus(blob)).toBe(blob)
  })

  test('a file listing with escapes in filenames keeps them', () => {
    const raw = '## main\n?? wei\x1b[31mrd\x1b[0m-name.txt\n'
    const out = compressGitStatus(raw)
    expect(out).toContain('name.txt')
  })
})
