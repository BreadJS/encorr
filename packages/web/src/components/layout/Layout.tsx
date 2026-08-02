import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Server,
  FolderOpen,
  FileVideo,
  ListTodo,
  Settings,
  Film,
  Folder,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  HardDrive,
} from 'lucide-react';
import logo from '@/assets/logo.png';
import { useWebSocket } from '@/hooks/useWebSocket';

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/nodes', label: 'Nodes', icon: Server },
  { path: '/mappings', label: 'Mappings', icon: FolderOpen },
  { path: '/library', label: 'Library', icon: Folder },
  { path: '/files', label: 'Files', icon: FileVideo },
  { path: '/storage', label: 'Storage', icon: HardDrive },
  { path: '/jobs', label: 'Jobs', icon: ListTodo },
  { path: '/presets', label: 'Presets', icon: Film },
  { path: '/settings', label: 'Settings', icon: Settings },
];

const SIDEBAR_WIDTH = '16rem'; // w-64
const SIDEBAR_COLLAPSED_WIDTH = '4rem'; // w-16

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  useWebSocket({ channels: ['library'] });

  const { data: libraryScans = {} } = useQuery<Record<string, { status: string }>>({
    queryKey: ['library-scans'],
    queryFn: async () => ({}),
    initialData: {},
    staleTime: Infinity,
  });
  const isLibraryScanning = Object.values(libraryScans).some(
    scan => scan.status === 'starting' || scan.status === 'scanning',
  );

  const [isCollapsed, setIsCollapsed] = useState(() => {
    // Load from localStorage on mount
    const saved = localStorage.getItem('sidebar-collapsed');
    return saved === 'true';
  });

  useEffect(() => {
    // Save to localStorage whenever state changes
    localStorage.setItem('sidebar-collapsed', isCollapsed.toString());
  }, [isCollapsed]);

  const toggleSidebar = () => {
    setIsCollapsed(!isCollapsed);
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#1E1D1F', color: '#F5F5F5' }}>
      {/* Sidebar */}
      <aside
        className="fixed left-0 top-0 z-10 h-full border-r transition-all duration-300 ease-in-out"
        style={{
          backgroundColor: '#282729',
          borderColor: '#39363a',
          width: isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH,
        }}
      >
        {/* Header with logo and collapse button */}
        <div className="flex h-16 items-center justify-end border-b px-4" style={{ borderColor: '#39363a' }}>
          {!isCollapsed && (
            <div className="absolute left-4 flex items-center gap-2 transition-opacity duration-200">
              <img src={logo} alt="Encorr Logo" className="h-7 w-7" />
              <h1 className="text-xl font-bold text-white" style={{ color: '#74c69d' }}>
                Encorr
              </h1>
            </div>
          )}
          <button
            onClick={toggleSidebar}
            className="flex-shrink-0 rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isCollapsed ? (
              <ChevronRight className="h-5 w-5" />
            ) : (
              <ChevronLeft className="h-5 w-5" />
            )}
          </button>
        </div>

        {/* Navigation */}
        <nav className="space-y-1 p-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;
            const showScanSpinner = item.path === '/library' && isLibraryScanning;

            return (
              <Link
                key={item.path}
                to={item.path}
                className={clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 relative group',
                  isActive
                    ? 'bg-primary text-white'
                    : 'text-gray-400 hover:bg-primary/20'
                )}
                style={isActive ? { backgroundColor: '#74c69d' } : {}}
                title={isCollapsed ? `${item.label}${showScanSpinner ? ' (scanning)' : ''}` : undefined}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {!isCollapsed && (
                  <>
                    <span className="transition-opacity duration-200 whitespace-nowrap">
                      {item.label}
                    </span>
                    {showScanSpinner && (
                      <RefreshCw
                        className="ml-auto h-3.5 w-3.5 flex-shrink-0 animate-spin"
                        aria-label="Library scan in progress"
                      />
                    )}
                  </>
                )}
                {isCollapsed && showScanSpinner && (
                  <RefreshCw
                    className="absolute right-1 top-1 h-2.5 w-2.5 animate-spin"
                    aria-label="Library scan in progress"
                  />
                )}
                {/* Tooltip when collapsed */}
                {isCollapsed && (
                  <div className="absolute left-full ml-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                    {item.label}{showScanSpinner ? ' · Scanning' : ''}
                  </div>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main content */}
      <main
        className="transition-all duration-300 ease-in-out"
        style={{ marginLeft: isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
      >
        <div className="container mx-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
