import { spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir } from 'fs';
const readFileAsync = promisify(readFile);
const readdirAsync = promisify(readdir);

// ============================================================================
// Types
// ============================================================================

export interface GPUUsageData {
  utilizationGpu?: number;
  utilizationMemory?: number;
  memoryUsed?: number;
  memoryTotal?: number;
  temperatureGpu?: number;
  powerDraw?: number;
  powerLimit?: number;
  fanSpeed?: number;
}

// ============================================================================
// GPU Usage Monitor
// ============================================================================

export class GPUMonitor {
  private intelUsageCache = new Map<number, GPUUsageData>();
  private intelUsageCacheAt = 0;
  private intelUsageQuery: Promise<Map<number, GPUUsageData>> | null = null;

  /**
   * Get GPU usage for all GPUs using vendor-specific methods
   * Much faster than si.graphics()!
   */
  async getGPUUsage(gpus: Array<{ vendor?: string; name?: string; drm_card?: string }>): Promise<Map<number, GPUUsageData>> {
    const results = new Map<number, GPUUsageData>();

    // Separate GPUs by vendor for efficient querying
    const nvidiaGpus: Array<{ index: number; gpu: any }> = [];
    const amdGpus: Array<{ index: number; gpu: any }> = [];
    const intelGpus: Array<{ index: number; gpu: any }> = [];

    for (let i = 0; i < gpus.length; i++) {
      const gpu = gpus[i];
      const vendor = (gpu.vendor || this.getGPUVendor(gpu)).toLowerCase();

      if (vendor.includes('nvidia')) {
        nvidiaGpus.push({ index: i, gpu });
      } else if (/\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(vendor)) {
        amdGpus.push({ index: i, gpu });
      } else if (/\bintel\b|\barc(?:\(tm\))?\b/.test(vendor)) {
        intelGpus.push({ index: i, gpu });
      }
    }

    // Query all NVIDIA GPUs in a single nvidia-smi call
    if (nvidiaGpus.length > 0) {
      try {
        const nvidiaResults = await this.getNvidiaGpuUsage(nvidiaGpus.length);
        for (let i = 0; i < nvidiaGpus.length; i++) {
          const result = nvidiaResults[i];
          if (result) {
            results.set(nvidiaGpus[i].index, result);
          }
        }
      } catch (error: any) {
        // Log error for debugging
        console.error('[GPUMonitor] Failed to get NVIDIA GPU usage:', error?.message || error);
      }
    }

    // Query AMD GPUs individually
    for (const { index, gpu } of amdGpus) {
      try {
        const data = await this.getAmdGpuUsage(index, gpu);
        if (data) results.set(index, data);
      } catch (error: any) {
        console.error('[GPUMonitor] Failed to get AMD GPU usage:', error?.message || error);
      }
    }

    // Windows exposes Intel Arc utilisation through the GPU Engine performance
    // counters, not through systeminformation. The counter's `phys_N` index is
    // normally the graphics-controller index; fall back to the ordered Intel
    // adapters if Windows has assigned physical indexes differently.
    if (intelGpus.length > 0 && process.platform === 'win32') {
      try {
        const usageByPhysicalIndex = await this.getWindowsGpuEngineUsage();
        const physicalIndexes = [...usageByPhysicalIndex.keys()].sort((a, b) => a - b);

        // Filtering virtual/basic display adapters can shift Windows' phys_N
        // indexes away from our compact GPU array. With one real Intel GPU,
        // the busiest physical adapter is unambiguous and avoids reading an
        // idle phantom adapter at phys_0 forever.
        if (intelGpus.length === 1 && gpus.length === 1) {
          const busiest = [...usageByPhysicalIndex.values()].reduce<GPUUsageData | undefined>((best, candidate) =>
            (candidate.utilizationGpu ?? 0) > (best?.utilizationGpu ?? -1) ? candidate : best,
          undefined);
          const intelGpu = intelGpus[0];
          if (busiest && intelGpu) results.set(intelGpu.index, busiest);
          return results;
        }

        intelGpus.forEach(({ index }, intelIndex) => {
          const fallbackPhysicalIndex = physicalIndexes[intelIndex];
          const usage = usageByPhysicalIndex.get(index)
            ?? (fallbackPhysicalIndex !== undefined
              ? usageByPhysicalIndex.get(fallbackPhysicalIndex)
              : undefined);
          if (usage) results.set(index, usage);
        });
      } catch (error: any) {
        console.error('[GPUMonitor] Failed to get Intel GPU usage:', error?.message || error);
      }
    }

    return results;
  }

