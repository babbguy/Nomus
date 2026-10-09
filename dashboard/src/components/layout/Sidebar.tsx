import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, FileText, ClipboardCheck, Zap,
  Radar, GitFork, MessageSquare, Award, Settings,
  Users, UserCog, Database, Activity, ShieldCheck,
  ChevronLeft, ChevronRight, BookOpen, ScanSearch, Binoculars, Eye, Cpu, Bell,
  User, Server, Sun, Moon, Link2, Boxes, BarChart3, FlaskConical, Shield, ScrollText,
  Layers, Download, Landmark, BookOpenCheck, ListChecks, Gavel, KeyRound, History, SlidersHorizontal, FileCheck2, UsersRound, Scale, FolderGit2,
} from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useCpgMe } from '../../hooks/useCpgMe';
import { showGovernanceNav, visibleGovernancePages } from '../../lib/cpg-permissions';
import { userRoleLabel } from '../../lib/cpg-policy';
import { useAppStore } from '../../stores/appStore';
import { cn } from '../../lib/cn';

const LOGO_WIDE = { dark: '/logo-wide.svg', light: '/logo-wide-dark.svg' };

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  /** Active only on an exact match (for a parent path such as /governance). */
  end?: boolean;
}

function NavItem({ to, icon, label, collapsed, end }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
          isActive
            ? 'bg-accent-dim text-accent'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
          collapsed && 'justify-center px-2',
        )
      }
    >
      {icon}
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

const GOVERNANCE_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  '/governance': Gavel,
  '/governance/policies': FileCheck2,
  '/governance/cases': FolderGit2,
  '/governance/boards': UsersRound,
  '/governance/quorum': Scale,
  '/governance/access': KeyRound,
  '/governance/audit': History,
  '/governance/settings': SlidersHorizontal,
};

/**
 * Corporate policy governance links, from GET /cpg/me (spec §14.1): shown
 * when the user holds a governance permission and governance is on or they
 * can turn it on, listing only the pages the user can open.
 */
function GovernanceNav({ collapsed, iconSize }: { collapsed: boolean; iconSize: number }) {
  const { me } = useCpgMe();
  if (!showGovernanceNav(me)) return null;
  return (
    <NavGroup label="Governance" collapsed={collapsed}>
      {visibleGovernancePages(me).map((p) => {
        const Icon = GOVERNANCE_ICONS[p.to] ?? Gavel;
        return <NavItem key={p.to} to={p.to} end={p.to === '/governance'} icon={<Icon size={iconSize} />} label={p.label} collapsed={collapsed} />;
      })}
    </NavGroup>
  );
}

