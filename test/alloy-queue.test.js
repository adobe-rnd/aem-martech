import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

describe('alloy command queue stub', () => {
  beforeEach(() => resetBrowserState());

  it('queues commands issued before the SDK is loaded', async () => {
    const { initMartech, martechLazy, sendEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    // The stub is in place, the real SDK is not loaded yet
    const pending = sendEvent({ xdm: { eventType: 'queued.event' } });
    await martechLazy();
    await pending;
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'queued.event');
    expect(evt).toBeTruthy();
  });

  it('does not lose commands whose deferred push races with the SDK load', async () => {
    const { initMartech, martechLazy, sendEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    // The stub defers queue pushes with a setTimeout. Use fake timers to force the
    // adversarial interleaving: the SDK loads (and drains the still-empty queue) before
    // the deferred push runs, so without the fix the command lands in a queue that is
    // never read again and its promise never settles.
    vi.useFakeTimers();
    let pending;
    try {
      pending = sendEvent({ xdm: { eventType: 'raced.event' } });
      await martechLazy();
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    await pending;
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'raced.event');
    expect(evt).toBeTruthy();
  });

  it('settles the command promise with the SDK result', async () => {
    window.__alloyMockHandlers = { sendEvent: () => ({ ok: true }) };
    const { initMartech, martechLazy, sendEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    const pending = sendEvent({ xdm: { eventType: 'result.event' } });
    await martechLazy();
    await flushAsync();
    await expect(pending).resolves.toEqual({ ok: true });
  });
});
