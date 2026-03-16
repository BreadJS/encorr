import { Link, useLocation } from 'react-router-dom';
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
} from 'lucide-react';

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/nodes', label: 'Nodes', icon: Server },
  { path: '/mappings', label: 'Mappings', icon: FolderOpen },
  { path: '/files', label: 'Files', icon: FileVideo },
  { path: '/library', label: 'Library', icon: Folder },
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
          borderColor: 'rgba(116, 198, 157, 0.2)',
          width: isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH,
        }}
      >
        {/* Header with logo and collapse button */}
        <div className="flex h-16 items-center justify-end border-b px-4" style={{ borderColor: 'rgba(116, 198, 157, 0.2)' }}>
          {!isCollapsed && (
            <h1 className="absolute left-4 text-xl font-bold text-white transition-opacity duration-200" style={{ color: '#74c69d' }}>
              Encorr
            </h1>
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
                title={isCollapsed ? item.label : undefined}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {!isCollapsed && (
                  <span className="transition-opacity duration-200 whitespace-nowrap">
                    {item.label}
                  </span>
                )}
                {/* Tooltip when collapsed */}
                {isCollapsed && (
                  <div className="absolute left-full ml-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                    {item.label}
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
