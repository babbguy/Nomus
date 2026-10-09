import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import Spinner from './components/ui/Spinner';
import ProtectedRoute from './components/layout/ProtectedRoute';
import Shell from './components/layout/Shell';
import PermissionRoute from './components/layout/PermissionRoute';
import {
  ACCESS_REQUIREMENT, AUDIT_REQUIREMENT, POLICIES_REQUIREMENT, POLICY_AUTHOR_REQUIREMENT, SETTINGS_REQUIREMENT,
} from './lib/cpg-permissions';
import Login from './pages/Login';
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const TenantList = lazy(() => import('./pages/admin/TenantList'));
const TenantDetail = lazy(() => import('./pages/admin/TenantDetail'));
const SourceList = lazy(() => import('./pages/admin/SourceList'));
const DiffViewer = lazy(() => import('./pages/admin/DiffViewer'));
const SourceAudit = lazy(() => import('./pages/admin/SourceAudit'));
const RuleManager = lazy(() => import('./pages/admin/RuleManager'));
const PipelineHistory = lazy(() => import('./pages/admin/PipelineHistory'));
const IntegrityCheck = lazy(() => import('./pages/admin/IntegrityCheck'));
const FeedbackReview = lazy(() => import('./pages/admin/FeedbackReview'));
const RadarManage = lazy(() => import('./pages/admin/RadarManage'));
const OntologyManage = lazy(() => import('./pages/admin/OntologyManage'));
const UserList = lazy(() => import('./pages/admin/UserList'));
const PublicTransparency = lazy(() => import('./pages/PublicTransparency'));
const PublicVerify = lazy(() => import('./pages/PublicVerify'));
const CustomerDashboard = lazy(() => import('./pages/customer/CustomerDashboard'));
const Policies = lazy(() => import('./pages/customer/Policies'));
const Attestations = lazy(() => import('./pages/customer/Attestations'));
const FeedbackSubmit = lazy(() => import('./pages/customer/FeedbackSubmit'));
const Settings = lazy(() => import('./pages/customer/Settings'));
const Simulator = lazy(() => import('./pages/customer/Simulator'));
const Radar = lazy(() => import('./pages/customer/Radar'));
const BadgePage = lazy(() => import('./pages/customer/BadgePage'));
const GraphExplorer = lazy(() => import('./pages/customer/GraphExplorer'));
const Scans = lazy(() => import('./pages/customer/Scans'));
const ClauseMap = lazy(() => import('./pages/customer/ClauseMap'));
const ScanRepo = lazy(() => import('./pages/customer/ScanRepo'));
const Profile = lazy(() => import('./pages/customer/Profile'));
const Team = lazy(() => import('./pages/customer/Team'));
const AiBom = lazy(() => import('./pages/customer/AiBom'));
const Benchmarks = lazy(() => import('./pages/customer/Benchmarks'));
const Simulations = lazy(() => import('./pages/customer/Simulations'));
const CompliancePosture = lazy(() => import('./pages/customer/CompliancePosture'));
const Templates = lazy(() => import('./pages/customer/Templates'));
const AuditExport = lazy(() => import('./pages/customer/AuditExport'));
const RadarV2 = lazy(() => import('./pages/customer/RadarV2'));
const BillDetail = lazy(() => import('./pages/customer/BillDetail'));
const GovernanceOverview = lazy(() => import('./pages/governance/GovernanceOverview'));
const GovernanceAccess = lazy(() => import('./pages/governance/GovernanceAccess'));
const GovernanceAudit = lazy(() => import('./pages/governance/GovernanceAudit'));
const GovernanceSettings = lazy(() => import('./pages/governance/GovernanceSettings'));
const GovernancePolicies = lazy(() => import('./pages/governance/GovernancePolicies'));
const PolicyNew = lazy(() => import('./pages/governance/PolicyNew'));
const PolicyDetail = lazy(() => import('./pages/governance/PolicyDetail'));
const ScanAdmin = lazy(() => import('./pages/admin/ScanAdmin'));
const ScoutFeeds = lazy(() => import('./pages/admin/ScoutFeeds'));
const ScoutReview = lazy(() => import('./pages/admin/ScoutReview'));
const LLMSettings = lazy(() => import('./pages/admin/LLMSettings'));
const NotificationSettings = lazy(() => import('./pages/admin/NotificationSettings'));
const SystemStatus = lazy(() => import('./pages/admin/SystemStatus'));
const ModusIntegration = lazy(() => import('./pages/admin/ModusIntegration'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const ForceChangePassword = lazy(() => import('./pages/ForceChangePassword'));
const NotFound = lazy(() => import('./pages/NotFound'));

function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (user?.role !== 'platform_admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/** Redirect to force-change-password if user has mustChangePassword flag */
function PasswordGate({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (user?.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    useAuthStore.getState().checkSession();
  }, []);

  const defaultRedirect = user?.role === 'platform_admin' ? '/admin/dashboard' : '/dashboard';

  return (
    <Suspense fallback={<div className="flex justify-center py-20"><Spinner /></div>}>
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/change-password" element={<ForceChangePassword />} />
      {/* /verify/:verifyId — UUID → attestation verification (attestation reliance network); slug → org badge */}
      <Route path="/verify/:verifyId" element={<PublicVerify />} />
      <Route path="/ledger" element={<PublicTransparency />} />
      <Route path="/transparency" element={<PublicTransparency />} />

      {/* Authenticated shell — PasswordGate redirects if mustChangePassword */}
      <Route element={<ProtectedRoute><PasswordGate><Shell /></PasswordGate></ProtectedRoute>}>
        {/* Root redirect */}
        <Route index element={isAuthenticated ? <Navigate to={defaultRedirect} replace /> : <Navigate to="/login" replace />} />

        {/* Admin routes */}
        <Route path="admin" element={<Navigate to="/admin/dashboard" replace />} />
        <Route path="admin/dashboard" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
        <Route path="admin/users" element={<AdminRoute><UserList /></AdminRoute>} />
        <Route path="admin/tenants" element={<AdminRoute><TenantList /></AdminRoute>} />
        <Route path="admin/tenants/:id" element={<AdminRoute><TenantDetail /></AdminRoute>} />
        <Route path="admin/sources" element={<AdminRoute><SourceList /></AdminRoute>} />
        <Route path="admin/sources/:sourceId" element={<AdminRoute><SourceAudit /></AdminRoute>} />
        <Route path="admin/sources/:sourceId/rules" element={<AdminRoute><RuleManager /></AdminRoute>} />
        <Route path="admin/rules" element={<AdminRoute><RuleManager /></AdminRoute>} />
        <Route path="admin/diffs/:sourceId" element={<AdminRoute><DiffViewer /></AdminRoute>} />
        <Route path="admin/pipeline" element={<AdminRoute><PipelineHistory /></AdminRoute>} />
        <Route path="admin/integrity" element={<AdminRoute><IntegrityCheck /></AdminRoute>} />
        <Route path="admin/feedback" element={<AdminRoute><FeedbackReview /></AdminRoute>} />
        <Route path="admin/radar" element={<AdminRoute><RadarManage /></AdminRoute>} />
        <Route path="admin/ontology" element={<AdminRoute><OntologyManage /></AdminRoute>} />
        <Route path="admin/scans" element={<AdminRoute><ScanAdmin /></AdminRoute>} />
        <Route path="admin/scout/feeds" element={<AdminRoute><ScoutFeeds /></AdminRoute>} />
        <Route path="admin/scout/review" element={<AdminRoute><ScoutReview /></AdminRoute>} />
        <Route path="admin/llm" element={<AdminRoute><LLMSettings /></AdminRoute>} />
        <Route path="admin/notifications" element={<AdminRoute><NotificationSettings /></AdminRoute>} />
        <Route path="admin/system" element={<AdminRoute><SystemStatus /></AdminRoute>} />
        <Route path="admin/modus" element={<AdminRoute><ModusIntegration /></AdminRoute>} />
        {/* Forge page removed — functionality integrated into Sources page */}

        {/* Customer routes */}
        <Route path="dashboard" element={<CustomerDashboard />} />
        <Route path="policies" element={<Policies />} />
        <Route path="attestations" element={<Attestations />} />
        <Route path="simulator" element={<Simulator />} />
        <Route path="radar" element={<Radar />} />
        <Route path="radar/v2" element={<RadarV2 />} />
        <Route path="radar/v2/bills/:id" element={<BillDetail />} />
        <Route path="graph" element={<GraphExplorer />} />
        <Route path="feedback" element={<FeedbackSubmit />} />
        <Route path="badge" element={<BadgePage />} />
        <Route path="ai-bom" element={<AiBom />} />
        <Route path="benchmarks" element={<Benchmarks />} />
        <Route path="simulations" element={<Simulations />} />
        <Route path="compliance" element={<CompliancePosture />} />
        <Route path="templates" element={<Templates />} />
        <Route path="audit-log" element={<AuditExport />} />
        <Route path="scans" element={<Scans />} />
        <Route path="scans/:repo" element={<ScanRepo />} />
        <Route path="clause-map" element={<ClauseMap />} />
        <Route path="settings" element={<Settings />} />
        <Route path="profile" element={<Profile />} />
        <Route path="team" element={<Team />} />

        {/* Corporate policy governance: guarded by GET /cpg/me permissions */}
        <Route path="governance" element={<GovernanceOverview />} />
        <Route path="governance/access" element={<PermissionRoute {...ACCESS_REQUIREMENT}><GovernanceAccess /></PermissionRoute>} />
        <Route path="governance/audit" element={<PermissionRoute {...AUDIT_REQUIREMENT}><GovernanceAudit /></PermissionRoute>} />
        <Route path="governance/settings" element={<PermissionRoute {...SETTINGS_REQUIREMENT}><GovernanceSettings /></PermissionRoute>} />
        <Route path="governance/policies" element={<PermissionRoute {...POLICIES_REQUIREMENT}><GovernancePolicies /></PermissionRoute>} />
        <Route path="governance/policies/new" element={<PermissionRoute {...POLICY_AUTHOR_REQUIREMENT}><PolicyNew /></PermissionRoute>} />
        <Route path="governance/policies/:id" element={<PermissionRoute {...POLICIES_REQUIREMENT}><PolicyDetail /></PermissionRoute>} />
      </Route>

      {/* 404 */}
      <Route path="*" element={<NotFound />} />
    </Routes>
    </Suspense>
  );
}
