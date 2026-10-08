export default function Spinner({ className = 'w-8 h-8' }: { className?: string }) {
  return (
    <div className={`border-2 border-accent border-t-transparent rounded-full animate-spin ${className}`} />
  );
}
