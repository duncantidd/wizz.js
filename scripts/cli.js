#!/usr/bin/env node
const { main: buildProject } = require('../build');
const { startDevelopmentServer } = require('./dev');

const USAGE = `Usage:
  wizz build [input-directory] [output-directory] [--json]
  wizz dev`;

function parseCommand(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('CLI arguments must be an array.');
  }

  const [command, ...argumentsList] = argv;
  if (command !== 'build' && command !== 'dev') {
    throw new Error(USAGE);
  }

  // `--json` is a flag, not a directory: it may appear in any position and is
  // stripped before the positional count check. The build layer re-parses it
  // from argv, so it is re-appended here rather than threaded as an option.
  const json = argumentsList.includes('--json');
  const positional = argumentsList.filter((argument) => argument !== '--json');

  if (command === 'build' && positional.length !== 0 && positional.length !== 2) {
    throw new Error('Build accepts either no directories or both <input-directory> and <output-directory>.\n\n' + USAGE);
  }

  if (command === 'dev' && argumentsList.length !== 0) {
    throw new Error('Dev does not accept arguments.\n\n' + USAGE);
  }

  return { command, argumentsList: positional, json };
}

function runCli(argv, dependencies = {}) {
  const { command, argumentsList, json } = parseCommand(argv);
  const build = dependencies.build || buildProject;
  const startDev = dependencies.startDev || startDevelopmentServer;
  const logger = dependencies.logger || console;

  if (command === 'build') {
    const directories = argumentsList.length === 0 ? ['src', 'dist'] : argumentsList;
    return build(json ? [...directories, '--json'] : directories, logger);
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