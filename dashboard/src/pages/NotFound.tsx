import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-surface-base flex items-center justify-center px-4">
      <div className="text-center">
        <img src="/logo-stacked.svg" alt="Nomus" className="w-40 mx-auto mb-8" />
        <h1 className="text-6xl font-bold text-text-primary mb-2">404</h1>
        <p className="text-text-secondary mb-6">Page not found</p>
        <Link
          to="/"
          className="inline-flex px-6 py-2.5 bg-accent hover:bg-accent-hover text-accent-text font-semibold rounded-lg transition"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
