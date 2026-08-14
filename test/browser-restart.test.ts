import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_TARGETS,
  resolveBrowserTargets,
  formatBrowserLabel,
  restartBrowser,
} from '../src/core/browser-restart.js';

describe('resolveBrowserTargets — configurable, never hard-coded', () => {
  it('returns the built-in Arc/Chrome/Edge defaults when config is empty/undefined', () => {
    const ids = resolveBrowserTargets(undefined).map(t => t.bundleId);
    expect(ids).toEqual(DEFAULT_BROWSER_TARGETS.map(t => t.bundleId));
    expect(resolveBrowserTargets([]).map(t => t.label)).toEqual(['Arc', 'Chrome', 'Edge']);
  });

  it('overrides an existing default by bundleId (label/openArgs) without dropping others', () => {
    const out = resolveBrowserTargets([
      { bundleId: 'company.thebrowser.Browser', label: 'Arc 浏览器', openArgs: ['--foo'] },
    ]);
    const arc = out.find(t => t.bundleId === 'company.thebrowser.Browser')!;
    expect(arc.label).toBe('Arc 浏览器');
    expect(arc.openArgs).toEqual(['--foo']);
    // Chrome + Edge still present + unchanged.
    expect(out.map(t => t.bundleId)).toContain('com.google.Chrome');
    expect(out.map(t => t.bundleId)).toContain('com.microsoft.edgemac');
  });

  it('appends a brand-new browser with no code change', () => {
    const out = resolveBrowserTargets([
      { bundleId: 'com.brave.Browser', label: 'Brave' },
    ]);
    expect(out.find(t => t.bundleId === 'com.brave.Browser')?.label).toBe('Brave');
    expect(out).toHaveLength(4);
  });

  it('drops a default when config disables it (enabled:false)', () => {
    const out = resolveBrowserTargets([{ bundleId: 'com.microsoft.edgemac', enabled: false }]);
    expect(out.map(t => t.bundleId)).not.toContain('com.microsoft.edgemac');
    expect(out.map(t => t.bundleId)).toContain('company.thebrowser.Browser');
  });

  it('ignores garbage entries (missing/blank bundleId, non-objects)', () => {
    const out = resolveBrowserTargets(['nope', 42, {}, { bundleId: '   ' }, null]);
    expect(out.map(t => t.bundleId)).toEqual(DEFAULT_BROWSER_TARGETS.map(t => t.bundleId));
  });
});

describe('formatBrowserLabel', () => {
  it('renders GB for >= 1024 MB and MB otherwise', () => {
    expect(formatBrowserLabel('Arc', 6202)).toBe('♻️ 重启 Arc · 6.1 GB');
    expect(formatBrowserLabel('Chrome', 512)).toBe('♻️ 重启 Chrome · 512 MB');
  });
  it('omits the memory suffix when unknown/zero', () => {
    expect(formatBrowserLabel('Edge')).toBe('♻️ 重启 Edge');
    expect(formatBrowserLabel('Edge', 0)).toBe('♻️ 重启 Edge');
  });
});

describe('restartBrowser — bundleId quit + relaunch, never force-kill', () => {
  it('quits, waits for exit, then relaunches with openArgs', async () => {
    const calls: Array<[string, string[]]> = [];
    let alive = true;
    const result = await restartBrowser(
      { bundleId: 'com.google.Chrome', openArgs: ['--restore-last-session'] },
      {
        run: async (file, args) => { calls.push([file, args]); return { stdout: '' }; },
        isRunning: async () => alive,
        sleep: async () => { alive = false; }, // process exits after first poll
        now: (() => { let t = 0; return () => (t += 100); })(),
      },
    );
    expect(result).toEqual({ ok: true, quit: true, relaunched: true });
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0][1].join(' ')).toContain('id "com.google.Chrome" to quit');
    const open = calls.find(c => c[0] === 'open')!;
    expect(open[1]).toEqual(['-b', 'com.google.Chrome', '--args', '--restore-last-session']);
  });

  it('does NOT relaunch (and reports) when the browser refuses to quit within the window', async () => {
    const calls: Array<[string, string[]]> = [];
    const result = await restartBrowser(
      { bundleId: 'company.thebrowser.Browser' },
      {
        run: async (file, args) => { calls.push([file, args]); return { stdout: '' }; },
        isRunning: async () => true, // never exits (unsaved dialog)
        sleep: async () => {},
        now: (() => { let t = 0; return () => (t += 5_000); })(),
        quitTimeoutMs: 12_000,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.relaunched).toBe(false);
    expect(calls.some(c => c[0] === 'open')).toBe(false); // never relaunched
    expect(calls.some(c => c[1].includes('-9') || c[1].includes('kill'))).toBe(false); // never force-killed
  });

  it('reports quit-failure without relaunching', async () => {
    const result = await restartBrowser(
      { bundleId: 'x.y.z' },
      { run: async () => { throw new Error('no such app'); }, isRunning: async () => false, sleep: async () => {} },
    );
    expect(result.ok).toBe(false);
    expect(result.quit).toBe(false);
    expect(result.error).toContain('quit failed');
  });
});
