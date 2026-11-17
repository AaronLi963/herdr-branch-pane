import type { Register } from 'claude-code'

// Herdr desktop has no public pane API: we read its layout file (herdr-core
// docs.json, next to HC_TERMINAL_SOCKET) and drive it with its own shortcuts.
// shortcut: depends on undocumented docs.json shape and default keybindings; switch to an API if Herdr ships one.

type LayoutNode = {
  type?: string
  children?: LayoutNode[]
  content?: { terminal?: string }
}

export type SplitPlan = { kind: 'right' } | { kind: 'down'; downPresses: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL_ID = /^t\d+$/

function countPanes(node: LayoutNode): number {
  if (node.content?.terminal) return 1
  return (node.children ?? []).reduce((sum, child) => sum + countPanes(child), 0)
}

function pathTo(node: LayoutNode, terminalId: string): LayoutNode[] | undefined {
  if (node.content?.terminal === terminalId) return [node]
  for (const child of node.children ?? []) {
    const path = pathTo(child, terminalId)
    if (path) return [node, ...path]
  }
  return undefined
}

/** Split right when nothing is to our right; else split down at the bottom of the column right of us. */
export function planSplit(docs: unknown, terminalId: string): SplitPlan | undefined {
  const spaces = (docs as any)?.['herdr-app']?.value?.spaces ?? []
  for (const space of spaces) {
    for (const tab of space?.tabs ?? []) {
      const path = tab?.root && pathTo(tab.root, terminalId)
      if (!path) continue
      for (let depth = path.length - 2; depth >= 0; depth--) {
        const parent = path[depth]
        const index = parent.children!.indexOf(path[depth + 1])
        const rightSibling = parent.type === 'row' ? parent.children![index + 1] : undefined
        // Cmd+Option+Down stops at the bottom pane, so one press per pane always reaches it.
        if (rightSibling) return { kind: 'down', downPresses: countPanes(rightSibling) }
      }
      return { kind: 'right' }
    }
  }
  return undefined
}

type Rect = { x: number; y: number; width: number; height: number }
type TuiLayout = { panes?: { pane_id: string; rect: Rect }[] }

/** Herdr TUI: split right when nothing is to our right; else split down the bottom pane of the nearest column to our right. */
export function planTuiSplit(layout: TuiLayout, selfId: string): { target: string; direction: 'right' | 'down' } | undefined {
  const panes = layout.panes ?? []
  const self = panes.find(pane => pane.pane_id === selfId)?.rect
  if (!self) return undefined
  const toRight = panes.filter(
    ({ rect }) => rect.x >= self.x + self.width && rect.y < self.y + self.height && rect.y + rect.height > self.y,
  )
  if (toRight.length === 0) return { target: selfId, direction: 'right' }
  const nearestX = Math.min(...toRight.map(pane => pane.rect.x))
  const bottom = toRight
    .filter(pane => pane.rect.x === nearestX)
    .reduce((low, pane) => (pane.rect.y > low.rect.y ? pane : low))
  return { target: bottom.pane_id, direction: 'down' }
}

export function buildAppleScript(plan: SplitPlan, command: string): string {
  // key codes: 2 = d, 9 = v, 36 = Return, 124 = right arrow, 125 = down arrow
  const split =
    plan.kind === 'right'
      ? 'key code 2 using {command down}'
      : [
          'key code 124 using {command down, option down}',
          'delay 0.15',
          `repeat ${plan.downPresses} times`,
          'key code 125 using {command down, option down}',
          'delay 0.1',
          'end repeat',
          'key code 2 using {command down, shift down}',
        ].join('\n')

  // The command is pasted, not typed: typed keystrokes break under a CJK input method.
  return `on requireHerdr()
tell application "System Events" to set frontId to bundle identifier of first application process whose frontmost is true
if frontId is not "dev.herdr.app" then error "Herdr is not the frontmost app (" & frontId & "), stopped"
end requireHerdr

requireHerdr()
tell application "System Events"
${split}
end tell
delay 0.8
set hadClipboard to true
try
set savedClipboard to the clipboard
on error
set hadClipboard to false
end try
set the clipboard to "${command}"
requireHerdr()
tell application "System Events"
key code 9 using {command down}
delay 0.3
key code 36
end tell
delay 0.3
if hadClipboard then set the clipboard to savedClipboard
`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'branch-pane',
      description: 'Fork this session into a new Herdr pane (right, or down in the right column)',
    })

    return next(e)
  })

  on('command.run', { command: 'branch-pane' }, async $ => {
    try {
      const sessionId = await $.session.id()
      if (!UUID.test(sessionId)) return { text: `branch-pane: unexpected session id "${sessionId}".` }
      const command = `claude --resume ${sessionId} --fork-session`

      // Herdr TUI: it injects HERDR_PANE_ID and has a pane API, so no keystrokes.
      const herdrPaneId = (await $.env.get('HERDR_PANE_ID')) ?? ''
      if (herdrPaneId) {
        // Child env is passed explicitly: $.process.run children did not see this session's env vars.
        const env: Record<string, string> = { PATH: (await $.env.get('PATH')) ?? '/usr/bin:/bin' }
        const socket = await $.env.get('HERDR_SOCKET_PATH')
        if (socket) env.HERDR_SOCKET_PATH = socket
        const herdr = async (...args: string[]) => {
          const ran = await $.process.run(['herdr', ...args], { env })
          if (ran.exitCode !== 0) throw new Error(`herdr ${args.slice(0, 2).join(' ')}: ${ran.stderr.trim() || ran.stdout.trim()}`)
          return JSON.parse(ran.stdout)
        }

        const layout = (await herdr('pane', 'layout', '--pane', herdrPaneId))?.result?.layout
        const plan = planTuiSplit(layout ?? {}, herdrPaneId)
        if (!plan) return { text: `branch-pane: pane ${herdrPaneId} not found in its herdr layout.` }

        const cwd = (await $.env.get('PWD')) ?? ''
        const split = await herdr('pane', 'split', plan.target, '--direction', plan.direction, '--focus', ...(cwd ? ['--cwd', cwd] : []))
        const newPaneId = split?.result?.pane?.pane_id
        if (!newPaneId) return { text: `branch-pane: herdr split returned no pane id.` }
        await herdr('pane', 'run', newPaneId, command)

        return { text: `branch-pane: opened ${newPaneId} (${plan.direction} of ${plan.target}) running \`${command}\`.` }
      }

      const terminalId = (await $.env.get('HC_TERMINAL_ID')) ?? ''
      const socketPath = (await $.env.get('HC_TERMINAL_SOCKET')) ?? ''
      if (!TERMINAL_ID.test(terminalId) || !socketPath) {
        return {
          text: `branch-pane: not running inside Herdr (no HERDR_PANE_ID; HC_TERMINAL_ID="${terminalId}", HC_TERMINAL_SOCKET="${socketPath}").`,
        }
      }

      const docsPath = socketPath.replace(/[^/]+$/, 'docs.json')
      const docsFile = await $.process.run(['/bin/cat', docsPath])
      if (docsFile.exitCode !== 0) return { text: `branch-pane: cannot read ${docsPath}: ${docsFile.stderr.trim()}` }

      const plan = planSplit(JSON.parse(docsFile.stdout), terminalId)
      if (!plan) return { text: `branch-pane: terminal ${terminalId} not found in ${docsPath}.` }

      const script = await $.process.run(['/usr/bin/osascript'], {
        stdin: buildAppleScript(plan, command),
        timeoutMs: 20_000,
      })
      if (script.exitCode !== 0) return { text: `branch-pane: osascript failed: ${script.stderr.trim()}` }

      const where = plan.kind === 'right' ? 'a new pane on the right' : 'a new pane under the right column'
      return { text: `branch-pane: opened ${where} running \`${command}\`.` }
    } catch (error) {
      return { text: `branch-pane: failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
