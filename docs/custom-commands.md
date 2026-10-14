# Custom commands

Custom commands start your own programs, Git commands or web addresses from the command palette
(Ctrl+P / ⌘P) and from the context menus of commits, branches, files and submodules. Create them in
Settings → Custom commands, or let a repository bring them in `.forkyard/commands.json`.

## Format

Settings → Custom commands → Export… writes the same format a repository file uses:

```json
{
  "version": 1,
  "commands": [
    {
      "id": "open-ci",
      "title": "Open CI build",
      "kind": "url",
      "run": "https://ci.example.com/builds?branch=${branch}&sha=${sha}",
      "scope": ["commit", "branch"]
    },
    {
      "id": "tag-release",
      "title": "Tag release",
      "kind": "git",
      "run": "tag -a ${input:name} -m ${input:name} ${sha}",
      "confirm": true,
      "inputs": [{ "id": "name", "label": "Tag name", "type": "text" }],
      "scope": ["commit"]
    },
    {
      "id": "test",
      "title": "Run tests",
      "kind": "shell",
      "run": "npm test -- ${input:suite}",
      "inputs": [{ "id": "suite", "label": "Suite", "type": "choice", "options": ["unit", "e2e"] }],
      "scope": ["repo"]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits, `.`, `_`, `-`; unique per source. |
| `title` | What the palette and the menus show. |
| `kind` | `shell` (a program), `git` (Git's arguments, without `git`) or `url` (an `http(s)` address). |
| `run` | One line with placeholders. For `shell` the first word is the program; quotes group like in a terminal. |
| `cwd` | `worktree` (default, the open folder) or `repo` (the main working tree of a linked worktree). Only for `shell`. |
| `confirm` | `true`: show the finished command before it runs. |
| `shell` | `true`: run the line through `sh -c` (Windows: PowerShell). Only for your own commands, never in a repository file. |
| `inputs` | Fields asked for before the run: `text`, `choice` (`options`), `checkbox` (ticked: its single `options` value or `true`; unticked: left out), `file`. |
| `scope` | Where it appears: `repo` (palette), `commit`, `branch`, `file`, `submodule`. Default `["repo"]`. |

## Placeholders

`${repo}` the open folder · `${sha}` the selected commit (otherwise HEAD) · `${branch}` the selected
branch (otherwise the current one) · `${file}` the selected file, relative (in the submodule menu the
submodule's path) · `${remote}` the remote of the branch's upstream (otherwise the only remote) ·
`${input:<id>}` a field of the form.

Every value becomes part of exactly one argument – Forkyard never builds a shell string from it. For
`url` the values are percent-encoded; the host of the address cannot be a placeholder. For `git` a
value from the context or a text field cannot become an option (it must not start with `-`), and a
push can only be forced with `--force-with-lease`. With `"shell": true` the line only refers to
environment variables (`FORKYARD_REPO`, `FORKYARD_SHA`, `FORKYARD_BRANCH`, `FORKYARD_FILE`,
`FORKYARD_REMOTE`, `FORKYARD_INPUT_<ID>`); every program run gets them as well.

## Commands from a repository

A repository can bring `.forkyard/commands.json`. Its commands show up in Settings → Custom commands
and in the menus, but they only run after you approve the file – exactly this version of it (its
SHA-256). After every change Forkyard lists what changed and asks again. Links are not followed and
`"shell": true` is not allowed there.

## Things to know

- A program that runs one of its arguments as code (`sh -c`, `cmd /c`, `powershell -Command`) cannot
  get a placeholder in that argument; Forkyard rejects such a line. Use `"shell": true` for your own
  commands, or put the script in a file and pass values as arguments. Other interpreters
  (`python -c`, `node -e`, …) are not detected – do not put placeholders into code you hand them.
- `git` commands are not part of Undo. Use `"confirm": true` for anything that rewrites history;
  Git's reflog still has the previous state.

## Command line

After installing, `forkyard` is on the PATH (Windows installers, deb, rpm). For the AppImage and the
macOS app use the command palette → “Install command-line command”.

```
forkyard [<folder>] [--commit <sha>]
forkyard --help
forkyard --version
```
