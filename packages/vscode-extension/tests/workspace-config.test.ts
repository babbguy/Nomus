import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const { runScan, runScanFromContents } = vi.hoisted(() => ({ runScan: vi.fn(), runScanFromContents: vi.fn() }));
vi.mock('@nomus/scanner', () => ({ runScan, runScanFromContents }));

import { scanWorkspace, scanCurrentFile } from '../src/commands';

const EMPTY_RESULT = {
  findings: [],
  fileCount: 1,
  importCount: 0,
  capabilities: [],
  status: 'pass',
  counts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
};

const HEALTHCARE_YML = [
  'nomus:',
  '  jurisdictions: [EU, US-FED]',
  '  sector: healthcare',
  '  data_types: [phi, personal_data]',
  '  ignore: ["legacy/**"]',
  '',
].join('\n');

const settings: Record<string, unknown> = {
  jurisdictions: ['EU', 'US-FED'],
  apiUrl: 'http://engine.local:3100',
  failOn: 'medium',
};

const ws = vscode.workspace as any;
const win = vscode.window as any;

function stubs() {
  return {
    diagnostics: { setFindings: vi.fn() } as any,
    findings: { setFindings: vi.fn() } as any,
    statusBar: { update: vi.fn() } as any,
  };
}

describe('workspace .nomus.yml precedence', () => {
  let dir: string;
  let originalGetConfiguration: unknown;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nomus-ext-'));
    runScan.mockReset().mockResolvedValue(EMPTY_RESULT);
    runScanFromContents.mockReset().mockResolvedValue(EMPTY_RESULT);
    originalGetConfiguration = ws.getConfiguration;
    ws.getConfiguration = () => ({
      get: <T>(key: string, fallback?: T) => (key in settings ? settings[key] : fallback),
    });
    ws.workspaceFolders = [{ uri: { fsPath: dir } }];
    win.showErrorMessage = vi.fn();
  });

  afterEach(() => {
    ws.getConfiguration = originalGetConfiguration;
    ws.workspaceFolders = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('scanWorkspace passes sector, data_types and ignore from .nomus.yml', async () => {
    writeFileSync(join(dir, '.nomus.yml'), HEALTHCARE_YML);
    const s = stubs();

    await scanWorkspace(s.diagnostics, s.findings, s.statusBar, async () => 'dw_test_key');

    expect(runScan).toHaveBeenCalledOnce();
    const opts = runScan.mock.calls[0][0];
    expect(opts.config).toMatchObject({
      jurisdictions: ['EU', 'US-FED'],
      sector: 'healthcare',
      data_types: ['phi', 'personal_data'],
      ignore: ['legacy/**'],
      api_key: 'dw_test_key',
      api_url: 'http://engine.local:3100',
    });
  });

  it('scanWorkspace uses the file jurisdictions rather than the setting', async () => {
    writeFileSync(
      join(dir, '.nomus.yml'),
      'nomus:\n  jurisdictions: [US-FED]\n  sector: healthcare\n',
    );
    const s = stubs();

    await scanWorkspace(s.diagnostics, s.findings, s.statusBar, async () => 'dw_test_key');

    const opts = runScan.mock.calls[0][0];
    expect(opts.jurisdictions).toEqual(['US-FED']);
    expect(opts.config.jurisdictions).toEqual(['US-FED']);
  });

  it('scanWorkspace falls back to settings when there is no config file', async () => {
    const s = stubs();

    await scanWorkspace(s.diagnostics, s.findings, s.statusBar, async () => 'dw_test_key');

    const opts = runScan.mock.calls[0][0];
    expect(opts.jurisdictions).toEqual(['EU', 'US-FED']);
    expect(opts.config).toEqual({
      jurisdictions: ['EU', 'US-FED'],
      api_key: 'dw_test_key',
      api_url: 'http://engine.local:3100',
    });
    expect(opts.config.sector).toBeUndefined();
  });

  it('scanWorkspace reports an invalid .nomus.yml instead of falling back', async () => {
    writeFileSync(join(dir, '.nomus.yml'), 'nomus:\n  sector: healthcare\n');
    const s = stubs();

    await scanWorkspace(s.diagnostics, s.findings, s.statusBar, async () => 'dw_test_key');

    expect(runScan).not.toHaveBeenCalled();
    expect(win.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('jurisdictions'));
  });

  it('scanCurrentFile passes sector and data_types from .nomus.yml', async () => {
    writeFileSync(join(dir, '.nomus.yml'), HEALTHCARE_YML);
    const s = stubs();
    const doc: any = {
      languageId: 'typescript',
      fileName: join(dir, 'app.ts'),
      uri: { fsPath: join(dir, 'app.ts') },
      getText: () => "import Anthropic from '@anthropic-ai/sdk';\n",
    };

    await scanCurrentFile(s.diagnostics, s.findings, s.statusBar, doc, async () => 'dw_test_key');

    expect(runScanFromContents).toHaveBeenCalledOnce();
    const opts = runScanFromContents.mock.calls[0][1];
    expect(opts.config).toMatchObject({
      sector: 'healthcare',
      data_types: ['phi', 'personal_data'],
      api_key: 'dw_test_key',
    });
  });

  it('scanCurrentFile falls back to settings without a config file', async () => {
    const s = stubs();
    const doc: any = {
      languageId: 'typescript',
      fileName: join(dir, 'app.ts'),
      uri: { fsPath: join(dir, 'app.ts') },
      getText: () => "import Anthropic from '@anthropic-ai/sdk';\n",
    };

    await scanCurrentFile(s.diagnostics, s.findings, s.statusBar, doc, async () => 'dw_test_key');

    const opts = runScanFromContents.mock.calls[0][1];
    expect(opts.config.jurisdictions).toEqual(['EU', 'US-FED']);
    expect(opts.config.sector).toBeUndefined();
  });
});