function NavGroup({ label, collapsed, children }: { label: string; collapsed: boolean; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      {!collapsed && (
        <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {label}
        </p>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export default function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const { sidebarOpen, toggleSidebar, theme, toggleTheme } = useAppStore();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'platform_admin';
  // The governance role for org users who hold one (brief §9); the legacy label otherwise.
  const { me } = useCpgMe();
  const roleLabel = userRoleLabel(user?.role, isAdmin ? null : me);
  const collapsed = !sidebarOpen;
  const iconSize = 18;

  return (
    <aside
      className={cn(
        'h-screen sticky top-0 flex flex-col bg-surface border-r border-border transition-all duration-200 relative',
        collapsed ? 'w-16' : 'w-56',
      )}
    >
      {/* Header */}
      <div className={cn(
        'flex items-center border-b border-border transition-all duration-200',
        collapsed ? 'justify-center h-14 px-0' : 'h-14 px-4',
      )}>
        {collapsed ? (
          <img src="/logo-icon.svg" alt="Nomus" className="w-7 h-7" />
        ) : (
          <img src={LOGO_WIDE[theme]} alt="Nomus" className="h-5" />
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-2 space-y-1">
        {isAdmin ? (
          <>
            <NavGroup label="Overview" collapsed={collapsed}>
              <NavItem to="/admin/dashboard" icon={<LayoutDashboard size={iconSize} />} label="Dashboard" collapsed={collapsed} />
            </NavGroup>
            <NavGroup label="Platform" collapsed={collapsed}>
              <NavItem to="/admin/users" icon={<UserCog size={iconSize} />} label="Users" collapsed={collapsed} />
            </NavGroup>
            <NavGroup label="Nomus" collapsed={collapsed}>
              <NavItem to="/admin/tenants" icon={<Users size={iconSize} />} label="Tenants" collapsed={collapsed} />
              <NavItem to="/admin/sources" icon={<Database size={iconSize} />} label="Sources" collapsed={collapsed} />
              <NavItem to="/admin/rules" icon={<ListChecks size={iconSize} />} label="Rules" collapsed={collapsed} />
              <NavItem to="/admin/pipeline" icon={<Activity size={iconSize} />} label="Pipeline" collapsed={collapsed} />
              <NavItem to="/admin/integrity" icon={<ShieldCheck size={iconSize} />} label="Integrity" collapsed={collapsed} />
              <NavItem to="/admin/feedback" icon={<MessageSquare size={iconSize} />} label="Feedback" collapsed={collapsed} />
              <NavItem to="/admin/radar" icon={<Radar size={iconSize} />} label="Radar" collapsed={collapsed} />
              <NavItem to="/admin/ontology" icon={<BookOpen size={iconSize} />} label="Ontology" collapsed={collapsed} />
              <NavItem to="/admin/scans" icon={<ScanSearch size={iconSize} />} label="Scans" collapsed={collapsed} />
              <NavItem to="/admin/llm" icon={<Cpu size={iconSize} />} label="LLM Providers" collapsed={collapsed} />
              <NavItem to="/admin/notifications" icon={<Bell size={iconSize} />} label="Notifications" collapsed={collapsed} />
              <NavItem to="/admin/system" icon={<Server size={iconSize} />} label="System" collapsed={collapsed} />
            </NavGroup>
            <NavGroup label="Scout" collapsed={collapsed}>
              <NavItem to="/admin/scout/feeds" icon={<Binoculars size={iconSize} />} label="Feeds" collapsed={collapsed} />
              <NavItem to="/admin/scout/review" icon={<Eye size={iconSize} />} label="Review" collapsed={collapsed} />
            </NavGroup>
            <NavGroup label="Integrations" collapsed={collapsed}>
              <NavItem to="/admin/modus" icon={<Link2 size={iconSize} />} label="Modus" collapsed={collapsed} />
            </NavGroup>
            <NavGroup label="Public" collapsed={collapsed}>
              <NavItem to="/ledger" icon={<ScrollText size={iconSize} />} label="The Ledger" collapsed={collapsed} />
            </NavGroup>
          </>
        ) : (
          <>
            <NavGroup label="Overview" collapsed={collapsed}>
              <NavItem to="/dashboard" icon={<LayoutDashboard size={iconSize} />} label="Dashboard" collapsed={collapsed} />
            </NavGroup>
            <NavGroup label="Compliance" collapsed={collapsed}>
              <NavItem to="/policies" icon={<FileText size={iconSize} />} label="Policies" collapsed={collapsed} />
              <NavItem to="/attestations" icon={<ClipboardCheck size={iconSize} />} label="Attestations" collapsed={collapsed} />
              <NavItem to="/simulator" icon={<Zap size={iconSize} />} label="Simulator" collapsed={collapsed} />
              <NavItem to="/radar" icon={<Radar size={iconSize} />} label="Radar" collapsed={collapsed} />
              <NavItem to="/radar/v2" icon={<Landmark size={iconSize} />} label="Bill Tracker" collapsed={collapsed} />
              <NavItem to="/graph" icon={<GitFork size={iconSize} />} label="Graph" collapsed={collapsed} />
              <NavItem to="/ai-bom" icon={<Boxes size={iconSize} />} label="AI-BOM" collapsed={collapsed} />
              <NavItem to="/compliance" icon={<Shield size={iconSize} />} label="Posture" collapsed={collapsed} />
              <NavItem to="/templates" icon={<Layers size={iconSize} />} label="Templates" collapsed={collapsed} />
              <NavItem to="/simulations" icon={<FlaskConical size={iconSize} />} label="Simulations" collapsed={collapsed} />
            </NavGroup>
            <NavGroup label="Scanner" collapsed={collapsed}>
              <NavItem to="/scans" icon={<ScanSearch size={iconSize} />} label="Scans" collapsed={collapsed} />
              <NavItem to="/clause-map" icon={<BookOpenCheck size={iconSize} />} label="Clause Map" collapsed={collapsed} />
              <NavItem to="/benchmarks" icon={<BarChart3 size={iconSize} />} label="Benchmarks" collapsed={collapsed} />
            </NavGroup>
            <GovernanceNav collapsed={collapsed} iconSize={iconSize} />
            <NavGroup label="Account" collapsed={collapsed}>
              <NavItem to="/feedback" icon={<MessageSquare size={iconSize} />} label="Feedback" collapsed={collapsed} />
              <NavItem to="/audit-log" icon={<Download size={iconSize} />} label="Audit Log" collapsed={collapsed} />
              <NavItem to="/badge" icon={<Award size={iconSize} />} label="Badge" collapsed={collapsed} />
              <NavItem to="/team" icon={<Users size={iconSize} />} label="Team" collapsed={collapsed} />
              <NavItem to="/profile" icon={<User size={iconSize} />} label="Profile" collapsed={collapsed} />
              <NavItem to="/settings" icon={<Settings size={iconSize} />} label="Settings" collapsed={collapsed} />
              <NavItem to="/ledger" icon={<ScrollText size={iconSize} />} label="The Ledger" collapsed={collapsed} />
            </NavGroup>
          </>
        )}
      </nav>

      {/* User profile + theme toggle */}
      <div className="border-t border-border px-3 py-3">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={() => navigate('/profile')}
              className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-accent-text text-xs font-semibold hover:ring-2 hover:ring-accent/50 transition cursor-pointer"
              title="Profile"
            >
              {user?.name?.charAt(0)?.toUpperCase() ?? 'U'}
            </button>
            <button onClick={toggleTheme} className="text-text-muted hover:text-text-primary transition">
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <button
              onClick={() => navigate('/profile')}
              className="flex items-center gap-2 min-w-0 hover:opacity-80 transition cursor-pointer"
            >
              <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-accent-text text-xs font-semibold shrink-0">
                {user?.name?.charAt(0)?.toUpperCase() ?? 'U'}
              </div>
              <div className="min-w-0 text-left">
                <p className="text-sm font-medium text-text-primary truncate">{user?.name}</p>
                <p className="text-[10px] text-text-muted truncate" data-testid="sidebar-role" title={me && !isAdmin && me.roles.length > 1 ? me.roles.map((r) => r.name).join(', ') : undefined}>{roleLabel}</p>
              </div>
            </button>
            <div className="flex items-center gap-1">
              <button
                onClick={toggleTheme}
                className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition"
                title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              >
                {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Collapse toggle — edge tab */}
      <button
        onClick={toggleSidebar}
        className="absolute top-1/2 -translate-y-1/2 -right-3 w-3 h-8 flex items-center justify-center bg-surface-raised border border-border border-l-0 rounded-r text-text-muted hover:text-text-primary hover:bg-surface-hover transition z-20"
      >
        {collapsed ? <ChevronRight size={10} /> : <ChevronLeft size={10} />}
      </button>
    </aside>
  );
}
