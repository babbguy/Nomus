import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { isNarrowViewport, useAppStore } from '../../stores/appStore';
import { usePipelineStore } from '../../stores/pipelineStore';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import pkg from '../../../package.json';

export default function Shell() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const initSSE = usePipelineStore((s) => s.initSSE);
  const { pathname } = useLocation();

  // On a narrow screen, choosing a page closes the overlay sidebar.
  useEffect(() => {
    if (isNarrowViewport() && useAppStore.getState().sidebarOpen) useAppStore.getState().toggleSidebar();
  }, [pathname]);

  // Initialize global SSE connection for pipeline progress
  useEffect(() => { initSSE(); }, [initSSE]);

  return (
    <div className="flex min-h-screen bg-surface-base">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 sidebar-backdrop md:hidden"
          onClick={toggleSidebar}
        />
      )}

      {/* Sidebar — hidden on mobile unless open */}
      <div className="hidden md:block">
        <Sidebar />
      </div>
      {sidebarOpen && (
        <div className="fixed inset-y-0 left-0 z-40 md:hidden">
          <Sidebar />
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 p-4 md:p-6 animate-page">
          <Outlet />
        </main>
        <footer className="flex items-center justify-between px-4 md:px-6 py-2 border-t border-border text-[11px] text-text-muted">
          <div className="flex items-center gap-4">
            <span>Nomus v{pkg.version}</span>
            <span>Nomus is a regulatory monitoring tool. It does not provide legal advice.</span>
          </div>
          <span>AI REGULATORY MONITORING PLATFORM</span>
        </footer>
      </div>
    </div>
  );
}
