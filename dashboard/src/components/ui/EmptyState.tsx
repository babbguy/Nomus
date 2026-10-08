import { Inbox } from 'lucide-react';

export default function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-text-muted">
      <Inbox size={40} className="mb-4 opacity-40" />
      <p className="text-sm font-medium text-text-secondary">{title}</p>
      {description && <p className="text-xs mt-1">{description}</p>}
    </div>
  );
}
