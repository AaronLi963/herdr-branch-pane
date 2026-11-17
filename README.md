# herdr-branch-pane

A Claude Code mod that adds `/branch-pane`: fork the current Claude session into a new [Herdr](https://herdr.dev) pane, so the original conversation and the branch run side by side.

```
First /branch-pane                 Second /branch-pane
┌──────────┬──────────┐            ┌──────────┬──────────┐
│          │          │            │          │ branch 1 │
│ original │ branch 1 │    ──►     │ original ├──────────┤
│ session  │          │            │ session  │ branch 2 │
└──────────┴──────────┘            └──────────┴──────────┘
```

- Nothing to the right of the current pane → split **right**.
- A column already on the right → split **down** from the bottom pane of that column.
- The new pane runs `claude --resume <current session id> --fork-session`, so it starts from the conversation as it is now, under a new session id. The original pane is untouched.

The built-in `/branch` is left as it is.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install herdr-branch-pane --marketplace AaronLi963/herdr-branch-pane
```

Or from a shell:

```
claude plugin install herdr-branch-pane --marketplace AaronLi963/herdr-branch-pane
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Usage

Inside Claude Code running in a Herdr pane:

```
/branch-pane
```

## How it works

```
/branch-pane
  │
  ├─ HERDR_PANE_ID set (herdr TUI)
  │     herdr pane layout --pane <self>          ← pane rects → is there a column to the right?
  │     herdr pane split <self | bottom of right column> --direction right|down --focus --cwd <cwd>
  │     herdr pane run <new pane> "claude --resume <id> --fork-session"
  │
  └─ HC_TERMINAL_ID set (Herdr desktop app, macOS)
        read herdr-core docs.json (next to HC_TERMINAL_SOCKET) → layout tree
        osascript / System Events sends Herdr's own shortcuts:
          Cmd+D (split right)  or  Cmd+Option+→, Cmd+Option+↓ × n, Cmd+Shift+D (split down)
        paste the command via the clipboard, press Return, restore the clipboard
```

## Requirements

| Environment | Requirements |
|---|---|
| herdr TUI | `herdr` on `PATH` (Linux / macOS; Windows is untested) |
| Herdr desktop app | macOS only. Default keybindings: `Cmd+D` split right, `Cmd+Shift+D` split down, `Cmd+Option+Arrow` move focus. Grant **Herdr** Accessibility access (System Settings → Privacy & Security → Accessibility) the first time; until then osascript fails with `not allowed to send keystrokes (1002)` |

## Limitations

- The desktop-app path depends on Herdr's undocumented `docs.json` layout file and its default shortcuts; a Herdr update may break it.
- The desktop-app path checks that Herdr is the frontmost app before each keystroke and stops otherwise, so switching windows during the ~1 s it runs aborts it.
- The desktop-app path pastes the command through the clipboard and restores it afterwards; unusual clipboard formats may not restore exactly.
- Only the column immediately to the right is considered when there are several.
- Focus moves to the new pane.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # run a session with this folder loaded
```

`hooks/register.ts` is the whole mod; `hooks/register.test.ts` covers the layout logic and the herdr TUI flow.
