import { useState } from 'react';
import { User, Save, Eye, EyeOff } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { useAuthStore } from '../../stores/authStore';
import api from '../../api/client';

export default function Profile() {
  const { user, checkSession } = useAuthStore();

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [savingInfo, setSavingInfo] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  async function handleSaveInfo() {
    if (!name.trim() || !email.trim()) return;
    setSavingInfo(true);
    setNameMsg(null);
    try {
      const payload: Record<string, string> = {};
      if (name.trim() !== (user?.name ?? '')) payload.name = name.trim();
      if (email.trim() !== (user?.email ?? '')) payload.email = email.trim();
      if (Object.keys(payload).length === 0) {
        setNameMsg({ type: 'ok', text: 'No changes to save.' });
        setSavingInfo(false);
        return;
      }
      await api.patch('/auth/profile', payload);
      await checkSession();
      setNameMsg({ type: 'ok', text: 'Name updated.' });
    } catch (e: unknown) {
      const axiosErr = e as { response?: { data?: { error?: string } } };
      setNameMsg({ type: 'err', text: axiosErr?.response?.data?.error ?? 'Failed to update name.' });
    }
    setSavingInfo(false);
  }

  async function handleChangePassword() {
    setPwMsg(null);
    if (!currentPassword || !newPassword) return;
    if (newPassword !== confirmPassword) {
      setPwMsg({ type: 'err', text: 'New passwords do not match.' });
      return;
    }
    if (newPassword.length < 8) {
      setPwMsg({ type: 'err', text: 'Password must be at least 8 characters.' });
      return;
    }
    setSavingPw(true);
    try {
      await api.patch('/auth/profile', { currentPassword, newPassword });
      setPwMsg({ type: 'ok', text: 'Password changed successfully.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e: unknown) {
      const axiosErr = e as { response?: { data?: { error?: string } } };
      setPwMsg({ type: 'err', text: axiosErr?.response?.data?.error ?? 'Failed to change password.' });
    }
    setSavingPw(false);
  }

  const inputCls =
    'w-full text-sm bg-surface border border-border rounded-lg px-3 py-2 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition';

  return (
    <div className="p-6 animate-page">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-accent-dim">
          <User size={20} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Profile</h1>
          <p className="text-sm text-text-secondary">Manage your account details</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Name */}
      <Card>
        <h2 className="text-sm font-semibold text-text-secondary mb-4">Personal Info</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              placeholder="Your email"
            />
          </div>
          {nameMsg && (
            <p className={`text-xs ${nameMsg.type === 'ok' ? 'text-success' : 'text-danger'}`}>
              {nameMsg.text}
            </p>
          )}
          <Button onClick={handleSaveInfo} disabled={savingInfo || !name.trim() || !email.trim()} className="text-xs">
            <Save size={14} /> {savingInfo ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </Card>

      {/* Password */}
      <Card className="h-fit">
        <h2 className="text-sm font-semibold text-text-secondary mb-4">Change Password</h2>
        <div className="space-y-4 max-w-md">
          <div>
            <label className="block text-xs text-text-muted mb-1">Current Password</label>
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className={inputCls}
                placeholder="Enter current password"
              />
              <button
                type="button"
                onClick={() => setShowCurrent(!showCurrent)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition"
              >
                {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">New Password</label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputCls}
                placeholder="Min 8 characters"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition"
              >
                {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={inputCls}
              placeholder="Re-enter new password"
            />
          </div>
          {pwMsg && (
            <p className={`text-xs ${pwMsg.type === 'ok' ? 'text-success' : 'text-danger'}`}>
              {pwMsg.text}
            </p>
          )}
          <Button
            onClick={handleChangePassword}
            disabled={savingPw || !currentPassword || !newPassword || !confirmPassword}
            className="text-xs"
          >
            {savingPw ? 'Changing...' : 'Change Password'}
          </Button>
        </div>
      </Card>
      </div>
    </div>
  );
}
