import { expect, test, tier } from 'claude-code/testing'

tier('user')

import { DEFAULT_TABLE_CAPS, compressTable, planDocker, planKubectlGet } from '../hooks/tables.ts'

// ------------------------------------------------------------- planners

test('docker ps plans a table trim, including -a and container ls', () => {
  for (const cmd of ['docker ps', 'docker ps -a', 'docker ps --all', 'docker container ls', 'docker container ls -a', 'docker ps -a -s']) {
    const p = planDocker(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('docker-ps')
    // Compression-only: the command is never rewritten.
    expect(p!.command).toBe(cmd)
  }
})

test('docker ps -q and --format bail out', () => {
  // -q is already minimal; --format is the model's own layout.
  for (const cmd of ['docker ps -q', 'docker ps -aq', 'docker ps --quiet', 'docker ps --format "{{.Names}}"', 'docker ps --format=json']) {
    expect(planDocker(cmd)).toBeNull()
  }
})

test('unknown docker flags and non-docker commands bail out', () => {
  for (const cmd of ['docker ps --no-headers-x', 'docker images', 'docker ps | wc -l', 'docker ps; ls', 'docker ps > out', 'docker ps --help', 'podman ps', '']) {
    expect(planDocker(cmd)).toBeNull()
  }
})

test('kubectl get <resource> plans a table trim', () => {
  for (const cmd of [
    'kubectl get pods',
    'kubectl get pods -A',
    'kubectl get pods --all-namespaces',
    'kubectl get nodes',
    'kubectl get svc -n default',
    'kubectl get -n kube-system pods',
    'kubectl get deploy -l app=web',
    'kubectl get pods --sort-by=.status.startTime',
    'kubectl get pods -L app',
  ]) {
    const p = planKubectlGet(cmd)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('kubectl-get')
    expect(p!.command).toBe(cmd)
  }
})

test('machine formats and streams bail out', () => {
  for (const cmd of [
    'kubectl get pods -o json',
    'kubectl get pods -o yaml',
    'kubectl get pods -owide',
    'kubectl get pods --output=jsonpath={.items[*].metadata.name}',
    'kubectl get pods --watch',
    'kubectl get pods -w',
    'kubectl get pods --raw',
    'kubectl get pods -h',
    'kubectl get pods --help',
    'kubectl get pods deploy',
    'kubectl get',
    'kubectl get pods | grep nginx',
    'kubectl describe pods',
    '',
  ]) {
    expect(planKubectlGet(cmd)).toBeNull()
  }
})

// ---------------------------------------------------------- compressor

// Realistic `kubectl get pods`: columns padded to the widest value + 3, which
// is what kubectl's tabwriter emits. Hand-built, not captured.
const PODS = [
  'NAME                       READY   STATUS             RESTARTS   AGE',
  'nginx-6799fc88d-2x7pk      1/1     Running            0          3d',
  'web-5d8f7b9c4d-h4k2m       0/1     CrashLoopBackOff   12         4h',
  'postgres-0                 1/1     Running            2          21d',
  'backup-28917260-9xqln      0/1     Completed          0          6h',
  'pending-7c9f5d8b6d-zz9k2   0/1     Pending            0          2m',
  '',
].join('\n')

// Realistic `docker ps`: single spaces inside COMMAND/CREATED/STATUS, and the
// kiwix row has an empty PORTS cell.
const DOCKER_PS = [
  'CONTAINER ID   IMAGE                           COMMAND                  CREATED       STATUS                  PORTS                  NAMES',
  '3f4b9c1de2ab   nginx:1.27-alpine               "/docker-entrypoint.…"   2 days ago    Up 2 days               0.0.0.0:8080->80/tcp   web',
  '9a1c7e5f0b3d   postgres:16                     "docker-entrypoint.s…"   3 weeks ago   Up 3 weeks (healthy)    5432/tcp               pg',
  'b77e0aa91c55   ghcr.io/kiwix/kiwix-serve:3.7   "kiwix-serve --port=…"   5 days ago    Exited (1) 5 days ago                          kiwix',
  '',
].join('\n')

test('pairs mode: docker ps rows become header=value pairs, empty cells dropped', () => {
  expect(compressTable(DOCKER_PS, { maxRows: 200, mode: 'pairs' })).toBe(
    [
      'container_id=3f4b9c1de2ab image=nginx:1.27-alpine command="/docker-entrypoint.…" created=2 days ago status=Up 2 days ports=0.0.0.0:8080->80/tcp names=web',
      'container_id=9a1c7e5f0b3d image=postgres:16 command="docker-entrypoint.s…" created=3 weeks ago status=Up 3 weeks (healthy) ports=5432/tcp names=pg',
      'container_id=b77e0aa91c55 image=ghcr.io/kiwix/kiwix-serve:3.7 command="kiwix-serve --port=…" created=5 days ago status=Exited (1) 5 days ago names=kiwix',
    ].join('\n'),
  )
})

test('pairs mode: kubectl get pods rows become header=value pairs', () => {
  expect(compressTable(PODS, { maxRows: 200, mode: 'pairs' })).toBe(
    [
      'name=nginx-6799fc88d-2x7pk ready=1/1 status=Running restarts=0 age=3d',
      'name=web-5d8f7b9c4d-h4k2m ready=0/1 status=CrashLoopBackOff restarts=12 age=4h',
      'name=postgres-0 ready=1/1 status=Running restarts=2 age=21d',
      'name=backup-28917260-9xqln ready=0/1 status=Completed restarts=0 age=6h',
      'name=pending-7c9f5d8b6d-zz9k2 ready=0/1 status=Pending restarts=0 age=2m',
    ].join('\n'),
  )
})

test('the two-word CONTAINER ID header stays one column', () => {
  const first = compressTable(DOCKER_PS, { maxRows: 200, mode: 'pairs' }).split('\n')[0]
  expect(first.startsWith('container_id=3f4b9c1de2ab ')).toBe(true)
  expect(first).not.toContain('container=')
})

test('legend mode: header names printed once, values quoted when they hold a space', () => {
  expect(compressTable(DOCKER_PS, { maxRows: 200, mode: 'legend' })).toBe(
    [
      '# cols: container_id image command created status ports names',
      '3f4b9c1de2ab nginx:1.27-alpine "/docker-entrypoint.…" "2 days ago" "Up 2 days" 0.0.0.0:8080->80/tcp web',
      '9a1c7e5f0b3d postgres:16 "docker-entrypoint.s…" "3 weeks ago" "Up 3 weeks (healthy)" 5432/tcp pg',
      'b77e0aa91c55 ghcr.io/kiwix/kiwix-serve:3.7 "kiwix-serve --port=…" "5 days ago" "Exited (1) 5 days ago" - kiwix',
    ].join('\n'),
  )
})

test('auto mode picks the shorter of pairs and legend', () => {
  // Legend wins by a wide margin on real tabwriter output ...
  const pods = compressTable(PODS)
  expect(pods.split('\n')[0]).toBe('# cols: name ready status restarts age')
  expect(pods.length).toBeLessThan(PODS.length * 0.6)

  // ... but pairs is used whenever it is the shorter one. A very wide name
  // column makes the repeated headers cheaper than the padding.
  const wide = [
    'NAME                                                                                        READY   STATUS',
    'a-short-pod                                                                                 1/1     Running',
    '',
  ].join('\n')
  const out = compressTable(wide)
  expect(out.startsWith('name=a-short-pod ready=1/1')).toBe(true)
})

test('kubectl get nodes compresses in the default mode', () => {
  const raw = [
    'NAME   STATUS     ROLES           AGE   VERSION',
    'nuc1   Ready      control-plane   40d   v1.31.4+k3s1',
    'nuc2   Ready      <none>          40d   v1.31.4+k3s1',
    'nuc3   NotReady   <none>          40d   v1.31.4+k3s1',
    '',
  ].join('\n')
  expect(compressTable(raw)).toBe(
    ['# cols: name status roles age version', 'nuc1 Ready control-plane 40d v1.31.4+k3s1', 'nuc2 Ready <none> 40d v1.31.4+k3s1', 'nuc3 NotReady <none> 40d v1.31.4+k3s1'].join(
      '\n',
    ),
  )
})

test('a value wider than its header shifts the rest of the row, not the split', () => {
  const raw = [
    'NAME   STATUS',
    'web    Running',
    'api    Running',
    'db     Running',
    'cache  Running',
    'this-pod-name-is-much-wider-than-the-header   Pending',
    '',
  ].join('\n')
  expect(compressTable(raw, { maxRows: 200, mode: 'legend' })).toBe(
    [
      '# cols: name status',
      'web Running',
      'api Running',
      'db Running',
      'cache Running',
      'this-pod-name-is-much-wider-than-the-header Pending',
    ].join('\n'),
  )
})

test('header decorations like PORT(S) are still a header', () => {
  const raw = ['NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE', 'kubernetes   ClusterIP   10.43.0.1    <none>        443/TCP   40d', ''].join(
    '\n',
  )
  expect(compressTable(raw, { maxRows: 200, mode: 'pairs' })).toBe(
    'name=kubernetes type=ClusterIP cluster-ip=10.43.0.1 external-ip=<none> port(s)=443/TCP age=40d',
  )
})

test('cap truncates and names the exact re-run tagged # tk:raw', () => {
  for (const mode of ['pairs', 'legend'] as const) {
    const out = compressTable(PODS, { maxRows: 2, mode }, 'kubectl get pods')
    const lines = out.split('\n')
    expect(lines[lines.length - 1]).toBe('... +3 more rows (raw: kubectl get pods # tk:raw)')
  }
})

test('default cap is 200 rows', () => {
  expect(DEFAULT_TABLE_CAPS.maxRows).toBe(200)
})

test('non-table output is returned unchanged', () => {
  const cases = [
    'No resources found in default namespace.\n',
    'error: the server doesn\'t have a resource type "pods"\n',
    '{\n  "apiVersion": "v1",\n  "items": []\n}\n',
    'total 24\n-rw-r--r-- 1 u g 6 Oct 22 02:57 a.txt\n',
    '',
  ]
  for (const raw of cases) expect(compressTable(raw)).toBe(raw)
})

test('never inflates: a narrow two-column table is left alone', () => {
  const raw = 'A B\nx y\np q\n'
  expect(compressTable(raw)).toBe(raw)
  expect(compressTable(raw, { maxRows: 200, mode: 'legend' })).toBe(raw)
})

test('an indented non-row after the header means the format is not ours', () => {
  const raw = ['NAME   READY', 'web    1/1', '  (some footnote)'].join('\n')
  expect(compressTable(raw)).toBe(raw)
})
