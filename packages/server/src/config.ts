import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { expandPath, normalizePath } from '@encorr/shared';

// ============================================================================
// Server Configuration
// ============================================================================

export interface ServerConfig {
  backendPort: number;
  frontendPort: number;
  host: string;
  database: string;
  cacheDirectory: string;
  autoScan: {
    enabled: boolean;
    intervalMinutes: number;
  };
  jobLimits: {
    maxConcurrent: number;
    maxRetries: number;
  };
  fileRetention: {
    deleteOriginal: boolean;
    keepBackup: boolean;
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  backendPort: 8101,
  frontendPort: 8100,
  host: '0.0.0.0',
  database: '~/.encorr/server/encorr.db',
  cacheDirectory: '~/.encorr/cache',
  autoScan: {
    enabled: true,
    intervalMinutes: 60,
  },
  jobLimits: {
    maxConcurrent: 0,
    maxRetries: 2,
  },
  fileRetention: {
    deleteOriginal: false,
    keepBackup: true,
  },
};

// ============================================================================
// Load Configuration
// ============================================================================

export function loadConfig(configPath?: string): ServerConfig {
  const config = { ...DEFAULT_SERVER_CONFIG };

  // Try to load from config.json in the project root
  const rootConfigPath = join(process.cwd(), 'config.json');
  if (existsSync(rootConfigPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(rootConfigPath, 'utf-8'));
      Object.assign(config, fileConfig);
    } catch (error) {
      console.warn(`Failed to load config from ${rootConfigPath}, using defaults`);
    }
  }

  // Ensure paths are expanded
  config.database = expandPath(config.database);
  config.cacheDirectory = expandPath(config.cacheDirectory);

  return config;
}

// ============================================================================
// Ensure Directories Exist
// ============================================================================

export function ensureDirectories(config: ServerConfig): void {
  const dbDir = dirname(config.database);
  const cacheDir = config.cacheDirectory;

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
}
