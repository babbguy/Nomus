import { useNavigate } from 'react-router-dom';
import { Plus, Loader2, ScanSearch, Zap, ListChecks, X } from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import ErrorState from '../../components/ui/ErrorState';
import { useSourceList } from './source-list/useSourceList';
import ScrapeAllBanner from './source-list/ScrapeAllBanner';
import SourceForm from './source-list/SourceForm';
import SourceCard from './source-list/SourceCard';
import ErrorDetailModal from './source-list/ErrorDetailModal';

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export default function SourceList() {
  const navigate = useNavigate();
  const {
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
    formRef,
    registerFileInput,
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
  } = useSourceList();

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (loadError) {
    return <ErrorState message={loadError} onRetry={retryLoad} />;
  }

  // ---------- Inline create / edit form (shared element) ----------
  const editingSource = editingId ? sources.find((s) => s.id === editingId) : undefined;
  const editFormJsx = (
    <SourceForm
      form={form}
      setForm={setForm}
      editingId={editingId}
      formRef={formRef}
      error={formError}
      isBuiltIn={editingSource?.origin === 'registry'}
      onCancel={cancelEdit}
      onSubmit={handleSubmit}
    />
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Regulatory Sources</h1>
        <div className="flex gap-2">
          <Badge variant="accent">{sources.length} sources</Badge>
          <Button
            variant="secondary"
            onClick={handleScrapeAll}
            disabled={isScrapeActive || autoSources.length === 0}
            className="text-xs"
          >
            {scrapingAll ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            Scrape All ({autoSources.length})
          </Button>
          <Button
            variant="secondary"
            onClick={handleAudit}
            disabled={auditing}
            className="text-xs"
          >
            {auditing ? <Loader2 size={14} className="animate-spin" /> : <ScanSearch size={14} />}
            Audit All
          </Button>
          <Button variant="secondary" onClick={() => navigate('/admin/rules')} className="text-xs">
            <ListChecks size={14} />
            All Rules
          </Button>
          <Button variant="primary" onClick={openCreate} className="text-xs">
            <Plus size={14} />
            Add Source
          </Button>
        </div>
      </div>

      {actionError && (
        <Card className="mb-4 border-danger/30">
          <ErrorState compact message={actionError} />
        </Card>
      )}

      {notice && (
        <Card className="mb-4 border-accent/30">
          <div className="flex items-start justify-between gap-3 text-sm text-text-secondary" role="status">
            <span>{notice}</span>
            <button
              onClick={() => setNotice(null)}
              className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition shrink-0"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        </Card>
      )}

      {/* Scrape All progress banner */}
      <ScrapeAllBanner
        isRunning={scrapingAll}
        progress={pipelineProgress}
        sourceName={pipelineProgress?.sourceName ?? undefined}
      />

      {/* Create form (at top, only when creating new) */}
      {showCreateForm && !editingId && <div className="mb-4">{editFormJsx}</div>}

      {/* Source cards */}
      <div className="space-y-3">
        {sources.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            progress={getSourceProgress(source.id)}
            result={scrapeResults[source.id]}
            isScraping={scraping === source.id}
            isScrapeActive={isScrapeActive}
            isEditing={editingId === source.id}
            editForm={editFormJsx}
            registerFileInput={registerFileInput}
            onNavigate={(path) => navigate(path)}
            onToggle={handleToggle}
            onUploadClick={handleUploadClick}
            onFileChange={handleFileChange}
            onEditToggle={() => editingId === source.id ? cancelEdit() : openEdit(source)}
            onDelete={handleDelete}
            onRestoreDefaults={handleRestoreDefaults}
            onScrape={handleScrape}
            onReload={reload}
            onDismissResult={dismissResult}
            onShowError={showErrorModal}
          />
        ))}
      </div>

      {/* Error Detail Modal */}
      <ErrorDetailModal errorModal={errorModal} onClose={() => setErrorModal(null)} />
    </div>
  );
}
