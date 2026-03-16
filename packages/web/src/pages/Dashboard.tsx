import { useQuery } from '@tanstack/react-query';
import { api, formatBytes } from '@/utils/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Server, FileVideo, ListTodo, HardDrive, Folder } from 'lucide-react';
import { StatusBadge } from '@/components/ui/Badge';
import { Link } from 'react-router-dom';
import { useWebSocket } from '@/hooks/useWebSocket';

export function Dashboard() {
  // Connect to WebSocket for real-time updates
  useWebSocket({ channels: ['nodes', 'jobs'] });

  const { data: stats, isLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.getStats(),
    staleTime: 30000, // Stats can be stale for 30 seconds
  });

  const { data: libraries } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.getLibraries(),
    staleTime: 30000, // Libraries can be stale for 30 seconds
  });

  const totalLibraryFiles = libraries?.reduce((sum: number, lib: any) => sum + (lib.file_count || 0), 0) || 0;

  if (isLoading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Dashboard</h1>
        <p className="text-gray-400">Overview of your transcoding system</p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Nodes</CardTitle>
            <Server className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{stats?.nodes.online || 0}/{stats?.nodes.total || 0}</div>
            <p className="text-xs text-gray-400">
              {stats?.nodes.busy || 0} busy
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Files</CardTitle>
            <FileVideo className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{stats?.files.total || 0}</div>
            <p className="text-xs text-gray-400">
              {stats?.files.completed || 0} completed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Jobs</CardTitle>
            <ListTodo className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{stats?.jobs.queued || 0}</div>
            <p className="text-xs text-gray-400">
              {stats?.jobs.processing || 0} processing
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Storage Saved</CardTitle>
            <HardDrive className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{formatBytes(stats?.storage.saved_space || 0)}</div>
            <p className="text-xs text-gray-400">
              {formatBytes(stats?.storage.original_size || 0)} total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Library</CardTitle>
            <Folder className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{totalLibraryFiles}</div>
            <p className="text-xs text-gray-400">
              {libraries?.length || 0} libraries
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Node Status & Quick Actions */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Node Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Online Nodes</span>
                <StatusBadge status="online" />
                <span className="text-sm font-medium text-white">{stats?.nodes.online || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Offline Nodes</span>
                <StatusBadge status="offline" />
                <span className="text-sm font-medium text-white">{stats?.nodes.offline || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Busy Nodes</span>
                <StatusBadge status="busy" />
                <span className="text-sm font-medium text-white">{stats?.nodes.busy || 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link
              to="/library"
              className="block w-full p-3 rounded-lg text-center transition-colors"
              style={{ backgroundColor: '#1E1D1F', border: '1px solid #38363a' }}
            >
              <div className="flex items-center justify-center gap-2">
                <Folder className="h-4 w-4" style={{ color: '#74c69d' }} />
                <span className="text-white text-sm">Manage Library</span>
              </div>
            </Link>
            {libraries && libraries.length > 0 && (
              <div className="text-xs text-gray-400 mt-2">
                {libraries.map((lib: any) => (
                  <div key={lib.id} className="flex justify-between py-1">
                    <span className="truncate">{lib.name}</span>
                    <span>{lib.file_count || 0} files</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
