#!/usr/bin/env node

import { Command } from 'commander';
import { hostname } from 'os';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import chalk from 'chalk';
import { EncorrNode } from '../node';
import { getFFmpegVersion, getFFprobeVersion } from '../ffmpeg';
import { loadConfig, saveConfig, createConfig, type NodeConfigFile } from '../config';

// ============================================================================
// CLI Program
// ============================================================================

const program = new Command();

program
  .name('encorr-node')
  .description('Encorr transcoding node - CLI application for video transcoding')
  .version('0.1.0');

// ============================================================================
// Start Command
// ============================================================================

program
  .command('start')
  .description('Start the transcoding node')
  .option('-s, --server <address>', 'Server address (default: localhost)')
  .option('-p, --port <port>', 'Server port (default: 8101)')
  .option('-n, --name <name>', 'Node name')
  .option('-c, --cache <path>', 'Cache directory path')
  .option('-t, --temp <path>', 'Temp directory path')
  .option('-f, --ffmpeg <path>', 'Path to FFmpeg directory (containing ffmpeg.exe and ffprobe.exe)')
  .action(async (options) => {
    try {
      // Load config from file
      let config = loadConfig();

      // Override with CLI options if provided
      if (options.server) config.serverAddress = options.server;
      if (options.port) config.serverPort = parseInt(options.port, 10);
      if (options.name) config.name = options.name;
      if (options.cache) config.cache_dir = options.cache;
      if (options.temp) config.temp_dir = options.temp;
      if (options.ffmpeg) config.ffmpeg_dir = options.ffmpeg;

      // Validate FFmpeg directory
      const ffmpegDir = config.ffmpeg_dir;
      const ffmpegExe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
      const ffprobeExe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      const ffmpegPath = join(ffmpegDir, ffmpegExe);
      const ffprobePath = join(ffmpegDir, ffprobeExe);

      if (!existsSync(ffmpegPath)) {
        console.error(chalk.red(`Error: FFmpeg not found at: ${ffmpegPath}`));
        console.log(chalk.yellow('Download from: https://ffmpeg.org/download.html'));
        console.log(chalk.gray('You can update ffmpeg_dir in node_config.json'));
        process.exit(1);
      }
      if (!existsSync(ffprobePath)) {
        console.error(chalk.red(`Error: FFprobe not found at: ${ffprobePath}`));
        console.log(chalk.yellow('Download from: https://ffmpeg.org/download.html'));
        console.log(chalk.gray('You can update ffmpeg_dir in node_config.json'));
        process.exit(1);
      }

      // Create directories
      for (const dir of [config.cache_dir, config.temp_dir]) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      // Get versions for display
      const ffVersion = getFFmpegVersion(ffmpegPath);
      const ffprobeVersion = getFFprobeVersion(ffprobePath);

      // Create and start node
      console.log(chalk.blue.bold('\n╔══════════════════════════════════════════════════════════╗'));
      console.log(chalk.blue.bold('║  Encorr Transcoding Node                                 ║'));
      console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════╝\n'));

      console.log(`Server:        ${chalk.cyan(config.serverAddress)}:${chalk.cyan(config.serverPort.toString())}`);
      console.log(`Node Name:     ${chalk.cyan(config.name)}`);
      console.log(`Cache:         ${chalk.cyan(config.cache_dir)}`);
      console.log(`Temp:          ${chalk.cyan(config.temp_dir)}`);
      console.log(`FFmpeg:        ${chalk.cyan(ffmpegPath)}${ffVersion ? chalk.gray(` (v${ffVersion})`) : ''}`);
      console.log(`FFprobe:       ${chalk.cyan(ffprobePath)}${ffprobeVersion ? chalk.gray(` (v${ffprobeVersion})`) : ''}\n`);

      const node = new EncorrNode();

      await node.start();

      // Handle shutdown
      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\n\nShutting down gracefully...'));
        await node.stop();
        process.exit(0);
      });

    } catch (error) {
      console.error(chalk.red('Failed to start node:'), error);
      process.exit(1);
    }
  });

// ============================================================================
// Config Command
// ============================================================================

