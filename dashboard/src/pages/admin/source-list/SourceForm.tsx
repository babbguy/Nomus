import { X } from 'lucide-react';
import Card from '../../../components/ui/Card';
import Button from '../../../components/ui/Button';
import { JURISDICTIONS } from '@nomus/shared';
import { KNOWN_CATEGORIES, type SourceFormData } from './types';

const inputClasses = 'px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:border-accent focus:ring-1 focus:ring-accent/50 outline-none transition';

// ---------------------------------------------------------------------------
// Inline create / edit form (rendered inside a source card or at the top)
// ---------------------------------------------------------------------------
export default function SourceForm({ form, setForm, editingId, formRef, error, isBuiltIn, onCancel, onSubmit }: {
  form: SourceFormData;
  setForm: React.Dispatch<React.SetStateAction<SourceFormData>>;
  editingId: string | null;
  formRef: React.RefObject<HTMLDivElement | null>;
  /** Validation or server error from the last submit. */
  error?: string | null;
  /** Editing a pure built-in source: saving a registry-controlled change customizes it. */
  isBuiltIn?: boolean;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <div ref={formRef}>
      <Card className="border border-accent/30">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {editingId ? 'Edit Source' : 'Add New Source'}
          </h3>
          <button onClick={onCancel} className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={onSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Source name"
            className={inputClasses} />
          <div>
            <input
              value={form.jurisdiction}
              onChange={(e) => setForm({ ...form, jurisdiction: e.target.value.toUpperCase() })}
              list="jurisdiction-codes"
              required
              maxLength={16}
              placeholder="Jurisdiction code (e.g. EU, US-CA)"
              aria-label="Jurisdiction code"
              className={`w-full ${inputClasses}`}
            />
            <datalist id="jurisdiction-codes">
              {Object.entries(JURISDICTIONS).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </datalist>
          </div>
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required placeholder="Source URL"
            className={`md:col-span-2 ${inputClasses}`} />
          <select value={form.parserType} onChange={(e) => setForm({ ...form, parserType: e.target.value })}
            className={inputClasses}>
            <option value="html">HTML</option>
            <option value="pdf">PDF</option>
          </select>
          <select value={form.ingestionMode} onChange={(e) => setForm({ ...form, ingestionMode: e.target.value as 'auto' | 'manual' })}
            className={inputClasses}>
            <option value="auto">Auto (scrape from URL)</option>
            <option value="manual">Manual (file upload)</option>
          </select>
          <input value={form.scrapeFrequencyHours} onChange={(e) => setForm({ ...form, scrapeFrequencyHours: parseInt(e.target.value) || 24 })}
            type="number" min={1} placeholder="Scrape frequency (hours)"
            className={inputClasses} />
          <div>
            <input
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value.toLowerCase() })}
              list="source-categories"
              required
              maxLength={64}
              placeholder="Category (e.g. ai_regulation)"
              aria-label="Category"
              className={`w-full ${inputClasses}`}
            />
            <datalist id="source-categories">
              {KNOWN_CATEGORIES.map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>
          <select value={form.tier} onChange={(e) => setForm({ ...form, tier: parseInt(e.target.value, 10) })}
            aria-label="Tier" className={inputClasses}>
            <option value={1}>Tier 1 — core AI regulation</option>
            <option value={2}>Tier 2 — data protection and privacy</option>
            <option value={3}>Tier 3 — security standards and frameworks</option>
            <option value={4}>Tier 4 — industry-specific</option>
          </select>
          <input value={form.contentSelector} onChange={(e) => setForm({ ...form, contentSelector: e.target.value })}
            placeholder={form.parserType === 'pdf' ? 'Page range (e.g. 1-72)' : 'CSS content selector (e.g. #document1)'}
            className={inputClasses} />
          <input value={form.removeSelectors} onChange={(e) => setForm({ ...form, removeSelectors: e.target.value })}
            placeholder="Remove selectors (comma-separated)"
            className={`md:col-span-2 ${inputClasses}`} />
          <div className="md:col-span-2 flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={form.needsHeadless}
                onChange={(e) => setForm({ ...form, needsHeadless: e.target.checked })}
                className="w-4 h-4 rounded border-border accent-accent"
              />
              Needs headless browser
            </label>
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="w-4 h-4 rounded border-border accent-accent"
              />
              Active
            </label>
          </div>
          {form.isActive === false && editingId && (
            <p className="md:col-span-2 text-xs text-warning">
              An inactive source is not scraped and its rules stop applying until it is reactivated.
            </p>
          )}
          {isBuiltIn && (
            <p className="md:col-span-2 text-xs text-text-muted">
              This is a built-in source. Changing its name, URL, jurisdiction, category, tier or parsing settings
              marks it Customized: startup will no longer overwrite your changes. You can restore the built-in values later.
            </p>
          )}
          {error && (
            <p className="md:col-span-2 text-xs text-danger" role="alert">{error}</p>
          )}
          <div className="md:col-span-2 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" type="submit">{editingId ? 'Update' : 'Create'}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
