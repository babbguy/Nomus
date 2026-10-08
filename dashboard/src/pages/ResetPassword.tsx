import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Shield } from 'lucide-react';
import api from '../api/client';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Reset failed. The link may have expired.');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center px-4">
        <div className="glass rounded-xl p-6 max-w-sm text-center">
          <p className="text-text-primary mb-2">Invalid reset link</p>
          <Link to="/forgot-password" className="text-sm text-accent hover:underline">Request a new one</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-xl bg-accent-dim flex items-center justify-center mb-4 glow-accent">
            <Shield className="w-7 h-7 text-accent" />
          </div>
          <h1 className="text-2xl font-semibold text-text-primary">New Password</h1>
        </div>

        <div className="glass rounded-xl p-6 space-y-4">
          {error && (
            <div className="bg-danger/10 border border-danger/30 text-danger text-sm rounded-lg px-4 py-2">{error}</div>
          )}

          {done ? (
            <div className="text-center py-4">
              <p className="text-sm text-text-primary mb-3">Password reset successfully!</p>
              <Link to="/login" className="inline-block px-6 py-2 bg-accent hover:bg-accent-hover text-surface-base font-semibold rounded-lg transition text-sm">
                Sign In
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-text-secondary mb-1.5">New Password</label>
                <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition" placeholder="Min 8 characters" />
              </div>
              <div>
                <label htmlFor="confirm" className="block text-sm font-medium text-text-secondary mb-1.5">Confirm Password</label>
                <input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition" placeholder="••••••••" />
              </div>
              <button type="submit" disabled={loading}
                className="w-full py-2.5 bg-accent hover:bg-accent-hover text-surface-base font-semibold rounded-lg transition disabled:opacity-50">
                {loading ? 'Resetting...' : 'Reset Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