program
  .command('config')
  .description('Show or update node configuration')
  .option('-s, --set <key=value>', 'Set a configuration value')
  .action((options) => {
    const config = loadConfig();

    if (options.set) {
      const [key, value] = options.set.split('=');
      if (key in config) {
        (config as any)[key] = value;
        saveConfig(config);
        console.log(chalk.green(`✓ Updated ${key} = ${value}`));
      } else {
        console.error(chalk.red(`✗ Unknown config key: ${key}`));
        console.log(chalk.gray('Available keys: serverUrl, name, cache_dir, temp_dir, ffmpeg_dir'));
        process.exit(1);
      }
    } else {
      console.log(chalk.blue.bold('\n=== Node Configuration ===\n'));
      console.log(JSON.stringify(config, null, 2));
      console.log('');
    }
  });

// ============================================================================
// Status Command
// ============================================================================

program
  .command('status')
  .description('Check node configuration and tool installation')
  .action(async () => {
    const config = loadConfig();

    console.log(chalk.blue.bold('\n=== Encorr Node Status ===\n'));

    // Check FFmpeg
    console.log('Checking FFmpeg/FFprobe...');
    const ffmpegDir = config.ffmpeg_dir;
    const ffmpegExe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const ffprobeExe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const ffmpegPath = join(ffmpegDir, ffmpegExe);
    const ffprobePath = join(ffmpegDir, ffprobeExe);

    if (existsSync(ffmpegPath)) {
      const version = getFFmpegVersion(ffmpegPath);
      console.log(chalk.green(`✓ ffmpeg found at: ${ffmpegPath}${version ? ` (v${version})` : ''}`));
    } else {
      console.log(chalk.red(`✗ ffmpeg not found at: ${ffmpegPath}`));
      console.log(chalk.yellow('  Download from: https://ffmpeg.org/download.html'));
    }

    if (existsSync(ffprobePath)) {
      const version = getFFprobeVersion(ffprobePath);
      console.log(chalk.green(`✓ ffprobe found at: ${ffprobePath}${version ? ` (v${version})` : ''}`));
    } else {
      console.log(chalk.red(`✗ ffprobe not found at: ${ffprobePath}`));
      console.log(chalk.yellow('  Download from: https://ffmpeg.org/download.html'));
    }

    // System info
    console.log('\nSystem Information:');
    console.log(`  OS:       ${process.platform} ${process.arch}`);
    console.log(`  Node.js:  ${process.version}`);
    console.log(`  Hostname: ${hostname()}`);
    console.log(`  CPUS:     ${require('os').cpus().length}`);

    console.log('');
  });

// ============================================================================
// Test FFmpeg Command
// ============================================================================

program
  .command('test-ffmpeg')
  .description('Test FFmpeg installation')
  .option('-p, --path <path>', 'Path to FFmpeg directory (containing ffmpeg.exe and ffprobe.exe)')
  .action(async (options) => {
    const { spawn } = require('child_process');

    console.log(chalk.blue.bold('\n=== Testing FFmpeg ===\n'));

    let ffmpegDir = options.path;
    if (!ffmpegDir) {
      const config = loadConfig();
      ffmpegDir = config.ffmpeg_dir;
    }

    const ffmpegExe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const ffmpegPath = join(ffmpegDir, ffmpegExe);

    if (!ffmpegPath || !existsSync(ffmpegPath)) {
      console.error(chalk.red('FFmpeg not found'));
      console.log(chalk.yellow('Use --path option or install from: https://ffmpeg.org/download.html'));
      process.exit(1);
    }

    console.log(chalk.cyan(`Testing: ${ffmpegPath}\n`));

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, ['-version'], { shell: true });

      proc.stdout.on('data', (data: Buffer) => {
        // Only show first line (version info)
        const lines = data.toString().split('\n');
        console.log(lines[0]);
      });

      proc.stderr.on('data', (data: Buffer) => {
        console.error(data.toString());
      });

      proc.on('close', (code: number) => {
        if (code === 0) {
          console.log(chalk.green('\n✓ FFmpeg is working correctly'));
          resolve();
        } else {
          console.error(chalk.red(`\n✗ FFmpeg exited with code ${code}`));
          reject(new Error('FFmpeg test failed'));
        }
      });

      proc.on('error', (error: Error) => {
        console.error(chalk.red('✗ Failed to run FFmpeg:'), error.message);
        reject(error);
      });
    });
  });

// ============================================================================
// Parse Arguments
// ============================================================================

program.parseAsync(process.argv).catch(error => {
  console.error(chalk.red('Error:'), error.message);
  process.exit(1);
});
