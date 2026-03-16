import { spawn } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs';
const readFileAsync = promisify(readFile);

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
  fanSpeed?: number;
}

// ============================================================================
// GPU Usage Monitor
// ============================================================================

export class GPUMonitor {
  /**
   * Get GPU usage for all GPUs using vendor-specific methods
   * Much faster than si.graphics()!
   */
  async getGPUUsage(gpus: Array<{ vendor?: string; name?: string }>): Promise<Map<number, GPUUsageData>> {
    const results = new Map<number, GPUUsageData>();

    // Separate GPUs by vendor for efficient querying
    const nvidiaGpus: Array<{ index: number; gpu: any }> = [];
    const amdGpus: Array<{ index: number; gpu: any }> = [];

    for (let i = 0; i < gpus.length; i++) {
      const gpu = gpus[i];
      const vendor = (gpu.vendor || this.getGPUVendor(gpu)).toLowerCase();

      if (vendor.includes('nvidia')) {
        nvidiaGpus.push({ index: i, gpu });
      } else if (vendor.includes('amd') || vendor.includes('radeon') || vendor.includes('ati')) {
        amdGpus.push({ index: i, gpu });
      }
      // Intel and others - skip for now
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
        const data = await this.getAmdGpuUsage(index);
        if (data) results.set(index, data);
      } catch (error: any) {
        console.error('[GPUMonitor] Failed to get AMD GPU usage:', error?.message || error);
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
  private async getAmdGpuUsage(gpuIndex: number): Promise<GPUUsageData | null> {
    if (process.platform !== 'linux') {
      return null;
    }

    try {
      const cardNum = `card${gpuIndex}`;

      const [
        usageStr,
        vramUsedStr,
        vramTotalStr,
        tempStr
      ] = await Promise.all([
        readFileAsync(`/sys/class/drm/${cardNum}/device/gpu_busy_percent`, 'utf8').catch(() => null),
        readFileAsync(`/sys/class/drm/${cardNum}/device/mem_info_vram_used`, 'utf8').catch(() => null),
        readFileAsync(`/sys/class/drm/${cardNum}/device/mem_info_vram_total`, 'utf8').catch(() => null),
        readFileAsync(`/sys/class/hwmon/hwmon${gpuIndex}/temp1_input`, 'utf8').catch(() => null),
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

      return Object.keys(data).length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  private getGPUVendor(gpu: any): string {
    const name = (gpu.name || gpu.model || '').toLowerCase();
    if (name.includes('nvidia') || name.includes('geforce') || name.includes('quadro') || name.includes('tesla')) {
      return 'nvidia';
    }
    if (name.includes('amd') || name.includes('radeon') || name.includes('ati')) {
      return 'amd';
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
      await readFileAsync('/sys/class/drm/card0/device/gpu_busy_percent', 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}
