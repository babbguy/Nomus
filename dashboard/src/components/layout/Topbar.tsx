import { useState, useRef, useEffect, useCallback } from 'react';
import { LogOut, Menu, HelpCircle, BookOpen, Bug } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useAppStore } from '../../stores/appStore';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';

interface PlatformStatus {
  status: 'operational' | 'degraded' | 'down';
  latencyMs: number;
  connectedClients: number;
  lastPipelineRun: { status: string; completedAt: string } | null;
  uptimePercent: number;
}

const statusDotColor: Record<string, string> = {
  operational: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-danger',
};

const statusLabel: Record<string, string> = {
  operational: 'All Systems Operational',
  degraded: 'Degraded Performance',
  down: 'System Down',
};

export default function Topbar() {
  const { logout } = useAuthStore();
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const navigate = useNavigate();

  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [platformStatus, setPlatformStatus] = useState<PlatformStatus | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(() => {
    const start = Date.now();
    api.get('/status')
      .then((r) => {
        setPlatformStatus({ ...r.data, latencyMs: Date.now() - start });
      })
      .catch(() => {
        setPlatformStatus({ status: 'down', latencyMs: 0, connectedClients: 0, lastPipelineRun: null, uptimePercent: 0 });
      });
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) {
        setHelpOpen(false);
      }
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
    }
    if (helpOpen || statusOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [helpOpen, statusOpen]);

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <header className="h-14 border-b border-border flex items-center justify-between px-4 md:px-6 bg-surface/50 backdrop-blur-sm sticky top-0 z-10">
      {/* Mobile menu button */}
      <button
        onClick={toggleSidebar}
        className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition md:hidden"
      >
        <Menu size={20} />
      </button>

      <div className="hidden md:block" />

      <div className="flex items-center gap-3 md:gap-4">
        {/* Status dot */}
        <div className="relative" ref={statusRef}>
          <button
            onClick={() => setStatusOpen(!statusOpen)}
            className="p-1.5 rounded-lg hover:bg-surface-hover transition flex items-center"
            title="System status"
          >
            <span className={`w-2.5 h-2.5 rounded-full ${platformStatus ? statusDotColor[platformStatus.status] : 'bg-surface-hover'}`} />
          </button>
          {statusOpen && platformStatus && (
            <div className="absolute right-0 top-full mt-2 w-64 glass rounded-xl py-3 px-4 shadow-lg z-20 space-y-2">
              <p className="text-sm font-medium text-text-primary">{statusLabel[platformStatus.status]}</p>
              <div className="text-xs text-text-secondary space-y-1">
                <div className="flex justify-between">
                  <span className="text-text-muted">API Latency</span>
                  <span>{platformStatus.latencyMs}ms</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">SSE Clients</span>
                  <span>{platformStatus.connectedClients}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Last Pipeline</span>
                  <span>
                    {platformStatus.lastPipelineRun
                      ? `${platformStatus.lastPipelineRun.status}`
                      : 'None'}
                  </span>
                </div>
                {platformStatus.lastPipelineRun && (
                  <p className="text-text-muted text-right">
                    {new Date(platformStatus.lastPipelineRun.completedAt).toLocaleString()}
                  </p>
                )}
                <div className="flex justify-between">
                  <span className="text-text-muted">Uptime</span>
                  <span>{platformStatus.uptimePercent}%</span>
                </div>
              </div>
              <div className="border-t border-border pt-2 mt-1">
                <p className="text-xs font-medium text-text-primary mb-1">Extensions</p>
                <div className="text-xs text-text-secondary space-y-1">
                  <div className="flex justify-between">
                    <span className="text-text-muted">VS Code</span>
                    <span className={platformStatus.connectedClients > 0 ? 'text-success' : 'text-text-muted'}>
                      {platformStatus.connectedClients > 0 ? 'Connected' : 'No active connections'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">GitHub Action</span>
                    <span className="text-text-muted">Not configured</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Help */}
        <div className="relative" ref={helpRef}>
          <button
            onClick={() => setHelpOpen(!helpOpen)}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition"
            title="Help"
          >
            <HelpCircle size={16} />
          </button>

          {helpOpen && (
            <div className="absolute right-0 top-full mt-2 w-52 glass rounded-xl py-2 shadow-lg z-20">
              <a
                href="https://github.com/babbguy/Nomus/tree/main/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover transition"
                onClick={() => setHelpOpen(false)}
              >
                <BookOpen size={14} />
                Documentation
              </a>
              <a
                href="https://github.com/babbguy/Nomus/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover transition"
                onClick={() => setHelpOpen(false)}
              >
                <Bug size={14} />
                Report a Bug
              </a>
            </div>
          )}
        </div>

        <button
          onClick={handleLogout}
          className="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition"
          title="Sign out"
        >
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}
