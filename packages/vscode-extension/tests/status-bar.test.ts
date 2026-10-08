import { describe, it, expect, beforeEach } from 'vitest';
import { StatusBarManager } from '../src/status-bar';

describe('StatusBarManager', () => {
  let statusBar: StatusBarManager;

  beforeEach(() => {
    statusBar = new StatusBarManager();
  });

  it('creates a status bar item', () => {
    expect(statusBar).toBeDefined();
  });

  it('shows "Clean" when count is 0', () => {
    statusBar.setAuthState(true);
    statusBar.update(0);
    const item = (statusBar as any).item;
    expect(item.text).toContain('Clean');
    expect(item.backgroundColor).toBeUndefined();
    expect(item.tooltip).toContain('No compliance issues');
  });

  it('shows count when there are findings', () => {
    statusBar.setAuthState(true);
    statusBar.update(5);
    const item = (statusBar as any).item;
    expect(item.text).toContain('5');
    expect(item.text).toContain('issues');
    expect(item.tooltip).toContain('5 compliance finding');
  });

  it('uses singular "issue" for count of 1', () => {
    statusBar.setAuthState(true);
    statusBar.update(1);
    const item = (statusBar as any).item;
    expect(item.text).toContain('1 issue');
    expect(item.text).not.toContain('issues');
  });

  it('sets warning background when issues found', () => {
    statusBar.setAuthState(true);
    statusBar.update(3);
    const item = (statusBar as any).item;
    expect(item.backgroundColor).toBeDefined();
    expect(item.backgroundColor.id).toBe('statusBarItem.warningBackground');
  });

  it('clears warning background when count returns to 0', () => {
    statusBar.setAuthState(true);
    statusBar.update(3);
    statusBar.update(0);
    const item = (statusBar as any).item;
    expect(item.backgroundColor).toBeUndefined();
  });

  it('ignores update when not authenticated', () => {
    const item = (statusBar as any).item;
    const textBefore = item.text;
    statusBar.update(5);
    expect(item.text).toBe(textBefore);
  });

  it('sets command to scanFile', () => {
    const item = (statusBar as any).item;
    expect(item.command).toBe('nomus.scanFile');
  });

  it('disposes cleanly', () => {
    expect(() => statusBar.dispose()).not.toThrow();
  });
});
