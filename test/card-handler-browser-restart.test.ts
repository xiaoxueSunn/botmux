import { beforeEach, describe, expect, it, vi } from 'vitest';

const { restartBrowserMock } = vi.hoisted(() => ({ restartBrowserMock: vi.fn() }));

vi.mock('../src/core/browser-restart.js', async () => {
  const actual = await vi.importActual<typeof import('../src/core/browser-restart.js')>('../src/core/browser-restart.js');
  return { ...actual, restartBrowser: (...a: any[]) => restartBrowserMock(...a) };
});

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bot-registry.js')>('../src/bot-registry.js');
  return { ...actual, getOwnerOpenId: vi.fn(() => 'ou_owner') };
});

import { handleCardAction } from '../src/im/lark/card-handler.js';
import {
  OVERLOAD_ACTION_RESTART_BROWSER,
  type OverloadCardState,
} from '../src/core/host-overload-alert.js';
import {
  _resetOverloadNoncesForTest,
  registerOverloadNonce,
} from '../src/im/lark/overload-nonce.js';

function stateWithBrowsers(nonce: string): OverloadCardState {
  return {
    nonce, load15: 6.9, cpu: 12, mem: 0.99, reasons: ['memory'],
    stopped: 0, idle: 0, cleanedN: -1, suspendedN: -1,
    browsers: [
      { bundleId: 'company.thebrowser.Browser', label: 'Arc', memMB: 6202 },
      { bundleId: 'com.google.Chrome', label: 'Chrome', memMB: 1659 },
    ],
    restartedBrowsers: [],
  };
}

const deps = {
  activeSessions: new Map(),
  sessionReply: vi.fn(async () => 'om_reply'),
  lastRepoScan: new Map(),
} as any;

beforeEach(() => {
  _resetOverloadNoncesForTest();
  restartBrowserMock.mockReset();
});

describe('overload card — restart browser action', () => {
  it('restarts the chosen browser (owner) and marks only it done', async () => {
    restartBrowserMock.mockResolvedValue({ ok: true, quit: true, relaunched: true });
    const st = stateWithBrowsers('nb1');
    registerOverloadNonce(st.nonce);

    const result = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: OVERLOAD_ACTION_RESTART_BROWSER, bundleId: 'company.thebrowser.Browser', st: JSON.stringify(st) } },
    }, deps, 'cli_alert');

    expect(restartBrowserMock).toHaveBeenCalledTimes(1);
    expect(restartBrowserMock.mock.calls[0][0].bundleId).toBe('company.thebrowser.Browser');
    const s = JSON.stringify(result);
    expect(s).toContain('✓ 已重启 Arc');
    expect(s).toContain('♻️ 重启 Chrome'); // Chrome still clickable
  });

  it('blocks a non-owner', async () => {
    const st = stateWithBrowsers('nb2');
    registerOverloadNonce(st.nonce);
    const result = await handleCardAction({
      operator: { open_id: 'ou_intruder' },
      action: { value: { action: OVERLOAD_ACTION_RESTART_BROWSER, bundleId: 'com.google.Chrome', st: JSON.stringify(st) } },
    }, deps, 'cli_alert');
    expect(restartBrowserMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('仅管理员可操作');
  });

  it('is one-shot per (nonce, bundleId): a second Arc click is rejected, but Chrome still works', async () => {
    restartBrowserMock.mockResolvedValue({ ok: true, quit: true, relaunched: true });
    const st = stateWithBrowsers('nb3');
    registerOverloadNonce(st.nonce);
    const arcClick = () => handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: OVERLOAD_ACTION_RESTART_BROWSER, bundleId: 'company.thebrowser.Browser', st: JSON.stringify(st) } },
    }, deps, 'cli_alert');

    await arcClick();
    const second = await arcClick();
    expect(JSON.stringify(second)).toContain('已点过');
    expect(restartBrowserMock).toHaveBeenCalledTimes(1);

    const chrome = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: OVERLOAD_ACTION_RESTART_BROWSER, bundleId: 'com.google.Chrome', st: JSON.stringify(st) } },
    }, deps, 'cli_alert');
    expect(JSON.stringify(chrome)).toContain('✓ 已重启 Chrome');
    expect(restartBrowserMock).toHaveBeenCalledTimes(2);
  });

  it('releases the claim on a failed restart so the owner can retry', async () => {
    restartBrowserMock.mockResolvedValueOnce({ ok: false, quit: false, relaunched: false, error: '浏览器未在超时内退出' });
    const st = stateWithBrowsers('nb4');
    registerOverloadNonce(st.nonce);
    const click = () => handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: OVERLOAD_ACTION_RESTART_BROWSER, bundleId: 'company.thebrowser.Browser', st: JSON.stringify(st) } },
    }, deps, 'cli_alert');

    const first = await click();
    expect(JSON.stringify(first)).toContain('未在超时内退出');
    restartBrowserMock.mockResolvedValueOnce({ ok: true, quit: true, relaunched: true });
    const retry = await click();
    expect(JSON.stringify(retry)).toContain('✓ 已重启 Arc');
    expect(restartBrowserMock).toHaveBeenCalledTimes(2);
  });
});
