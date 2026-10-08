import { JURISDICTIONS } from '@nomus/shared';

export default function JurisdictionTag({ code }: { code: string }) {
  const label = JURISDICTIONS[code as keyof typeof JURISDICTIONS] ?? code;
  return (
    <span className="inline-flex items-center px-2 py-0.5 text-xs font-mono rounded bg-surface-hover text-text-secondary border border-border">
      {code}
      <span className="ml-1.5 text-text-muted hidden sm:inline">· {label}</span>
    </span>
  );
}
