#!/usr/bin/env node
const path = require('node:path');
const { main: buildProject } = require('../build');
const { startDevelopmentServer } = require('./dev');
const { initProject } = require('./init');
const { VERSIONS } = require('../src/compiler');

const USAGE = `Usage:
  wizz init [directory] [--force]   Scaffold a starter project
  wizz build [input-directory] [output-directory] [--json]
  wizz dev                          Start the development server
  wizz --version                    Print the compiler and contract versions`;

function parseCommand(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('CLI arguments must be an array.');
  }

  const [command, ...argumentsList] = argv;

  if (command === '--version' || command === 'version') {
    if (argumentsList.length !== 0) {
      throw new Error('Version does not accept arguments.\n\n' + USAGE);
    }
    return { command: 'version', argumentsList: [], json: false, force: false };
  }

  if (command !== 'build' && command !== 'dev' && command !== 'init') {
    throw new Error(USAGE);
  }

  // `--json` is a build flag, not a directory: it may appear in any position
  // and is stripped before the positional count check. The build layer
  // re-parses it from argv, so it is re-appended here rather than threaded
  // as an option.
  const json = argumentsList.includes('--json');
  const positional = argumentsList.filter((argument) => argument !== '--json');

  if (command === 'build' && positional.length !== 0 && positional.length !== 2) {
    throw new Error('Build accepts either no directories or both <input-directory> and <output-directory>.\n\n' + USAGE);
  }

  if (command === 'dev' && argumentsList.length !== 0) {
    throw new Error('Dev does not accept arguments.\n\n' + USAGE);
  }

  if (command === 'init') {
    // `--force` relaxes only the non-empty-directory check; existing files
    // still refuse the scaffold, with or without it.
    const force = positional.includes('--force');
    const targets = positional.filter((argument) => argument !== '--force');
    if (targets.length > 1) {
      throw new Error('Init accepts at most one [directory].\n\n' + USAGE);
    }
    return { command: 'init', argumentsList: targets, json: false, force };
  }

  return { command, argumentsList: positional, json };
}

function runCli(argv, dependencies = {}) {
  const { command, argumentsList, json, force } = parseCommand(argv);
  const build = dependencies.build || buildProject;
  const startDev = dependencies.startDev || startDevelopmentServer;
  const init = dependencies.init || initProject;
  const logger = dependencies.logger || console;

  if (command === 'version') {
    logger.log(`wizz ${VERSIONS.compiler} (compiler ${VERSIONS.compiler}, syntax ${VERSIONS.syntax}, output ${VERSIONS.output})`);
    return 0;
  }

  if (command === 'build') {
    const directories = argumentsList.length === 0 ? ['src', 'dist'] : argumentsList;
    return build(json ? [...directories, '--json'] : directories, logger);
  }

  if (command === 'init') {
    const target = argumentsList.length === 0 ? '.' : argumentsList[0];
    const created = init(target, { force });
    // Print exactly what was created, relative to the invocation point, as
    // posix-style paths so the list reads the same everywhere.
    for (const templatePath of created) {
      logger.log(`Created ${path.join(target, templatePath).split(path.sep).join('/')}`);
    }
    logger.log('Next: run `wizz dev` to start editing.');
    return 0;
  }

  const developmentServer = startDev({ projectDirectory: process.cwd(), logger });
  void developmentServer.listen();
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { USAGE, parseCommand, runCli };