  /**
   * Get NVIDIA GPU usage using nvidia-smi
   * Works on both Windows and Linux
   * Very fast (~50ms)
   *
   * @param nvidiaGpuCount Number of NVIDIA GPUs to query
   * @returns Array of GPU usage data indexed by NVIDIA GPU number
   */
  private async getNvidiaGpuUsage(nvidiaGpuCount: number): Promise<(GPUUsageData | null)[]> {
    return new Promise((resolve) => {
      // Query NVIDIA GPUs using nvidia-smi
      // Syntax: nvidia-smi -i 0 --query-gpu=utilization.gpu,... --format=csv,noheader,nounits
      // For multiple GPUs, we can either query all at once or each individually
      // For simplicity, query all GPUs (don't specify -i) and parse the output

      const args = [
        '--query-gpu=utilization.gpu,utilization.memory,temperature.gpu,memory.used,memory.total,power.draw,fan.speed',
        '--format=csv,noheader,nounits'
      ];

      const nvidiaSmi = spawn('nvidia-smi', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      nvidiaSmi.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      nvidiaSmi.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      nvidiaSmi.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          try {
            // nvidia-smi returns one line per GPU
            const lines = stdout.trim().split('\n').map(l => l.trim());
            const results: (GPUUsageData | null)[] = [];

            for (const line of lines) {
              const parts = line.split(',').map(p => p.trim());
              const [
                gpuUtil,
                memUtil,
                temp,
                memUsed,
                memTotal,
                power,
                fan
              ] = parts;

              // Convert MB to bytes (multiply by 1024 * 1024)
              const memUsedNum = memUsed !== '[N/A]' ? parseFloat(memUsed) : 0;
              const memTotalNum = memTotal !== '[N/A]' ? parseFloat(memTotal) : 0;

              results.push({
                utilizationGpu: gpuUtil !== '[N/A]' ? parseInt(gpuUtil) : undefined,
                utilizationMemory: memUtil !== '[N/A]' ? parseInt(memUtil) : undefined,
                memoryUsed: memUsedNum > 0 ? Math.round(memUsedNum * 1024 * 1024) : undefined,
                memoryTotal: memTotalNum > 0 ? Math.round(memTotalNum * 1024 * 1024) : undefined,
                temperatureGpu: temp !== '[N/A]' ? parseInt(temp) : undefined,
                powerDraw: power !== '[N/A]' ? parseFloat(power) : undefined,
                fanSpeed: fan !== '[N/A]' ? parseInt(fan) : undefined,
              });
            }

            resolve(results);
          } catch (err) {
            console.error('[GPUMonitor] Failed to parse nvidia-smi output:', err);
            console.error('[GPUMonitor] stdout:', stdout);
            resolve(new Array(nvidiaGpuCount).fill(null));
          }
        } else {
          console.error('[GPUMonitor] nvidia-smi failed with code:', code, 'stderr:', stderr);
          resolve(new Array(nvidiaGpuCount).fill(null));
        }
      });

      nvidiaSmi.on('error', (err) => {
        console.error('[GPUMonitor] nvidia-smi spawn error:', err);
        resolve(new Array(nvidiaGpuCount).fill(null));
      });

      // Timeout after 2 seconds (should be much faster)
      setTimeout(() => {
        nvidiaSmi.kill();
        resolve(new Array(nvidiaGpuCount).fill(null));
      }, 2000);
    });
  }

  /**
   * Get AMD GPU usage using sysfs (Linux only)
   * Very fast reading from kernel-provided files
   */
  private async getAmdGpuUsage(gpuIndex: number, gpu?: { drm_card?: string }): Promise<GPUUsageData | null> {
    if (process.platform !== 'linux') {
      return null;
    }

    try {
      const cardNum = gpu?.drm_card || `card${gpuIndex}`;
      const hwmonRoot = `/sys/class/drm/${cardNum}/device/hwmon`;
      const hwmonEntries = await readdirAsync(hwmonRoot).catch(() => [] as string[]);
      const namedHwmonEntries = await Promise.all(hwmonEntries.map(async entry => ({
        entry,
        name: await readFileAsync(`${hwmonRoot}/${entry}/name`, 'utf8').catch(() => ''),
      })));
      const hwmonEntry = namedHwmonEntries.find(item => item.name.trim().toLowerCase() === 'amdgpu')?.entry
        || hwmonEntries[0];
      const hwmonPath = hwmonEntry ? `${hwmonRoot}/${hwmonEntry}` : null;

      const [
        usageStr,
        vramUsedStr,
        vramTotalStr,
        tempStr,
        powerAverageStr,
        powerInputStr,
        powerCapStr,
      ] = await Promise.all([
        readFileAsync(`/sys/class/drm/${cardNum}/device/gpu_busy_percent`, 'utf8').catch(() => null),
        readFileAsync(`/sys/class/drm/${cardNum}/device/mem_info_vram_used`, 'utf8').catch(() => null),
        readFileAsync(`/sys/class/drm/${cardNum}/device/mem_info_vram_total`, 'utf8').catch(() => null),
        hwmonPath ? readFileAsync(`${hwmonPath}/temp1_input`, 'utf8').catch(() => null) : Promise.resolve(null),
        hwmonPath ? readFileAsync(`${hwmonPath}/power1_average`, 'utf8').catch(() => null) : Promise.resolve(null),
        hwmonPath ? readFileAsync(`${hwmonPath}/power1_input`, 'utf8').catch(() => null) : Promise.resolve(null),
        hwmonPath ? readFileAsync(`${hwmonPath}/power1_cap`, 'utf8').catch(() => null) : Promise.resolve(null),
      ]);

      const data: GPUUsageData = {};

      if (usageStr) {
        data.utilizationGpu = parseInt(usageStr.trim());
      }

      if (vramUsedStr && vramTotalStr) {
        data.memoryUsed = parseInt(vramUsedStr.trim()); // Already in bytes
        data.memoryTotal = parseInt(vramTotalStr.trim());
      }

      if (tempStr) {
        data.temperatureGpu = Math.round(parseInt(tempStr.trim()) / 1000); // millidegrees to C
      }

      // amdgpu hwmon reports power in microwatts. Discrete cards commonly
      // expose power1_average, while APUs and some newer drivers only expose
      // power1_input, so accept either and prefer the averaged reading.
      const powerMicrowatts = Number.parseInt((powerAverageStr || powerInputStr || '').trim(), 10);
      if (Number.isFinite(powerMicrowatts) && powerMicrowatts >= 0) {
        data.powerDraw = powerMicrowatts / 1_000_000;
      }

      const powerLimitMicrowatts = Number.parseInt((powerCapStr || '').trim(), 10);
      if (Number.isFinite(powerLimitMicrowatts) && powerLimitMicrowatts > 0) {
        data.powerLimit = powerLimitMicrowatts / 1_000_000;
      }

      return Object.keys(data).length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  /**
   * Read Windows' built-in GPU Engine performance counters. Intel Arc drivers
   * do not provide an nvidia-smi-style utility, while these counters contain
   * the same engine load used by Task Manager. Task Manager reports the busiest
   * engine, so use the maximum engine value for each physical adapter rather
   * than summing simultaneous 3D, encode, decode, and copy engines.
   */
  private async getWindowsGpuEngineUsage(): Promise<Map<number, GPUUsageData>> {
    const now = Date.now();
    if (now - this.intelUsageCacheAt < 900) {
      return this.intelUsageCache;
    }
    if (this.intelUsageQuery) {
      return this.intelUsageQuery;
    }

    this.intelUsageQuery = this.queryWindowsGpuEngineUsage();
    try {
      const usage = await this.intelUsageQuery;
      this.intelUsageCache = usage;
      this.intelUsageCacheAt = Date.now();
      return usage;
    } finally {
      this.intelUsageQuery = null;
    }
  }

  private async queryWindowsGpuEngineUsage(): Promise<Map<number, GPUUsageData>> {
    return new Promise((resolve, reject) => {
      const script = [
        '$ErrorActionPreference = "Stop";',
        '$result = try {',
        '$samples = (Get-Counter -Counter "\\GPU Engine(*)\\Utilization Percentage" -SampleInterval 1 -MaxSamples 1).CounterSamples;',
        '$samples | ForEach-Object { [pscustomobject]@{ Name = $_.InstanceName; UtilizationPercentage = $_.CookedValue } }',
        '} catch {',
        'Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine',
        '| Select-Object Name, UtilizationPercentage',
        '};',
        '$result | ConvertTo-Json -Compress',
      ].join('\n');
      const powershell = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };

      powershell.stdout.on('data', data => { stdout += data.toString(); });
      powershell.stderr.on('data', data => { stderr += data.toString(); });
      powershell.on('error', error => finish(() => reject(error)));
      powershell.on('close', code => finish(() => {
        if (code !== 0 || !stdout.trim()) {
          reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
          return;
        }

        try {
          const entries = JSON.parse(stdout) as Array<{ Name?: string; UtilizationPercentage?: number }> | { Name?: string; UtilizationPercentage?: number };
          const engineTotals = new Map<string, { physicalIndex: number; utilization: number }>();
          for (const entry of (Array.isArray(entries) ? entries : [entries])) {
            const match = entry.Name?.match(/(?:^|_)phys_(\d+)(?:_|$)/i);
            const utilization = Number(entry.UtilizationPercentage);
            if (!match || !Number.isFinite(utilization)) continue;

            const physicalIndex = Number(match[1]);
            const engineMatch = entry.Name?.match(/_eng_(\d+)_engtype_([^_]+)/i);
            const engineKey = `${physicalIndex}:${engineMatch?.[1] || entry.Name}:${engineMatch?.[2] || 'unknown'}`;
            const previous = engineTotals.get(engineKey)?.utilization ?? 0;
            engineTotals.set(engineKey, {
              physicalIndex,
              // The counter has one instance per process. Add processes that
              // use the same hardware engine, then select the busiest engine
              // below, matching Task Manager's overall GPU presentation.
              utilization: previous + Math.max(0, utilization),
            });
          }

          const usageByPhysicalIndex = new Map<number, GPUUsageData>();
          for (const engine of engineTotals.values()) {
            const previous = usageByPhysicalIndex.get(engine.physicalIndex)?.utilizationGpu ?? 0;
            usageByPhysicalIndex.set(engine.physicalIndex, {
              utilizationGpu: Math.max(previous, Math.min(100, Math.round(engine.utilization))),
            });
          }
          resolve(usageByPhysicalIndex);
        } catch (error) {
          reject(error);
        }
      }));

      setTimeout(() => finish(() => {
        powershell.kill();
        reject(new Error('Timed out reading Windows GPU Engine counters'));
      }), 5000);
    });
  }

  private getGPUVendor(gpu: any): string {
    const name = (gpu.name || gpu.model || '').toLowerCase();
    if (name.includes('nvidia') || name.includes('geforce') || name.includes('quadro') || name.includes('tesla')) {
      return 'nvidia';
    }
    if (/\bamd\b|advanced micro devices|\bradeon\b|\bati\b/.test(name)) {
      return 'amd';
    }
    if (/\bintel\b|\barc(?:\(tm\))?\b/.test(name)) {
      return 'intel';
    }
    return 'unknown';
  }

  /**
   * Check if nvidia-smi is available
   */
  static async isNvidiaAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const nvidiaSmi = spawn('nvidia-smi', ['--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      nvidiaSmi.on('close', (code) => {
        resolve(code === 0);
      });

      nvidiaSmi.on('error', () => {
        resolve(false);
      });

      setTimeout(() => {
        nvidiaSmi.kill();
        resolve(false);
      }, 500);
    });
  }

  /**
   * Check if AMD sysfs is available (Linux only)
   */
  static async isAmdAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') {
      return false;
    }

    try {
      const cards = (await readdirAsync('/sys/class/drm')).filter(entry => /^card\d+$/.test(entry));
      for (const card of cards) {
        try {
          await readFileAsync(`/sys/class/drm/${card}/device/gpu_busy_percent`, 'utf8');
          return true;
        } catch {
          // Try the next DRM card; AMD is not necessarily card0.
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}
