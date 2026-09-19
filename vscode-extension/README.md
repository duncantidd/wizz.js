# Wizz VS Code Extension

First-party editor support for Wizz components. This extension is separate from the Wizz compiler and runtime: it uses the installed, stable `wizz` CLI and never becomes a framework dependency.

## Features

- `.wizz` language recognition, bracket behavior, and syntax highlighting for templates, blocks, interpolations, event directives, and embedded scripts.
- Compiler diagnostics after saving or changing a `.wizz` file, using file-qualified Wizz compiler locations.
- Go to Definition for default `.wizz` imports and `Wizz: Open Page`, which lists application pages by their generated routes.
- `Wizz: Build Project` and `Wizz: Start Development Server` commands.

## Install And Run

Install the Wizz CLI from the framework root before using build or diagnostic integration:

```bash
./scripts/install-cli.sh
```

Open the repository root (`wizz.js/`) as the VS Code workspace. Choose **Run** > **Start Debugging** (or press `F5`). When VS Code asks for a configuration, choose `Run Wizz Extension`. VS Code then opens a separate **Extension Development Host** window with the Wizz project already open and the Wizz extension loaded.

If `Run Wizz Extension` is not offered, run **Developer: Reload Window** from the Command Palette, then start debugging again. The root workspace contains the required `.vscode/launch.json` profile.

Open `src/components/Counter.wizz` in that separate development-host window to see syntax highlighting and use the Wizz commands. The original window remains the extension's source workspace and does not load the extension being developed. The status bar language mode should read `Wizz`; if it does not, use `Change Language Mode` and choose `Wizz` to check for a user-level file association overriding `.wizz`. The extension uses the `wizz` executable on `PATH` by default; set `wizz.compilerPath` when it is installed elsewhere.

Run its focused tests from this directory:

```bash
npm test
```

## Compatibility

The extension supports the stable CLI commands `wizz build` and `wizz dev`, along with the current component syntax documented by this repository. It does not parse Wizz source independently for diagnostics; the compiler remains the authoritative language contract.