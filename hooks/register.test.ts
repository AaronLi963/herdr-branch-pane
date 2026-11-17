import { expect, test } from 'claude-code/testing'

import { planSplit, planTuiSplit } from './register'

const pane = (pane_id: string, x: number, y: number, width: number, height: number) => ({
  pane_id,
  rect: { x, y, width, height },
})

test('TUI: alone in the tab splits right', async () => {
  expect(planTuiSplit({ panes: [pane('w1:p1', 0, 0, 149, 48)] }, 'w1:p1')).toEqual({ target: 'w1:p1', direction: 'right' })
})

test('TUI: a column on the right splits down its bottom pane', async () => {
  const layout = { panes: [pane('w1:p1', 0, 0, 74, 48), pane('w1:p2', 75, 0, 74, 24), pane('w1:p3', 75, 24, 74, 24)] }
  expect(planTuiSplit(layout, 'w1:p1')).toEqual({ target: 'w1:p3', direction: 'down' })
})

test('TUI: rightmost pane splits right; unknown pane has no plan', async () => {
  const layout = { panes: [pane('w1:p1', 0, 0, 74, 48), pane('w1:p2', 75, 0, 74, 48)] }
  expect(planTuiSplit(layout, 'w1:p2')).toEqual({ target: 'w1:p2', direction: 'right' })
  expect(planTuiSplit(layout, 'w1:p9')).toBe(undefined)
})

test('TUI flow: layout, split, then run the fork in the new pane', async ($, on) => {
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const envValues: Record<string, string> = { HERDR_PANE_ID: 'w1:p1', PATH: '/usr/bin', PWD: '/repo' }
  const calls: string[][] = []
  on('command.register', () => ({ value: { command: 'branch-pane' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('env.get', (_, e: any) => ({ value: envValues[e.name] }))
  on('process.run', (_, e: any) => {
    calls.push([...e.argv])
    const reply =
      e.argv[2] === 'layout'
        ? { result: { layout: { panes: [pane('w1:p1', 0, 0, 74, 48), pane('w1:p2', 75, 0, 74, 48)] } } }
        : e.argv[2] === 'split'
          ? { result: { pane: { pane_id: 'w1:p7' } } }
          : { result: {} }
    return { value: { exitCode: 0, stdout: JSON.stringify(reply), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({
    command: 'branch-pane',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 149 },
  })

  expect(calls).toEqual([
    ['herdr', 'pane', 'layout', '--pane', 'w1:p1'],
    ['herdr', 'pane', 'split', 'w1:p2', '--direction', 'down', '--focus', '--cwd', '/repo'],
    ['herdr', 'pane', 'run', 'w1:p7', `claude --resume ${sessionId} --fork-session`],
  ])
  expect(out.text?.includes('opened w1:p7')).toBe(true)
})

const block = (terminal: string) => ({ type: 'block', id: `p-${terminal}`, content: { terminal } })
const docsWith = (root: unknown) => ({ 'herdr-app': { value: { spaces: [{ tabs: [{ root }] }] } } })
// The layout from the screenshot: t8 | [t9 / t10]
const withRightColumn = { type: 'row', children: [block('t8'), { type: 'column', children: [block('t9'), block('t10')] }] }

test('desktop: alone in the tab splits its own pane right', async () => {
  expect(planSplit(docsWith({ type: 'row', children: [block('t3')] }), 't3')).toEqual({ target: 'p-t3', direction: 'right' })
})

test('desktop: a column on the right splits down its bottom pane', async () => {
  expect(planSplit(docsWith(withRightColumn), 't8')).toEqual({ target: 'p-t10', direction: 'down' })
})

test('desktop: a single pane on the right is split down; addresses like t1c work', async () => {
  const root = { type: 'row', children: [block('t1c'), block('t1d')] }
  expect(planSplit(docsWith(root), 't1c')).toEqual({ target: 'p-t1d', direction: 'down' })
})

test('desktop: already the rightmost pane splits right', async () => {
  expect(planSplit(docsWith(withRightColumn), 't10')).toEqual({ target: 'p-t10', direction: 'right' })
})

test('desktop: unknown terminal or malformed docs has no plan', async () => {
  expect(planSplit(docsWith({ type: 'row', children: [block('t1')] }), 't9')).toBe(undefined)
  expect(planSplit({}, 't1')).toBe(undefined)
})

test('desktop flow: read the layout, split through the login shell, focus the new pane', async ($, on) => {
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const envValues: Record<string, string> = {
    HC_TERMINAL_ID: 't8',
    HC_TERMINAL_SOCKET: '/state/herdr-core/default/default.sock',
    SHELL: '/bin/zsh',
    PATH: '/usr/bin',
    HOME: '/home/me',
  }
  const reads: string[] = []
  const calls: string[][] = []
  on('command.register', () => ({ value: { command: 'branch-pane' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('env.get', (_, e: any) => ({ value: envValues[e.name] }))
  on('fs.read', (_, e: any) => {
    reads.push(e.path)
    return { value: JSON.stringify(docsWith(withRightColumn)) }
  })
  on('process.run', (_, e: any) => {
    calls.push([...e.argv])
    const reply = e.argv[2] === 'pane.split' ? { pane: 'p-new', terminal: 't1k' } : { ok: true }
    return { value: { exitCode: 0, stdout: JSON.stringify(reply), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({
    command: 'branch-pane',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 149 },
  })

  expect(reads).toEqual(['/state/herdr-core/default/docs.json'])
  expect(calls.map(call => call.slice(0, 3))).toEqual([
    ['herdr-app', 'do', 'pane.split'],
    ['herdr-app', 'do', 'pane.focus'],
  ])
  expect(JSON.parse(calls[0]![3]!)).toEqual({
    direction: 'down',
    pane: 'p-t10',
    argv: ['/bin/zsh', '-lic', `claude --resume ${sessionId} --fork-session; exec "$SHELL" -l`],
  })
  expect(JSON.parse(calls[1]![3]!)).toEqual({ pane: 'p-new' })
  expect(out.text?.includes('opened t1k')).toBe(true)
})
