import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Shield, CheckCircle, XCircle, Globe, AlertTriangle, Clock, Copy, Check, X,
  RefreshCw, Download, Bell, SearchX, KeyRound, FileText,
} from 'lucide-react';
import { formatDateTime, formatRelative } from '../lib/formatters';
import {
  fetchAttestationVerification,
  subscribeToAttestation,
  type AttestationVerification,
  type VerifyFetchResult,
  type SubscribeChannel,
} from '../api/verify';

// ─────────────────────────────────────────────────────────────────
// /verify/:id serves two shareable public pages:
//   - UUID          → attestation verification (attestation reliance network)
//   - anything else → org compliance badge (legacy /verify/:orgSlug)
// Attestation IDs are randomUUID() (engine/src/core/attestation.ts);
// org slugs are human slugs, so the dispatch is unambiguous.
// ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAGE_FONT = { fontFamily: "'IBM Plex Sans', system-ui, sans-serif" };

export default function PublicVerify() {
  const { verifyId } = useParams<{ verifyId: string }>();
  if (!verifyId) {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center" style={PAGE_FONT}>
        <p className="text-sm text-[#6b7280]">No verification ID in the URL.</p>
      </div>
    );
  }
  return UUID_RE.test(verifyId)
    ? <AttestationVerifyView attestationId={verifyId} />
    : <OrgBadgeView orgSlug={verifyId} />;
}

// ─── Attestation verification view ──────────────────────

type BannerSpec = {
  color: string;       // primary text/icon color
  bg: string;          // banner background
  border: string;      // banner border
  title: string;
  Icon: typeof CheckCircle;
};

const GREEN = '#00e5a0';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GRAY = '#9ca3af';

