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
  └─ HC_TERMINAL_ID set (Herdr desktop app)
        read herdr-core docs.json (next to HC_TERMINAL_SOCKET) → split tree; a block's id is its pane id
        herdr-app do pane.split {direction, pane: <self | bottom of right column>,
                                 argv: [$SHELL, "-lic", "claude --resume <id> --fork-session; exec \"$SHELL\" -l"]}
        herdr-app do pane.focus {pane: <new pane>}
```

On the desktop app the fork is started through your login shell: a split's `argv` otherwise runs without the shell's environment (no `.zshrc` exports), and its pane closes as soon as the program exits. Going through the shell gives the fork the same environment as a Claude you start by hand, and leaves a shell in the pane when it exits.

## Requirements

| Environment | Requirements |
|---|---|
| herdr TUI | `herdr` on `PATH` (Linux / macOS; Windows is untested) |
| Herdr desktop app | `herdr-app` on `PATH` (the app installs it). Tested on macOS with Herdr 0.1.16; Linux and Windows are untested |

No Accessibility permission, keybinding or clipboard access is needed.

## Limitations

- The desktop-app path reads the split tree from Herdr's undocumented `docs.json`, because `herdr-app ls` does not report it; a Herdr update may break that.
- Only the column immediately to the right is considered when there are several.
- Focus moves to the new pane.
- The fork starts on your default model, not the model the original session was switched to.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # run a session with this folder loaded
```

`hooks/register.ts` is the whole mod; `hooks/register.test.ts` covers the layout logic and the herdr TUI flow.
