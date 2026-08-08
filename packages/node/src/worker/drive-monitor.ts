import { spawn } from 'child_process';
import { basename } from 'path';
import { readFile, realpath } from 'fs/promises';
import type { DriveInfo } from '@encorr/shared';

export interface DriveUsageData {
  read_bytes_per_sec: number;
  write_bytes_per_sec: number;
}

interface LinuxIoSample {
  readUnits: number;
  writtenUnits: number;
  sampledAt: number;
}

function normalizeFilesystemSource(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}

export class DriveMonitor {
  private linuxSamples = new Map<string, LinuxIoSample>();
  private linuxCifsSamples = new Map<string, LinuxIoSample>();
  private windowsCache = new Map<string, DriveUsageData>();
  private windowsCacheAt = 0;
  private windowsQuery: Promise<Map<string, DriveUsageData>> | null = null;

  async getDriveUsage(drives: DriveInfo[]): Promise<Map<number, DriveUsageData>> {
    if (process.platform === 'linux') return this.getLinuxDriveUsage(drives);
    if (process.platform === 'win32') return this.getWindowsDriveUsage(drives);
    return new Map();
  }

  private async getLinuxDriveUsage(drives: DriveInfo[]): Promise<Map<number, DriveUsageData>> {
    const output = new Map<number, DriveUsageData>();
    const [contents, cifsContents] = await Promise.all([
      readFile('/proc/diskstats', 'utf8'),
      readFile('/proc/fs/cifs/Stats', 'utf8').catch(() => ''),
    ]);
    const counters = new Map<string, { readSectors: number; writtenSectors: number }>();
    const cifsCounters = new Map<string, { readBytes: number; writtenBytes: number }>();

    for (const rawLine of contents.split('\n')) {
      const fields = rawLine.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const readSectors = Number(fields[5]);
      const writtenSectors = Number(fields[9]);
      if (!Number.isFinite(readSectors) || !Number.isFinite(writtenSectors)) continue;
      counters.set(fields[2], { readSectors, writtenSectors });
    }

    let currentShare = '';
    for (const rawLine of cifsContents.split('\n')) {
      const shareMatch = rawLine.trim().match(/^\d+\)\s+(.+)$/);
      if (shareMatch) {
        currentShare = normalizeFilesystemSource(shareMatch[1]);
        continue;
      }
      const bytesMatch = rawLine.match(/Bytes read:\s*(\d+)\s+Bytes written:\s*(\d+)/i);
      if (!currentShare || !bytesMatch) continue;
      const previous = cifsCounters.get(currentShare) || { readBytes: 0, writtenBytes: 0 };
      cifsCounters.set(currentShare, {
        readBytes: previous.readBytes + Number(bytesMatch[1]),
        writtenBytes: previous.writtenBytes + Number(bytesMatch[2]),
      });
    }

    const sampledAt = Date.now();
    await Promise.all(drives.map(async (drive, index) => {
      if (String(drive.type || '').toLowerCase() === 'cifs') {
        const share = normalizeFilesystemSource(drive.filesystem);
        const current = cifsCounters.get(share);
        if (!current) return;
        const previous = this.linuxCifsSamples.get(share);
        this.linuxCifsSamples.set(share, {
          readUnits: current.readBytes,
          writtenUnits: current.writtenBytes,
          sampledAt,
        });
        if (!previous || sampledAt <= previous.sampledAt) return;
        const elapsedSeconds = (sampledAt - previous.sampledAt) / 1000;
        output.set(index, {
          read_bytes_per_sec: Math.max(0, current.readBytes - previous.readUnits) / elapsedSeconds,
          write_bytes_per_sec: Math.max(0, current.writtenBytes - previous.writtenUnits) / elapsedSeconds,
        });
        return;
      }

      if (!drive.filesystem.startsWith('/dev/')) return;
      let devicePath = drive.filesystem;
      try {
        devicePath = await realpath(devicePath);
      } catch {
        // Direct block-device paths do not need symlink resolution.
      }
      const deviceName = basename(devicePath);
      const current = counters.get(deviceName);
      if (!current) return;

      const previous = this.linuxSamples.get(deviceName);
      this.linuxSamples.set(deviceName, {
        readUnits: current.readSectors,
        writtenUnits: current.writtenSectors,
        sampledAt,
      });
      if (!previous || sampledAt <= previous.sampledAt) return;

      const elapsedSeconds = (sampledAt - previous.sampledAt) / 1000;
      // Linux diskstats always expresses sector counters in 512-byte sectors.
      output.set(index, {
        read_bytes_per_sec: Math.max(0, current.readSectors - previous.readUnits) * 512 / elapsedSeconds,
        write_bytes_per_sec: Math.max(0, current.writtenSectors - previous.writtenUnits) * 512 / elapsedSeconds,
      });
    }));

    return output;
  }

  private async getWindowsDriveUsage(drives: DriveInfo[]): Promise<Map<number, DriveUsageData>> {
    const usageByVolume = await this.getWindowsLogicalDiskUsage();
    const output = new Map<number, DriveUsageData>();
    drives.forEach((drive, index) => {
      const mount = drive.mount.replace(/[\\/]+$/, '').toLowerCase();
      const usage = usageByVolume.get(mount);
      if (usage) output.set(index, usage);
    });
    return output;
  }

  private async getWindowsLogicalDiskUsage(): Promise<Map<string, DriveUsageData>> {
    if (Date.now() - this.windowsCacheAt < 900) return this.windowsCache;
    if (this.windowsQuery) return this.windowsQuery;

    this.windowsQuery = new Promise((resolve, reject) => {
      const script = [
        '$ErrorActionPreference = "Stop";',
        '$result = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object { $_.Name -ne "_Total" } | Select-Object Name, DiskReadBytesPersec, DiskWriteBytesPersec;',
        '$result | ConvertTo-Json -Compress',
      ].join('\n');
      const powershell = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => finish(() => {
        powershell.kill();
        reject(new Error('Timed out reading Windows logical disk counters'));
      }), 5000);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      powershell.stdout.on('data', data => { stdout += data.toString(); });
      powershell.stderr.on('data', data => { stderr += data.toString(); });
      powershell.on('error', error => finish(() => reject(error)));
      powershell.on('close', code => finish(() => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
          return;
        }
        try {
          const parsed = stdout.trim() ? JSON.parse(stdout) : [];
          const entries = Array.isArray(parsed) ? parsed : [parsed];
          const result = new Map<string, DriveUsageData>();
          for (const entry of entries) {
            const name = String(entry.Name || '').replace(/[\\/]+$/, '').toLowerCase();
            const read = Number(entry.DiskReadBytesPersec);
            const write = Number(entry.DiskWriteBytesPersec);
            if (!name || !Number.isFinite(read) || !Number.isFinite(write)) continue;
            result.set(name, {
              read_bytes_per_sec: Math.max(0, read),
              write_bytes_per_sec: Math.max(0, write),
            });
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }));
    });

    try {
      this.windowsCache = await this.windowsQuery;
      this.windowsCacheAt = Date.now();
      return this.windowsCache;
    } finally {
      this.windowsQuery = null;
    }
  }
}
