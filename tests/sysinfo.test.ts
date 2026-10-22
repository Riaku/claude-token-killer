import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_ROWS_CAPS, compressRows, planRows } from '../hooks/sysinfo.ts'

const DF = [
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/sda1        98G   40G   58G  41% /',
  '/dev/sdb1       1.8T  1.2T  600G  67% /mnt/data',
].join('\n')

describe('planRows', () => {
  test('plans the listings it knows the column count for', () => {
    for (const cmd of ['ps aux', 'ps -ef', 'ps -eo pid,cmd', 'df -h', 'free -h', 'docker images', 'kubectl top pods -n apps', 'kubectl top nodes']) {
      expect(planRows(cmd)?.kind).toBe('rows')
    }
    // Sorting is a row order change, not a column change.
    expect(planRows('ps aux --sort=-%mem')?.kind).toBe('rows')
  })

  test('bails on formats whose columns cannot be counted', () => {
    for (const cmd of [
      'ps -p 1',
      'ps aux -o pid,rss', // custom format: a different column set
      'ps aux --format "%p %C"',
      'ps -eo', // no field list
      'df --output=size',
      'df -i',
      'docker images -q',
      'docker images --format "{{.ID}}"',
      'kubectl top pod --containers',
      'kubectl top pods -o json',
      'kubectl get pods',
      'free -h | head',
    ]) {
      expect(planRows(cmd)).toBeNull()
    }
  })
})

describe('compressRows', () => {
  test('squeezes column padding', () => {
    const out = compressRows(DF, undefined, 'df -h')
    expect(out).toBe(
      [
        'Filesystem Size Used Avail Use% Mounted on',
        '/dev/sda1 98G 40G 58G 41% /',
        '/dev/sdb1 1.8T 1.2T 600G 67% /mnt/data',
      ].join('\n'),
    )
    expect(out.length).toBeLessThan(DF.length)
  })

  test('leaves two spaces inside the trailing field alone', () => {
    // ps aux: the last column is COMMAND. Re-joining it would split a path that
    // contains a double space, so it is copied verbatim.
    const header = 'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND'
    const row = 'root     1  0.0  0.1  1000  200 ?  Ss  Oct21  0:00 /opt/My  App --flag'
    const out = compressRows(`${header}\n${row}`, undefined, 'ps aux')
    expect(out).toContain('/opt/My  App --flag')
    expect(out).not.toContain('root    ')
  })

  test('caps a long listing and rescues error rows', () => {
    const rows = Array.from({ length: 100 }, (_, i) => `row ${i} value`)
    rows.push('row 100 error: no space left on device')
    const raw = ['NAME VALUE', ...rows].join('\n')
    const out = compressRows(raw, DEFAULT_ROWS_CAPS, 'ps aux')
    expect(out).toContain('rows elided - raw: ps aux # tk:raw')
    expect(out).toContain('error: no space left on device')
    expect(out).toContain('row 0 value')
    expect(out).not.toContain('row 99 value')
    expect(out.length).toBeLessThan(raw.length)
  })

  test('never inflates unpadded output', () => {
    const plain = 'Filesystem Size Used\n/dev/sda1 40G 20G'
    expect(compressRows(plain, undefined, 'df -h')).toBe(plain)
  })
})
