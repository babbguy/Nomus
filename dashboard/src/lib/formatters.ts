const INVALID = '—'; // em dash — explicit "no valid date" marker

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return INVALID;
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return INVALID;
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function formatRelative(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return INVALID;
  const diff = Date.now() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Format a NUMERIC(18,8) decimal string from the API ("1500.00000000") as
 * dollars ("$1,500.00") without converting it to a float.
 */
export function formatDecimalUsd(value: string | null | undefined): string {
  if (value == null || !/^-?\d+(\.\d+)?$/.test(value.trim())) return '—';
  const [rawInt, rawFrac = ''] = value.trim().split('.');
  const negative = rawInt.startsWith('-');
  const int = (negative ? rawInt.slice(1) : rawInt).replace(/^0+(?=\d)/, '');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${(rawFrac + '00').slice(0, 2)}`;
}
