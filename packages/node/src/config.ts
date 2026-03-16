import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { NodeConfig } from '@encorr/shared';

const CONFIG_FILE = 'node_config.json';

export type NodeConfigFile = NodeConfig & {
  getServerUrl(): string;
};

const DEFAULT_CONFIG: NodeConfigFile = {
  serverAddress: 'localhost',
  serverPort: 8101,
  name: `Node-${require('os').hostname()}`,
  cache_dir: join(process.cwd(), 'cache'),
  temp_dir: join(process.cwd(), 'temp'),
  handbrakecli_path: getDefaultHandBrakeCLIPath(),
  ffmpeg_dir: getDefaultFFmpegDir(),
  reconnectInterval: 5000,
  heartbeatInterval: 30000,
  getServerUrl() {
    return `ws://localhost:8101/ws`;
  },
};

function getDefaultHandBrakeCLIPath(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: Check common HandBrakeCLI install locations
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    const possiblePaths = [
      join(programFiles, 'HandBrake', 'HandBrakeCLI.exe'),
      join(programFilesX86, 'HandBrake', 'HandBrakeCLI.exe'),
      'C:\\Program Files\\HandBrake\\HandBrakeCLI.exe',
      'C:\\Program Files (x86)\\HandBrake\\HandBrakeCLI.exe',
      'C:\\HandBrake\\HandBrakeCLI.exe',
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return path;
      }
    }
    // Return default if not found
    return join(programFiles, 'HandBrake', 'HandBrakeCLI.exe');
  } else if (platform === 'darwin') {
    // macOS: HandBrakeCLI is in the app bundle
    const path = '/Applications/HandBrake.app/Contents/MacOS/HandBrakeCLI';
    if (existsSync(path)) {
      return path;
    }
    return path;
  } else {
    // Linux: Standard locations
    const possiblePaths = [
      '/usr/local/bin/HandBrakeCLI',
      '/usr/bin/HandBrakeCLI',
      '/opt/homebrew/bin/HandBrakeCLI',
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return path;
      }
    }
    return '/usr/bin/HandBrakeCLI';
  }
}

function getDefaultFFmpegDir(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: Check common install locations
    const possibleDirs = [
      'C:\\ffmpeg',
      'C:\\Program Files\\ffmpeg',
      'C:\\Program Files (x86)\\ffmpeg',
      join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg'),
    ];

    for (const dir of possibleDirs) {
      // Check if ffmpeg.exe exists in the bin subdirectory
      const binDir = join(dir, 'bin');
      const ffmpegPath = join(binDir, 'ffmpeg.exe');
      if (existsSync(ffmpegPath)) {
        return binDir;
      }
      // Also check directly in dir
      if (existsSync(join(dir, 'ffmpeg.exe'))) {
        return dir;
      }
    }
    return 'C:\\ffmpeg\\bin';
  } else if (platform === 'darwin') {
    // macOS: Common locations
    const possibleDirs = ['/usr/local/bin', '/opt/homebrew/bin'];
    for (const dir of possibleDirs) {
      if (existsSync(join(dir, 'ffmpeg'))) {
        return dir;
      }
    }
    return '/usr/local/bin';
  } else {
    // Linux: Standard location
    if (existsSync('/usr/bin/ffmpeg')) {
      return '/usr/bin';
    }
    return '/usr/bin';
  }
}

export function createConfig(config?: Partial<NodeConfigFile>): NodeConfigFile {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    getServerUrl() {
      return `ws://${config?.serverAddress || DEFAULT_CONFIG.serverAddress}:${config?.serverPort || DEFAULT_CONFIG.serverPort}/ws`;
    },
  };
}

// Find the project root directory by looking for node_config.json or package.json
function findProjectRoot(startPath: string): string {
  let currentPath = startPath;
  let maxIterations = 10; // Prevent infinite loops

  while (maxIterations-- > 0) {
    const configPath = join(currentPath, CONFIG_FILE);
    const packageJsonPath = join(currentPath, 'package.json');

    if (existsSync(configPath) || existsSync(packageJsonPath)) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      // Reached root, return cwd
      break;
    }
    currentPath = parentPath;
  }

  return process.cwd();
}

export function loadConfig(): NodeConfigFile {
  // Try to find project root starting from cwd
  const projectRoot = findProjectRoot(process.cwd());
  const configPath = join(projectRoot, CONFIG_FILE);

  if (!existsSync(configPath)) {
    // Create default config file in project root
    const defaultConfig = createConfig();
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    return defaultConfig;
  }

  try {
    const data = readFileSync(configPath, 'utf-8');
    const loaded = JSON.parse(data);

    // Create config with loaded values and getServerUrl method
    const config = {
      ...DEFAULT_CONFIG,
      ...loaded,
      getServerUrl() {
        return `ws://${loaded.serverAddress || DEFAULT_CONFIG.serverAddress}:${loaded.serverPort || DEFAULT_CONFIG.serverPort}/ws`;
      },
    };

    // Validate that required fields exist
    if (!config.serverAddress) config.serverAddress = DEFAULT_CONFIG.serverAddress;
    if (!config.serverPort) config.serverPort = DEFAULT_CONFIG.serverPort;

    return config;
  } catch (error) {
    console.error(`Failed to load ${CONFIG_FILE}, using defaults:`, error);
    return createConfig();
  }
}

export function saveConfig(config: NodeConfigFile): void {
  const projectRoot = findProjectRoot(process.cwd());
  const configPath = join(projectRoot, CONFIG_FILE);

  // Convert to plain object for JSON serialization (exclude the getServerUrl method)
  const plainConfig = {
    serverAddress: config.serverAddress,
    serverPort: config.serverPort,
    name: config.name,
    cache_dir: config.cache_dir,
    temp_dir: config.temp_dir,
    handbrakecli_path: config.handbrakecli_path,
    ffmpeg_dir: config.ffmpeg_dir,
    reconnectInterval: config.reconnectInterval,
    heartbeatInterval: config.heartbeatInterval,
  };

  writeFileSync(configPath, JSON.stringify(plainConfig, null, 2), 'utf-8');
}
