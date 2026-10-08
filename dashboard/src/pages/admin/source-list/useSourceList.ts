import { useCallback, useEffect, useRef, useState } from 'react';
import { usePipelineStore } from '../../../stores/pipelineStore';
import type { PipelineProgress } from '../../../stores/pipelineStore';
import api from '../../../api/client';
import {
  getSources, createSource, updateSource, deleteSource, restoreSourceDefaults,
  type RegulatorySource,
} from '../../../api/sources';
import { triggerScrape, triggerScrapeAll, triggerAudit } from '../../../api/admin';
import { apiErrorMessage } from '../../../lib/errors';
import { readFileForUpload } from './uploadFile';
import {
  emptyForm, JURISDICTION_CODE_RE, CATEGORY_RE,
  type SourceFormData, type ScrapeResult, type ErrorDetail,
} from './types';

/**
 * Container hook for the Regulatory Sources admin page. Owns all source
 * state, the pipeline SSE wiring, and every fetch/mutation handler so that
 * SourceList stays a lean orchestrator.
 */
export function useSourceList() {
  const [sources, setSources] = useState<RegulatorySource[]>([]);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState<string | null>(null);
  const [scrapingAll, setScrapingAll] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [scrapeResults, setScrapeResults] = useState<Record<string, ScrapeResult>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [form, setForm] = useState<SourceFormData>(emptyForm);
  const [errorModal, setErrorModal] = useState<ErrorDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pipelineProgress = usePipelineStore((s) => s.progress);
  const formRef = useRef<HTMLDivElement>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const reload = useCallback(async () => {
    try {
      const r = await getSources();
      setSources(r.sources);
      setLoadError(null);
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to refresh sources'));
    }
  }, []);

  useEffect(() => {
    getSources()
      .then((r) => setSources(r.sources))
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load regulatory sources')))
      .finally(() => setLoading(false));
  }, []);

  // Auto-reload sources and show result when pipeline completes via SSE
  useEffect(() => {
    if (pipelineProgress?.step === 4 && pipelineProgress.sourceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing external SSE state to local state
      setScrapeResults((prev) => ({
        ...prev,
        [pipelineProgress.sourceId!]: {
          status: 'completed',
          rulesCreated: pipelineProgress.rulesCreated,
          rulesUpdated: pipelineProgress.rulesUpdated,
          durationMs: pipelineProgress.durationMs,
        },
      }));
      const timer = setTimeout(reload, 2000);
      return () => clearTimeout(timer);
    }
  }, [pipelineProgress?.step, pipelineProgress?.sourceId, pipelineProgress?.durationMs, pipelineProgress?.rulesCreated, pipelineProgress?.rulesUpdated, reload]);

  // Determine if any scrape is active (either local API call or SSE progress)
  const isScrapeActive = scraping !== null || scrapingAll || (pipelineProgress != null && pipelineProgress.step < 4);

  const retryLoad = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    getSources()
      .then((r) => setSources(r.sources))
      .catch((err) => setLoadError(apiErrorMessage(err, 'Failed to load regulatory sources')))
      .finally(() => setLoading(false));
  }, []);

  async function handleScrape(sourceId: string) {
    setScraping(sourceId);
    setScrapeResults((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    try {
      await triggerScrape(sourceId);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
      const status = axiosErr?.response?.status;
      if (status && status >= 400) {
        setScrapeResults((prev) => ({
          ...prev,
          [sourceId]: { status: 'error', error: axiosErr?.response?.data?.error ?? 'Failed to start pipeline' },
        }));
      }
    }
    setScraping(null);
  }

  async function handleScrapeAll() {
    setScrapingAll(true);
    setActionError(null);
    try {
      await triggerScrapeAll();
      // Pipeline runs in background — progress comes via SSE
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to start Scrape All pipeline'));
      setScrapingAll(false);
    }
    // We'll leave scrapingAll=true until user dismisses or all sources complete
    // For now, set a generous timeout to auto-clear
    setTimeout(() => setScrapingAll(false), 600_000); // 10 min max
  }

  async function handleAudit() {
    setAuditing(true);
    setActionError(null);
    try {
      await triggerAudit(true);
      setTimeout(reload, 5000);
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Failed to start source audit'));
    }
    setAuditing(false);
  }

  function dismissResult(sourceId: string) {
    setScrapeResults((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setShowCreateForm(true);
    // Scroll to top where create form will appear
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openEdit(source: RegulatorySource) {
    setEditingId(source.id);
    setShowCreateForm(false);
    setFormError(null);
    const config = source.selectorConfig ?? {};
    setForm({
      name: source.name,
      jurisdiction: source.jurisdiction,
      url: source.url,
      parserType: source.parserType,
      contentSelector: source.parserType === 'pdf'
        ? ((config as Record<string, unknown>).pageRange as string | undefined) ?? ''
        : ((config as Record<string, unknown>).contentSelector as string | undefined) ?? '',
      removeSelectors: Array.isArray((config as Record<string, unknown>).removeSelectors)
        ? ((config as Record<string, unknown>).removeSelectors as string[]).join(', ')
        : '',
      scrapeFrequencyHours: source.scrapeFrequencyHours,
      ingestionMode: source.ingestionMode ?? 'auto',
      category: source.category ?? 'ai_regulation',
      tier: source.tier ?? 1,
      needsHeadless: source.needsHeadless ?? false,
      isActive: source.isActive ?? true,
    });
    // Scroll will happen via useEffect below
  }

  // Scroll to inline edit form when editingId changes
  useEffect(() => {
    if (editingId && formRef.current) {
      // Small delay to let the DOM update
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }, [editingId]);

  function cancelEdit() {
    setEditingId(null);
    setShowCreateForm(false);
    setFormError(null);
    setForm(emptyForm);
  }

  /**
   * Selector config for the form values. When editing, keys the form does not
   * expose are preserved so saving never silently drops parsing settings.
   */
  function buildSelectorConfig(existing: Record<string, unknown>): Record<string, unknown> {
    const config: Record<string, unknown> = { ...existing };
    const selector = form.contentSelector.trim();
    const removals = form.removeSelectors.split(',').map((s) => s.trim()).filter(Boolean);
    delete config.contentSelector;
    delete config.pageRange;
    if (selector) config[form.parserType === 'pdf' ? 'pageRange' : 'contentSelector'] = selector;
    if (removals.length > 0) config.removeSelectors = removals;
    else delete config.removeSelectors;
    return config;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const jurisdiction = form.jurisdiction.trim().toUpperCase();
    if (!JURISDICTION_CODE_RE.test(jurisdiction)) {
      setFormError('Jurisdiction must be 1-16 characters: letters, digits or "-" (e.g. EU, US-CA).');
      return;
    }
    const category = form.category.trim();
    if (!CATEGORY_RE.test(category)) {
      setFormError('Category must be lowercase letters, digits or "_" (e.g. ai_regulation).');
      return;
    }
    const original = editingId ? sources.find((s) => s.id === editingId) : undefined;
    const selectorConfig = buildSelectorConfig((original?.selectorConfig ?? {}) as Record<string, unknown>);

    const payload = {
      name: form.name.trim(),
      jurisdiction,
      url: form.url.trim(),
      parserType: form.parserType,
      selectorConfig,
      scrapeFrequencyHours: form.scrapeFrequencyHours,
      ingestionMode: form.ingestionMode,
      category,
      tier: form.tier,
      needsHeadless: form.needsHeadless,
      isActive: form.isActive,
    };

    try {
      if (original) {
        const result = await updateSource(original.id, payload);
        if (result.rulesRetired) setNotice(`"${result.name}" deactivated: its ${result.rulesRetired} rule(s) no longer apply.`);
        else if (result.rulesRestored) setNotice(`"${result.name}" reactivated: ${result.rulesRestored} rule(s) apply again.`);
        else setNotice(null);
      } else {
        await createSource(payload);
        setNotice(null);
      }
    } catch (err) {
      // Keep the form open so nothing the admin typed is lost.
      setFormError(apiErrorMessage(err, 'Failed to save the source'));
      return;
    }
    cancelEdit();
    await reload();
  }

  /** Run a source mutation, surface failures, and report rule effects. */
  async function runSourceAction(action: () => Promise<string | null>, fallback: string) {
    setActionError(null);
    try {
      setNotice(await action());
    } catch (err) {
      setActionError(apiErrorMessage(err, fallback));
    }
    await reload();
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Deactivate source "${name}"?\n\nIt will stop being scraped and its rules will stop applying. You can reactivate it later to restore them.`)) return;
    await runSourceAction(async () => {
      const r = await deleteSource(id);
      return `"${name}" deactivated: ${r.rulesRetired} rule(s) no longer apply.`;
    }, 'Failed to deactivate the source');
  }

  async function handleToggle(id: string, isActive: boolean) {
    const source = sources.find((s) => s.id === id);
    const name = source?.name ?? 'this source';
    if (isActive && !confirm(`Deactivate source "${name}"?\n\nIt will stop being scraped and its rules will stop applying.`)) return;
    await runSourceAction(async () => {
      const r = await updateSource(id, { isActive: !isActive });
      if (isActive) return `"${name}" deactivated: ${r.rulesRetired ?? 0} rule(s) no longer apply.`;
      return `"${name}" reactivated: ${r.rulesRestored ?? 0} rule(s) apply again.`;
    }, 'Failed to update the source');
  }

  async function handleRestoreDefaults(id: string, name: string) {
    if (!confirm(`Restore built-in defaults for "${name}"?\n\nIts name, URL, jurisdiction, category, tier and parsing settings return to the built-in values, and startup will keep it in sync with the registry again. Your edits to those fields are lost.`)) return;
    await runSourceAction(async () => {
      await restoreSourceDefaults(id);
      return `"${name}" restored to the built-in defaults.`;
    }, 'Failed to restore built-in defaults');
  }

  function handleUploadClick(sourceId: string) {
    fileInputRefs.current[sourceId]?.click();
  }

  const registerFileInput = useCallback((sourceId: string, el: HTMLInputElement | null) => {
    fileInputRefs.current[sourceId] = el;
  }, []);

  async function handleFileChange(sourceId: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      // Detect PDF vs text by magic bytes + extension. See readFileForUpload.
      const { content, contentType } = await readFileForUpload(file);
      if (content.length < 100) {
        setScrapeResults((prev) => ({ ...prev, [sourceId]: { status: 'error', error: `File too short (${content.length} chars). Is this the right file?` } }));
        return;
      }

      await api.post(`/sources/upload-content/${sourceId}`, {
        content,
        contentType,
        filename: file.name,
      });
      await reload();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      const localErr = err as Error;
      setScrapeResults((prev) => ({
        ...prev,
        [sourceId]: { status: 'error', error: axiosErr?.response?.data?.error ?? localErr.message ?? 'Upload failed' },
      }));
    }
  }

  function getSourceProgress(sourceId: string): PipelineProgress | null {
    if (!pipelineProgress) return null;
    if (pipelineProgress.sourceId === sourceId) return pipelineProgress;
    return null;
  }

  function showErrorModal(source: RegulatorySource, error: string, stepReached?: number) {
    setErrorModal({
      sourceName: source.name,
      sourceUrl: source.url,
      sourceId: source.id,
      error,
      stepReached,
      timestamp: new Date().toISOString(),
      consecutiveFailures: source.consecutiveFailures ?? 0,
    });
  }

  const autoSources = sources.filter((s) => (s.ingestionMode ?? 'auto') === 'auto' && s.isActive);

  return {
    // state
    sources,
    loading,
    scraping,
    scrapingAll,
    auditing,
    scrapeResults,
    editingId,
    showCreateForm,
    form,
    setForm,
    errorModal,
    setErrorModal,
    loadError,
    actionError,
    formError,
    notice,
    setNotice,
    pipelineProgress,
    isScrapeActive,
    autoSources,
    // refs
    formRef,
    fileInputRefs,
    registerFileInput,
    // handlers
    reload,
    retryLoad,
    handleScrape,
    handleScrapeAll,
    handleAudit,
    dismissResult,
    openCreate,
    openEdit,
    cancelEdit,
    handleSubmit,
    handleDelete,
    handleToggle,
    handleRestoreDefaults,
    handleUploadClick,
    handleFileChange,
    getSourceProgress,
    showErrorModal,
  };
}
