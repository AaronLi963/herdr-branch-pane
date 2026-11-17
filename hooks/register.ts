import type { Register } from 'claude-code'

// Herdr desktop: panes are split with its CLI (`herdr-app do pane.split`), but the
// CLI does not expose the split tree, so that is read from herdr-core's docs.json
// (next to HC_TERMINAL_SOCKET), where a block's `id` is its pane id.
// shortcut: depends on the undocumented docs.json shape; switch when herdr-app can report the layout.

type LayoutNode = {
  id?: string
  type?: string
  children?: LayoutNode[]
  content?: { terminal?: string }
}

export type SplitPlan = { target: string; direction: 'right' | 'down' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function lastPane(node: LayoutNode): LayoutNode {
  const last = node.children?.at(-1)
  return last ? lastPane(last) : node
}

function pathTo(node: LayoutNode, terminalId: string): LayoutNode[] | undefined {
  if (node.content?.terminal === terminalId) return [node]
  for (const child of node.children ?? []) {
    const path = pathTo(child, terminalId)
    if (path) return [node, ...path]
  }
  return undefined
}

/** Herdr desktop: split our pane right when nothing is to our right; else split down the bottom pane of the column right of us. */
export function planSplit(docs: unknown, terminalId: string): SplitPlan | undefined {
  const spaces = (docs as any)?.['herdr-app']?.value?.spaces ?? []
  for (const space of spaces) {
    for (const tab of space?.tabs ?? []) {
      const path: LayoutNode[] | undefined = tab?.root && pathTo(tab.root, terminalId)
      if (!path) continue
      for (let depth = path.length - 2; depth >= 0; depth--) {
        const parent = path[depth]!
        const siblings = parent.children ?? []
        const rightSibling = parent.type === 'row' ? siblings[siblings.indexOf(path[depth + 1]!) + 1] : undefined
        const target = rightSibling && lastPane(rightSibling).id
        if (target) return { target, direction: 'down' }
      }
      const self = path.at(-1)?.id
      return self ? { target: self, direction: 'right' } : undefined
    }
  }
  return undefined
}

type Rect = { x: number; y: number; width: number; height: number }
type TuiLayout = { panes?: { pane_id: string; rect: Rect }[] }

/** Herdr TUI: split right when nothing is to our right; else split down the bottom pane of the nearest column to our right. */
export function planTuiSplit(layout: TuiLayout, selfId: string): SplitPlan | undefined {
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

      // Herdr desktop app: it injects HC_TERMINAL_ID (a terminal address, not a pane id).
      const terminalId = (await $.env.get('HC_TERMINAL_ID')) ?? ''
      const socketPath = (await $.env.get('HC_TERMINAL_SOCKET')) ?? ''
      if (!terminalId || !socketPath) {
        return {
          text: `branch-pane: not running inside Herdr (no HERDR_PANE_ID; HC_TERMINAL_ID="${terminalId}", HC_TERMINAL_SOCKET="${socketPath}").`,
        }
      }

      const docsPath = socketPath.replace(/[^/\\]+$/, 'docs.json')
      const plan = planSplit(JSON.parse(await $.fs.read(docsPath)), terminalId)
      if (!plan) return { text: `branch-pane: terminal ${terminalId} not found in ${docsPath}.` }

      // A split's argv runs without the login shell's environment (no .zshrc exports) and its
      // pane closes when it exits, so go through the shell and leave one open afterwards.
      const shell = await $.env.get('SHELL')
      const argv = shell
        ? [shell, '-lic', `${command}; exec "$SHELL" -l`]
        : ['claude', '--resume', sessionId, '--fork-session']

      const env: Record<string, string> = {}
      const path = await $.env.get('PATH')
      const home = await $.env.get('HOME')
      if (path) env.PATH = path
      if (home) env.HOME = home
      const herdrApp = async (name: string, args: object) => {
        const ran = await $.process.run(['herdr-app', 'do', name, JSON.stringify(args)], { env })
        if (ran.exitCode !== 0) throw new Error(`herdr-app do ${name}: ${ran.stderr.trim() || ran.stdout.trim()}`)
        return JSON.parse(ran.stdout)
      }

      const split = await herdrApp('pane.split', { direction: plan.direction, pane: plan.target, argv })
      if (!split?.pane) return { text: `branch-pane: herdr-app split returned no pane id.` }
      await herdrApp('pane.focus', { pane: split.pane })

      return { text: `branch-pane: opened ${split.terminal ?? split.pane} (${plan.direction} of ${plan.target}) running \`${command}\`.` }
    } catch (error) {
      return { text: `branch-pane: failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