function bannerFor(data: AttestationVerification): BannerSpec {
  // signature failure is red regardless of claimed status,
  // and green appears ONLY for status==='valid' AND signatureValid.
  if (!data.signatureValid) {
    return {
      color: RED, bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.6)',
      title: 'SIGNATURE INVALID', Icon: XCircle,
    };
  }
  switch (data.status) {
    case 'valid':
      return {
        color: GREEN, bg: 'rgba(0,229,160,0.12)', border: 'rgba(0,229,160,0.6)',
        title: 'VALID', Icon: CheckCircle,
      };
    case 'revoked':
      return {
        color: RED, bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.6)',
        title: 'REVOKED', Icon: XCircle,
      };
    case 'superseded':
      return {
        color: AMBER, bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.6)',
        title: 'SUPERSEDED', Icon: AlertTriangle,
      };
    case 'expired':
      return {
        color: AMBER, bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.6)',
        title: 'EXPIRED', Icon: Clock,
      };
  }
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function CopyButton({ copyKey, text, label, copied, onCopy }: {
  copyKey: string;
  text: string;
  label: string;
  copied: { key: string; ok: boolean } | null;
  onCopy: (key: string, text: string) => void;
}) {
  const active = copied?.key === copyKey;
  return (
    <button
      onClick={() => onCopy(copyKey, text)}
      title={label}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-[#6b7280] hover:text-[#f0f2f5] border border-[#2a2d3a] hover:border-[#3a3d4a] transition shrink-0"
    >
      {active
        ? (copied.ok ? <Check size={10} className="text-[#00e5a0]" /> : <X size={10} className="text-[#ef4444]" />)
        : <Copy size={10} />}
      {active && !copied.ok ? 'copy failed' : 'copy'}
    </button>
  );
}

function AttestationVerifyView({ attestationId }: { attestationId: string }) {
  const [result, setResult] = useState<VerifyFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(null);
  // Reference "now" captured on mount; reading the clock during render is impure.
  const [now] = useState(() => Date.now());

  const fetchVerification = useCallback(() => {
    fetchAttestationVerification(attestationId).then((r) => {
      setResult(r);
      setCheckedAt(new Date());
      setLoading(false);
    });
  }, [attestationId]);

  const load = useCallback(() => {
    setLoading(true);
    setResult(null);
    fetchVerification();
  }, [fetchVerification]);

  useEffect(() => { fetchVerification(); }, [fetchVerification]);

  function copyText(key: string, text: string) {
    navigator.clipboard.writeText(text)
      .then(() => setCopied({ key, ok: true }))
      .catch(() => setCopied({ key, ok: false }));
    setTimeout(() => setCopied(null), 2000);
  }

  function downloadRecord(data: AttestationVerification) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attestation-${data.attestationId}-verification.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ── State: loading ──
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center" style={PAGE_FONT}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[#9ca3af] border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-[#6b7280]">Checking attestation status…</p>
        </div>
      </div>
    );
  }

  // ── State: not found — an answer, not an error alert ──
  if (result?.kind === 'not_found') {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center px-4" style={PAGE_FONT}>
        <div className="text-center max-w-md">
          <SearchX size={48} className="text-[#6b7280] mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-[#f0f2f5] mb-2">No attestation with this ID</h1>
          <p className="text-sm text-[#6b7280] mb-1">
            Nomus has no record under the ID below. Check the link you were given — IDs must match exactly.
          </p>
          <p className="font-mono text-xs text-[#9ca3af] break-all mb-4">{attestationId}</p>
          <p className="text-[10px] text-[#6b7280]">
            This is a definitive lookup result, not a system error.
          </p>
        </div>
      </div>
    );
  }

  // ── State: load failure — visibly distinct from "not found" and from any verdict ──
  if (!result || result.kind === 'error') {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center px-4" style={PAGE_FONT}>
        <div className="max-w-md w-full p-6 bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.4)] rounded-xl text-center">
          <AlertTriangle size={32} className="text-[#ef4444] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#f0f2f5] mb-1">Couldn't load verification</h1>
          <p className="text-sm text-[#6b7280] mb-3">
            {result?.kind === 'error' ? result.message : 'No response received.'} This is a load failure —
            it says nothing about whether the attestation is valid or invalid.
          </p>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-[#f0f2f5] text-[#0a0b0f] hover:opacity-90 transition"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      </div>
    );
  }

  const data = result.data;
  const banner = bannerFor(data);
  const isTrusted = data.status === 'valid' && data.signatureValid;
  // outside a trusted verdict, no green anywhere — hashes/accents go neutral.
  const accent = isTrusted ? GREEN : GRAY;

  const subjectEntries = Object.entries(data.subject);
  const instructions = Array.isArray(data.verification.instructions)
    ? data.verification.instructions
    : [data.verification.instructions];

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-[#f0f2f5]" style={PAGE_FONT}>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: isTrusted ? 'rgba(0,229,160,0.15)' : 'rgba(156,163,175,0.15)' }}>
            <Shield size={16} style={{ color: accent }} />
          </div>
          <span className="text-sm text-[#6b7280]">Nomus Attestation Verification</span>
        </div>

        {/* ── STATUS BANNER (unmistakable) ── */}
        <div
          className="w-full rounded-2xl border-2 px-6 py-8 text-center mb-3"
          style={{ backgroundColor: banner.bg, borderColor: banner.border }}
        >
          <banner.Icon size={56} className="mx-auto mb-3" style={{ color: banner.color }} />
          <p className="text-3xl sm:text-4xl font-bold tracking-wide mb-2" style={{ color: banner.color }}>
            {banner.title}
          </p>

          {!data.signatureValid && (
            <p className="text-sm text-[#f0f2f5]">
              The cryptographic signature on this attestation does not verify against Nomus's
              public key. Do not rely on this record{data.status !== 'valid' ? ` (recorded status: ${data.status})` : ''}.
            </p>
          )}

          {data.signatureValid && data.status === 'valid' && (
            <p className="text-sm text-[#9ca3af]">
              Signature verified against Nomus's public key. This attestation is current — not
              revoked, superseded, or expired.
            </p>
          )}

          {data.signatureValid && data.status === 'revoked' && (
            <div className="text-sm text-[#f0f2f5] space-y-1">
              <p>
                The issuing organization revoked this attestation
                {data.revokedAt ? ` on ${formatDateTime(data.revokedAt)}` : ''}. Do not rely on it.
              </p>
              {data.revocationReason && (
                <p className="text-[#9ca3af]">Reason: <span className="text-[#f0f2f5]">{data.revocationReason}</span></p>
              )}
              <p className="text-xs text-[#6b7280]">The signature itself is authentic, but the attestation has been withdrawn.</p>
            </div>
          )}

          {data.signatureValid && data.status === 'superseded' && (
            <div className="text-sm text-[#f0f2f5] space-y-2">
              <p>A newer attestation replaces this one. Do not rely on this version.</p>
              {data.supersededBy && (
                <Link
                  to={`/verify/${data.supersededBy}`}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition hover:opacity-90"
                  style={{ backgroundColor: AMBER, color: '#0a0b0f' }}
                >
                  View the current attestation →
                </Link>
              )}
              <p className="text-xs text-[#6b7280]">The signature itself is authentic, but this record is no longer the current one.</p>
            </div>
          )}

          {data.signatureValid && data.status === 'expired' && (
            <div className="text-sm text-[#f0f2f5] space-y-1">
              <p>
                This attestation expired{data.expiresAt ? ` on ${formatDateTime(data.expiresAt)}` : ''} and
                no longer reflects a current evaluation.
              </p>
              <p className="text-xs text-[#6b7280]">The signature itself is authentic, but the attestation is past its validity window.</p>
            </div>
          )}
        </div>

        {/* Freshness */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-6 text-xs text-[#6b7280]">
          {checkedAt && <span>Status checked live at {checkedAt.toLocaleString()}</span>}
          <button
            onClick={load}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[#2a2d3a] hover:border-[#3a3d4a] hover:text-[#f0f2f5] transition"
          >
            <RefreshCw size={10} /> Re-check
          </button>
        </div>

        {/* Org + attested subject */}
        <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-4">
          <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
            <FileText size={14} /> What was attested
          </h2>
          <p className="text-sm mb-3">
            <span className="text-[#6b7280]">Issuing organization: </span>
            {data.orgDisplayName
              ? <span className="text-[#f0f2f5] font-semibold">{data.orgDisplayName}</span>
              : <span className="text-[#6b7280] italic">not published by the organization</span>}
          </p>
          {subjectEntries.length === 0 ? (
            <p className="text-xs text-[#6b7280]">No subject details were included in this attestation.</p>
          ) : (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              {subjectEntries.map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[10px] uppercase tracking-wide text-[#6b7280]">{k}</dt>
                  <dd className="text-sm text-[#f0f2f5] break-words">{renderValue(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {/* Timestamps */}
        <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-4">
          <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
            <Clock size={14} /> Timeline
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#6b7280]">Attested</p>
              <p className="text-[#f0f2f5]">{formatDateTime(data.attestedAt)}</p>
              <p className="text-[10px] text-[#6b7280]">{formatRelative(data.attestedAt)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#6b7280]">Expires</p>
              {data.expiresAt ? (
                <>
                  <p className="text-[#f0f2f5]">{formatDateTime(data.expiresAt)}</p>
                  {Date.parse(data.expiresAt) < now && (
                    <p className="text-[10px]" style={{ color: AMBER }}>already passed</p>
                  )}
                </>
              ) : (
                <p className="text-[#6b7280]">no expiry recorded</p>
              )}
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#6b7280]">Revoked</p>
              {data.revokedAt ? (
                <p style={{ color: RED }}>{formatDateTime(data.revokedAt)}</p>
              ) : (
                <p className="text-[#6b7280]">not revoked</p>
              )}
            </div>
          </div>
        </div>

        {/* Rule context */}
        <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-4">
          <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
            <Shield size={14} /> Rule context
          </h2>
          {data.ruleContext ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] uppercase tracking-wide text-[#6b7280] shrink-0">Policy state hash</span>
                <span className="font-mono text-xs break-all" style={{ color: accent }} title={data.ruleContext.stateHash}>
                  {data.ruleContext.stateHash.slice(0, 16)}…
                </span>
                <CopyButton copyKey="stateHash" text={data.ruleContext.stateHash} label="Copy full state hash" copied={copied} onCopy={copyText} />
              </div>
              <p className="text-xs text-[#6b7280]">
                Rule state computed {formatDateTime(data.ruleContext.computedAt)} ({formatRelative(data.ruleContext.computedAt)})
              </p>
            </div>
          ) : (
            <p className="text-xs text-[#6b7280]">No rule-state context was recorded for this attestation.</p>
          )}
        </div>

        {data.corporateGovernance && (
          <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-4">
            <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
              <Shield size={14} /> Corporate policy exceptions
            </h2>
            <p className="text-sm text-[#e5e7eb]">
              {data.corporateGovernance.exceptions} approved exception{data.corporateGovernance.exceptions === 1 ? '' : 's'}
              {data.corporateGovernance.revokedSince > 0 && ` (${data.corporateGovernance.revokedSince} revoked since)`},{' '}
              {data.corporateGovernance.caseClosures} closed review case{data.corporateGovernance.caseClosures === 1 ? '' : 's'},{' '}
              {data.corporateGovernance.ciRuns} CI run{data.corporateGovernance.ciRuns === 1 ? '' : 's'}.
            </p>
            <p className="text-xs mt-2" style={{ color: data.corporateGovernance.manifestSignatureValid ? '#22c55e' : '#ef4444' }}>
              {data.corporateGovernance.manifestSignatureValid ? 'Manifest signature valid' : 'Manifest signature INVALID'}.
              {' '}The records are signed separately and verify offline from the owner's evidence export.
            </p>
          </div>
        )}

        {/* Independent verification */}
        <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-4">
          <h2 className="text-sm font-semibold text-[#9ca3af] mb-3 flex items-center gap-2">
            <KeyRound size={14} /> Verify it yourself
          </h2>
          <p className="text-xs text-[#6b7280] mb-3">
            You do not have to trust this page. The signature can be checked independently with the
            key and instructions below.
          </p>
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#6b7280]">Algorithm</p>
              <p className="font-mono text-xs text-[#f0f2f5]">{data.verification.algorithm}</p>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <p className="text-[10px] uppercase tracking-wide text-[#6b7280]">Public key</p>
                <CopyButton copyKey="publicKey" text={data.verification.publicKey} label="Copy public key" copied={copied} onCopy={copyText} />
              </div>
              <p className="font-mono text-xs break-all bg-[#0f1117] border border-[#2a2d3a] rounded-lg p-2 text-[#9ca3af]">
                {data.verification.publicKey}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#6b7280]">Signed payload</p>
              <p className="text-xs text-[#9ca3af]">{data.verification.signedPayloadDescription}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#6b7280] mb-1">Instructions</p>
              <ol className="list-decimal pl-5 space-y-1 text-xs text-[#9ca3af]">
                {instructions.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </div>
          </div>
          {/* Export affordance */}
          <button
            onClick={() => downloadRecord(data)}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#2a2d3a] text-[#f0f2f5] hover:border-[#3a3d4a] hover:bg-[#0f1117] transition"
          >
            <Download size={12} /> Download verification record (JSON)
          </button>
        </div>

        {/* Subscribe */}
        <SubscribeCard attestationId={attestationId} />

        {/* Footer: schema, ID, disclaimer */}
        <div className="border-t border-[#2a2d3a] pt-4 mt-6 space-y-2">
          <p className="text-[10px] text-[#6b7280] text-center">
            Attestation <span className="font-mono">{data.attestationId}</span> · schema v{String(data.schemaVersion)}
          </p>
          <p className="text-[10px] text-[#6b7280] text-center">{data._disclaimer}</p>
          <p className="text-center text-[10px] text-[#6b7280]">Verified by Nomus</p>
        </div>
      </div>
    </div>
  );
}

// ─── Subscribe form ─────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateTarget(channel: SubscribeChannel, target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return channel === 'email' ? 'Enter an email address.' : 'Enter a webhook URL.';
  if (channel === 'email') {
    return EMAIL_RE.test(trimmed) ? null : 'That does not look like a valid email address.';
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Webhook URL must use http or https.';
    return null;
  } catch {
    return 'That does not look like a valid URL (include https://).';
  }
}

function SubscribeCard({ attestationId }: { attestationId: string }) {
  const [channel, setChannel] = useState<SubscribeChannel>('email');
  const [target, setTarget] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [subscriptionSecret, setSubscriptionSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const invalid = validateTarget(channel, target);
    setClientError(invalid);
    if (invalid) return;
    setSubmitting(true);
    try {
      const { subscriptionId: id, secret, alreadySubscribed: existing } = await subscribeToAttestation(attestationId, channel, target.trim());
      setSubscriptionId(id);
      setSubscriptionSecret(secret ?? null);
      setAlreadySubscribed(!!existing);
    } catch (err: unknown) {
      setServerError(err instanceof Error ? err.message : 'Subscription failed.');
    }
    setSubmitting(false);
  }

  async function copySecret() {
    if (!subscriptionSecret) return;
    try {
      await navigator.clipboard.writeText(subscriptionSecret);
      setSecretCopied('ok');
    } catch {
      setSecretCopied('failed');
    }
  }

  if (subscriptionId) {
    return (
      <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-4">
        <h2 className="text-sm font-semibold text-[#9ca3af] mb-2 flex items-center gap-2">
          <Bell size={14} /> Subscribed
        </h2>
        <p className="text-sm text-[#f0f2f5] mb-1">
          {alreadySubscribed
            ? `This ${channel} target was already subscribed; it will be notified if this attestation's status changes.`
            : `You'll be notified via ${channel} if this attestation's status changes.`}
        </p>
        {alreadySubscribed && channel === 'webhook' && (
          <p className="text-xs text-[#6b7280] mb-1">
            The signing secret was shown once, when the subscription was created; it cannot be shown again.
          </p>
        )}
        <p className="text-xs text-[#6b7280]">
          Subscription ID: <span className="font-mono text-[#9ca3af]">{subscriptionId}</span> — keep
          this to reference or cancel the subscription.
        </p>
        {subscriptionSecret && (
          <div className="mt-3 border border-amber-700/60 bg-amber-950/30 rounded-lg p-3">
            <p className="text-xs font-semibold text-amber-400 mb-1">
              Save this signing secret now — it is shown only once and cannot be retrieved again.
            </p>
            <p className="text-xs text-[#9ca3af] mb-2">
              Notification deliveries are signed with HMAC-SHA256 over{' '}
              <span className="font-mono">timestamp.body</span> in the{' '}
              <span className="font-mono">X-Nomus-Signature-V2</span> header. Verify with this secret.
            </p>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono text-[#f0f2f5] bg-[#0f1117] rounded px-2 py-1 break-all">
                {subscriptionSecret}
              </code>
              <button
                type="button"
                onClick={copySecret}
                className="text-xs px-2 py-1 rounded border border-[#2a2d3a] text-[#9ca3af] hover:text-[#f0f2f5] shrink-0"
              >
                {secretCopied === 'ok' ? 'Copied' : secretCopied === 'failed' ? 'Copy failed — select manually' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-[#161922] border border-[#2a2d3a] rounded-xl p-5 mb-4">
      <h2 className="text-sm font-semibold text-[#9ca3af] mb-1 flex items-center gap-2">
        <Bell size={14} /> Get notified if this attestation's status changes
      </h2>
      <p className="text-xs text-[#6b7280] mb-3">
        If it is later revoked, superseded, or expires, Nomus will notify you.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
        <select
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value as SubscribeChannel);
            setClientError(null);
            setServerError(null);
          }}
          className="bg-[#0f1117] border border-[#2a2d3a] rounded-lg px-3 py-2 text-sm text-[#f0f2f5] shrink-0"
        >
          <option value="email">Email</option>
          <option value="webhook">Webhook</option>
        </select>
        <input
          value={target}
          onChange={(e) => { setTarget(e.target.value); setClientError(null); }}
          placeholder={channel === 'email' ? 'you@company.com' : 'https://example.com/hooks/nomus'}
          type={channel === 'email' ? 'email' : 'url'}
          className="flex-1 min-w-0 bg-[#0f1117] border border-[#2a2d3a] rounded-lg px-3 py-2 text-sm text-[#f0f2f5] placeholder-[#4b5563]"
        />
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-[#f0f2f5] text-[#0a0b0f] hover:opacity-90 transition disabled:opacity-50 shrink-0"
        >
          {submitting ? 'Subscribing…' : 'Notify me'}
        </button>
      </form>
      {clientError && <p className="mt-2 text-xs" style={{ color: AMBER }}>{clientError}</p>}
      {serverError && (
        <div className="mt-2 px-3 py-2 bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.4)] rounded-lg">
          <p className="text-xs text-[#f0f2f5]">Subscription failed: {serverError}</p>
          <p className="text-[10px] text-[#6b7280] mt-0.5">
            Your request was not saved — the message above is the server's own response.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Legacy org badge view (/verify/:orgSlug) ───────────────────

interface BadgeData {
  org: { name: string; slug: string };
  score: number;
  jurisdictions: string[];
  lastAttestation: string | null;
  rulesMonitored: number;
}

function OrgBadgeView({ orgSlug }: { orgSlug: string }) {
  const [data, setData] = useState<BadgeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/v1/badge/${orgSlug}`)
      .then((r) => {
        if (!r.ok) throw new Error('Badge not found or not public');
        return r.json();
      })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [orgSlug]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#00e5a0] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center" style={PAGE_FONT}>
        <div className="text-center">
          <XCircle size={48} className="text-[#ef4444] mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-[#f0f2f5] mb-2">Badge Not Found</h1>
          <p className="text-sm text-[#6b7280]">{error || 'This organization has not enabled their public compliance badge.'}</p>
        </div>
      </div>
    );
  }

  const scoreColor = data.score >= 80 ? '#00e5a0' : data.score >= 50 ? '#f59e0b' : '#ef4444';

  return (
    <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center px-4" style={PAGE_FONT}>
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-8 h-8 rounded-lg bg-[rgba(0,229,160,0.15)] flex items-center justify-center">
            <Shield size={16} className="text-[#00e5a0]" />
          </div>
          <span className="text-sm text-[#6b7280]">Nomus Compliance Verification</span>
        </div>

        {/* Card */}
        <div className="bg-[#161922] border border-[#2a2d3a] rounded-2xl p-8 text-center" style={{ boxShadow: '0 0 30px rgba(0, 229, 160, 0.1)' }}>
          <CheckCircle size={48} className="mx-auto mb-4" style={{ color: scoreColor }} />

          <h1 className="text-2xl font-semibold text-[#f0f2f5] mb-1">{data.org.name}</h1>
          <p className="text-sm text-[#6b7280] mb-6">AI Compliance Monitored by Nomus</p>

          {/* Score */}
          <div className="mb-6">
            <p className="text-5xl font-bold" style={{ color: scoreColor }}>{data.score}</p>
            <p className="text-xs text-[#6b7280] mt-1">Compliance Score</p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div>
              <p className="text-lg font-semibold text-[#f0f2f5]">{data.rulesMonitored}</p>
              <p className="text-[10px] text-[#6b7280]">Rules Monitored</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-[#f0f2f5]">{data.jurisdictions.length}</p>
              <p className="text-[10px] text-[#6b7280]">Jurisdictions</p>
            </div>
            <div>
              <p className="text-sm text-[#f0f2f5]">
                {data.lastAttestation
                  ? new Date(data.lastAttestation).toLocaleDateString()
                  : '—'}
              </p>
              <p className="text-[10px] text-[#6b7280]">Last Check</p>
            </div>
          </div>

          {/* Jurisdictions */}
          {data.jurisdictions.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5 mb-6">
              {data.jurisdictions.map((j) => (
                <span key={j} className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-[#0f1117] text-[#9ca3af] border border-[#2a2d3a]">
                  <Globe size={8} /> {j}
                </span>
              ))}
            </div>
          )}

          <div className="border-t border-[#2a2d3a] pt-4">
            <p className="text-[10px] text-[#6b7280]">
              This badge indicates automated regulatory monitoring status.
              It does not constitute legal certification or advice.
            </p>
          </div>
        </div>

        <p className="text-center text-[10px] text-[#6b7280] mt-6">
          Verified by Nomus
        </p>
      </div>
    </div>
  );
}
