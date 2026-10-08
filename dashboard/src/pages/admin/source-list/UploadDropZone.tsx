import { useRef, useState } from 'react';
import { Loader2, AlertCircle, UploadCloud } from 'lucide-react';
import api from '../../../api/client';
import { readFileForUpload } from './uploadFile';

// ---------------------------------------------------------------------------
// Upload drop zone for manual sources
// ---------------------------------------------------------------------------
export default function UploadDropZone({ sourceId, onUploaded }: { sourceId: string; onUploaded: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function processFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      // Detect PDF vs text by magic bytes + extension. PDFs are base64-encoded,
      // text files are sent as-is. Fixes the bug where `file.text()` corrupted
      // PDF binary on ISO 27001 / ISO 42001 / PCI-DSS uploads.
      const { content, contentType } = await readFileForUpload(file);
      if (content.length < 100) {
        setUploadError(`File too short (${content.length} chars). Is this the right file?`);
        setUploading(false);
        return;
      }
      await api.post(`/sources/upload-content/${sourceId}`, {
        content,
        contentType,
        filename: file.name,
      });
      onUploaded();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      const localErr = err as Error;
      setUploadError(axiosErr?.response?.data?.error ?? localErr.message ?? 'Upload failed');
    }
    setUploading(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) processFile(file);
  }

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      <div
        className={`relative flex flex-col items-center justify-center gap-2 py-4 px-4 rounded-lg border-2 border-dashed transition-colors cursor-pointer
          ${dragging ? 'border-accent bg-accent/5' : 'border-border/60 hover:border-accent/50 hover:bg-surface-hover/50'}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 size={20} className="text-accent animate-spin" />
        ) : (
          <UploadCloud size={20} className={dragging ? 'text-accent' : 'text-text-muted'} />
        )}
        <p className="text-xs text-text-muted text-center">
          {uploading ? 'Uploading...' : 'Drop file here or click to browse'}
        </p>
        <p className="text-[10px] text-text-muted/70">.html, .htm, .pdf, .txt</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".html,.htm,.pdf,.txt"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>
      {uploadError && (
        <p className="text-[11px] text-danger mt-1.5 flex items-center gap-1">
          <AlertCircle size={10} />
          {uploadError}
        </p>
      )}
    </div>
  );
}
