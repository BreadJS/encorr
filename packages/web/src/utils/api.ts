// ============================================================================
// Config
// ============================================================================

// Use current page's hostname for dynamic support (localhost, IP, domain)
function getBackendUrl(): string {
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  return `${protocol}//${hostname}:8101`;
}

let API_BASE = getBackendUrl();
let BACKEND_URL = getBackendUrl();

async function loadConfig(): Promise<void> {
  try {
    // Try to fetch config from the backend first
    const response = await fetch(`${getBackendUrl()}/config`);
    if (response.ok) {
      const result = await response.json();
      if (result.success && result.data) {
        // Config loaded, use dynamic backend URL
        BACKEND_URL = getBackendUrl();
        API_BASE = BACKEND_URL;
        return;
      }
    }
  } catch (error) {
    // Fallback to defaults
    console.warn('Failed to fetch config, using defaults');
  }
  // Fallback values
  BACKEND_URL = getBackendUrl();
  API_BASE = BACKEND_URL;
}

// ============================================================================
// API Response Type
// ============================================================================

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// ============================================================================
// API Client
// ============================================================================

// Load config on module initialization
let configPromise = loadConfig();

async function request<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  // Ensure config is loaded before making requests
  await configPromise;

  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  const data: ApiResponse<T> = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data.data as T;
}

// ============================================================================
// API Functions
// ============================================================================

