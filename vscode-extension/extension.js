const childProcess = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');
const { createBuildArguments, findComponentImport, getPageRoute, parseCompilerDiagnostics } = require('./services');

function getWorkspaceFolder(uri) {
  return vscode.workspace.getWorkspaceFolder(uri) || vscode.workspace.workspaceFolders?.[0];
}

function getCompilerPath() {
  return vscode.workspace.getConfiguration('wizz').get('compilerPath', 'wizz');
}

function runBuild(folder, diagnostics) {
  if (!folder || !vscode.workspace.getConfiguration('wizz.diagnostics').get('enabled', true)) return;

  const { command, arguments: argumentsList, cwd } = createBuildArguments('build', folder.uri.fsPath);
  childProcess.execFile(getCompilerPath(), [command, ...argumentsList], { cwd }, (error, stdout, stderr) => {
    const compilerDiagnostics = parseCompilerDiagnostics(`${stdout}\n${stderr}`);
    if (compilerDiagnostics.length === 0) {
      if (!error) diagnostics.clear();
      return;
    }

    const byFile = new Map();
    for (const diagnostic of compilerDiagnostics) {
      const fileUri = vscode.Uri.file(path.resolve(cwd, diagnostic.filePath));
      const position = new vscode.Position(diagnostic.line - 1, diagnostic.column - 1);
      const entry = new vscode.Diagnostic(
        new vscode.Range(position, position),
        diagnostic.message,
        vscode.DiagnosticSeverity.Error
      );
      const entries = byFile.get(fileUri.fsPath) || { fileUri, entries: [] };
      entries.entries.push(entry);
      byFile.set(fileUri.fsPath, entries);
    }
    for (const { fileUri, entries } of byFile.values()) diagnostics.set(fileUri, entries);
  });
}

function startTerminalCommand(command, folder) {
  const terminal = vscode.window.createTerminal({ name: 'Wizz', cwd: folder.uri.fsPath });
  terminal.show();
  terminal.sendText(`${getCompilerPath()} ${command}`);
}

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('wizz');
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.wizz');

  context.subscriptions.push(diagnostics, watcher);
  context.subscriptions.push(watcher.onDidChange((uri) => runBuild(getWorkspaceFolder(uri), diagnostics)));
  context.subscriptions.push(watcher.onDidCreate((uri) => runBuild(getWorkspaceFolder(uri), diagnostics)));
  context.subscriptions.push(watcher.onDidDelete((uri) => {
    diagnostics.delete(uri);
    runBuild(getWorkspaceFolder(uri), diagnostics);
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.languageId === 'wizz') runBuild(getWorkspaceFolder(document.uri), diagnostics);
  }));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('wizz', {
    provideDefinition(document, position) {
      const target = findComponentImport(document.lineAt(position.line).text, document.uri.fsPath);
      return target ? new vscode.Location(vscode.Uri.file(target), new vscode.Position(0, 0)) : undefined;
    }
  }));

  for (const command of ['build', 'dev']) {
    context.subscriptions.push(vscode.commands.registerCommand(`wizz.${command}`, () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage('Open a Wizz project folder before running this command.');
        return;
      }
      startTerminalCommand(command, folder);
    }));
  }

  context.subscriptions.push(vscode.commands.registerCommand('wizz.openPage', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Open a Wizz project folder before opening a page.');
      return;
    }

    const pageUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, 'src/pages/**/*.wizz'));
    const appUri = vscode.Uri.joinPath(folder.uri, 'src', 'App.wizz');
    try {
      await vscode.workspace.fs.stat(appUri);
      pageUris.unshift(appUri);
    } catch {}

    const selected = await vscode.window.showQuickPick(pageUris.map((uri) => ({
      label: getPageRoute(folder.uri.fsPath, uri.fsPath),
      description: vscode.workspace.asRelativePath(uri),
      uri
    })), { placeHolder: 'Open a Wizz page by route' });
    if (selected) await vscode.window.showTextDocument(selected.uri);
  }));

  for (const folder of vscode.workspace.workspaceFolders || []) runBuild(folder, diagnostics);
}

function deactivate() {}

module.exports = { activate, deactivate };