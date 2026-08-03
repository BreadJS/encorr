#!/usr/bin/env node

const { spawnSync } = require('child_process');
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { basename, join, resolve } = require('path');

const projectRoot = resolve(__dirname, '..');
const temporaryDirectories = [];
const requestedPlatform = process.argv[2];
const platformConfig = {
  win: {
    pkgPlatform: 'win',
    nativePlatform: 'win32',
    outputDirectory: 'windows-x64',
    extension: '.exe',
  },
  linux: {
    pkgPlatform: 'linux',
    nativePlatform: 'linux',
    outputDirectory: 'linux-x64',
    extension: '',
  },
}[requestedPlatform];

if (!platformConfig) {
  console.error('Usage: node scripts/build-binaries.js <win|linux>');
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function binaryPath(name) {
  return join(outputDirectory, `${name}${platformConfig.extension}`);
}

function findNativeBinding(root) {
  const candidates = [
    join(root, 'build', 'Release', 'better_sqlite3.node'),
    join(root, 'build', 'Debug', 'better_sqlite3.node'),
  ];
  const binding = candidates.find(existsSync);
  if (!binding) {
    throw new Error(`better_sqlite3.node was not found under ${root}`);
  }
  return binding;
}

function prepareSqliteBinding() {
  const installedPackageRoot = join(projectRoot, 'node_modules', 'better-sqlite3');
  if (platformConfig.nativePlatform === process.platform && process.arch === 'x64') {
    return findNativeBinding(installedPackageRoot);
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'encorr-better-sqlite3-'));
  temporaryDirectories.push(temporaryRoot);
  const packageJson = JSON.parse(readFileSync(join(installedPackageRoot, 'package.json'), 'utf8'));
  writeFileSync(join(temporaryRoot, 'package.json'), JSON.stringify(packageJson, null, 2));

  const installer = require.resolve('prebuild-install/bin.js');
  run(process.execPath, [
    installer,
    '--platform', platformConfig.nativePlatform,
    '--arch', 'x64',
    '--runtime', 'node',
    '--target', process.versions.node,
    '--force',
    '--verbose',
  ], { cwd: temporaryRoot });

  return findNativeBinding(temporaryRoot);
}

const outputDirectory = join(projectRoot, 'release', platformConfig.outputDirectory);
const pkgExecutable = require.resolve('@yao-pkg/pkg/lib-es5/bin.js');

try {
  console.log(`Building Encorr node and server for ${platformConfig.outputDirectory}...`);

  run(npmCommand(), ['run', 'build:node']);
  run(npmCommand(), ['run', 'build:server']);

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  const sqliteBinding = prepareSqliteBinding();
  copyFileSync(sqliteBinding, join(outputDirectory, 'better_sqlite3.node'));

  const target = `node20-${platformConfig.pkgPlatform}-x64`;
  const commonPkgArgs = [
    pkgExecutable,
    '--targets', target,
    '--config', join(projectRoot, 'package.json'),
    '--compress', 'GZip',
    '--no-native-build',
  ];

  run(process.execPath, [
    ...commonPkgArgs,
    '--output', binaryPath('encorr-node'),
    join(projectRoot, 'packages', 'node', 'dist', 'cli', 'index.js'),
  ]);
  run(process.execPath, [
    ...commonPkgArgs,
    '--output', binaryPath('encorr-server'),
    join(projectRoot, 'packages', 'server', 'dist', 'index.js'),
  ]);

  if (requestedPlatform === 'linux') {
    chmodSync(binaryPath('encorr-node'), 0o755);
    chmodSync(binaryPath('encorr-server'), 0o755);
  }

  writeFileSync(join(outputDirectory, 'README.txt'), [
    `Encorr ${platformConfig.outputDirectory} build`,
    '',
    `Server: .${requestedPlatform === 'win' ? '\\encorr-server.exe' : '/encorr-server'}`,
    `Node:   .${requestedPlatform === 'win' ? '\\encorr-node.exe start' : '/encorr-node start'}`,
    '',
    'Keep better_sqlite3.node in the same directory as encorr-server.',
    'FFmpeg and FFprobe must be installed separately on every transcoding node.',
    '',
  ].join('\n'));

  console.log(`\nBuild complete: ${outputDirectory}`);
} catch (error) {
  console.error(`\nBuild failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  for (const temporaryDirectory of temporaryDirectories) {
    if (basename(temporaryDirectory).startsWith('encorr-better-sqlite3-')) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