export const api = {
  // Health check
  health: () => request<{ status: string }>('/health'),

  // Nodes
  getNodes: () => request<any[]>('/nodes'),
  getNode: (id: string) => request<any>(`/nodes/${id}`),
  updateNode: (id: string, data: { max_workers?: { cpu: number; gpus?: number[] }; config?: any }) =>
    request<any>(`/nodes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteNode: (id: string) => request<any>(`/nodes/${id}`, { method: 'DELETE' }),

  // Folder Mappings
  getMappings: () => request<any[]>('/mappings'),
  getMapping: (id: string) => request<any>(`/mappings/${id}`),
  createMapping: (data: { node_id: string; server_path: string; node_path: string; watch?: boolean }) =>
    request<any>('/mappings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateMapping: (id: string, data: { server_path?: string; node_path?: string; watch?: boolean }) =>
    request<any>(`/mappings/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteMapping: (id: string) => request<any>(`/mappings/${id}`, { method: 'DELETE' }),

  // Libraries
  getLibraries: () => request<any[]>('/libraries'),
  getLibrary: (id: string) => request<any>(`/libraries/${id}`),
  createLibrary: (data: { name: string; path: string }) =>
    request<any>('/libraries', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteLibrary: (id: string) => request<any>(`/libraries/${id}`, { method: 'DELETE' }),
  importLibrary: (id: string, recursive = true) =>
    request<{ imported: number; skipped: number; message: string }>(`/libraries/${id}/import`, {
      method: 'POST',
      body: JSON.stringify({ recursive }),
    }),
  getLibraryFiles: (id: string, status?: string) =>
    request<any[]>(`/libraries/${id}/files${status ? '?status=' + status : ''}`),
  updateLibraryFileStatus: (id: string, data: { status: string; job_id?: string; error_message?: string }) =>
    request<any>(`/library-files/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  updateLibraryFileProgress: (id: string, progress: number) =>
    request<any>(`/library-files/${id}/progress`, {
      method: 'PUT',
      body: JSON.stringify({ progress }),
    }),
  deleteLibraryFile: (id: string) => request<any>(`/library-files/${id}`, { method: 'DELETE' }),
  getAllLibraryFiles: (params?: { page?: number; per_page?: number; status?: string; library_id?: string }) => {
    // Filter out undefined values
    const filteredParams = Object.fromEntries(
      Object.entries(params || {}).filter(([_, value]) => value !== undefined)
    );
    const queryString = new URLSearchParams(filteredParams as any).toString();
    return request<{
      items: any[];
      total: number;
      page: number;
      per_page: number;
      total_pages: number;
    }>(`/library-files${queryString ? '?' + queryString : ''}`);
  },

  // Filesystem
  getDrives: () =>
    request<{ platform: string; drives: Array<{ letter: string; path: string }> }>('/filesystem/drives'),
  browseDirectory: (path: string) =>
    request<{ platform: string; current_path: string; parent_path: string | null; items: Array<{ name: string; path: string; type: 'directory' }> }>('/filesystem/browse', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  validatePath: (path: string) =>
    request<{ valid: boolean; error?: string; path?: string }>('/filesystem/validate', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  // Files
  getFiles: (params?: { status?: string; limit?: number; offset?: number }) =>
    request<any>(`/files${new URLSearchParams(params as any).toString() ? '?' + new URLSearchParams(params as any).toString() : ''}`),
  getFile: (id: string) => request<any>(`/files/${id}`),
  scanFiles: (mappingId?: string) =>
    request<any>('/files/scan', {
      method: 'POST',
      body: JSON.stringify(mappingId ? { mapping_id: mappingId } : {}),
    }),

  // Jobs
  getJobs: (params?: { status?: string; limit?: number; offset?: number }) =>
    request<any[]>(`/jobs${new URLSearchParams(params as any).toString() ? '?' + new URLSearchParams(params as any).toString() : ''}`),
  getJob: (id: string) => request<any>(`/jobs/${id}`),
  createJob: (data: { file_ids: string[]; preset_id: string }) =>
    request<any[]>('/jobs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createSmartJob: (data: { file_ids: string[]; mode: 'auto' | 'gpu' | 'cpu'; preset_id?: string }) =>
    request<{
      success: boolean;
      jobs: Array<{
        fileId: string;
        jobId: string;
        fileName: string;
        presetId: string;
        presetName: string;
        reason: string;
        expectedCompression: string;
        originalSize: number;
        estimatedSize: number;
        mode: 'auto' | 'gpu' | 'cpu';
      }>;
      summary: {
        total: number;
        gpu: number;
        cpu: number;
        totalOriginalSize: number;
        estimatedOutputSize: number;
        estimatedSpaceSaved: number;
      };
    }>('/jobs/smart', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteJob: (id: string) => request<any>(`/jobs/${id}`, { method: 'DELETE' }),

  // Presets
  getPresets: () => request<any[]>('/presets'),
  getPreset: (id: string) => request<any>(`/presets/${id}`),
  createPreset: (data: { name: string; description?: string; config: any }) =>
    request<any>('/presets', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updatePreset: (id: string, data: { name?: string; description?: string; config?: any }) =>
    request<any>(`/presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deletePreset: (id: string) => request<any>(`/presets/${id}`, { method: 'DELETE' }),

  // Quick Select Presets
  getQuickSelectPresets: () => request<any[]>('/quick-select-presets'),
  getQuickSelectPreset: (id: string) => request<any>(`/quick-select-presets/${id}`),
  createQuickSelectPreset: (data: {
    name: string;
    description?: string;
    nvidia_preset_id?: string;
    amd_preset_id?: string;
    intel_preset_id?: string;
    cpu_preset_id?: string;
  }) =>
    request<any>('/quick-select-presets', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateQuickSelectPreset: (id: string, data: {
    name?: string;
    description?: string;
    nvidia_preset_id?: string;
    amd_preset_id?: string;
    intel_preset_id?: string;
    cpu_preset_id?: string;
  }) =>
    request<any>(`/quick-select-presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteQuickSelectPreset: (id: string) => request<any>(`/quick-select-presets/${id}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => request<Record<string, any>>('/settings'),
  updateSettings: (data: any) =>
    request<any>('/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Stats
  getStats: () => request<any>('/stats'),

  // Worker availability
  getWorkerAvailability: () => request<{
    hasCpuWorkers: boolean;
    hasGpuWorkers: boolean;
    cpuWorkersAvailable: number;
    details: any[];
  }>('/workers/availability'),

  // Job History
  getFileJobHistory: (fileId: string, limit?: number) =>
    request<any[]>(`/files/${fileId}/job-history${limit ? '?limit=' + limit : ''}`),
  getAllJobHistory: (limit?: number) =>
    request<any[]>(`/job-history${limit ? '?limit=' + limit : ''}`),

  // Reports
  getReportsForFile: (fileId: string, limit?: number) =>
    request<any[]>(`/reports/${fileId}${limit ? '?limit=' + limit : ''}`),
  getReport: (id: string) =>
    request<any>(`/report/${id}`),

  // Logs
  getLogs: (params?: { level?: string; category?: string; limit?: number }) =>
    request<any[]>(`/logs${new URLSearchParams(params as any).toString() ? '?' + new URLSearchParams(params as any).toString() : ''}`),
};

// ============================================================================
// Utility Functions
// ============================================================================

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}
