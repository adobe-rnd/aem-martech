import {
  beforeEach, describe, expect, it,
} from 'vitest';
import { importMartech, resetBrowserState, TEST_WEBSDK_CONFIG } from './helpers.js';

describe('initRumTracking', () => {
  beforeEach(() => resetBrowserState());

  it('uses sampleRUM.always when available', async () => {
    const { initMartech, initRumTracking } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    const listeners = {};
    const sampleRUM = {
      always: { on: (ev, cb) => { (listeners[ev] ||= []).push(cb); } },
    };
    const track = initRumTracking(sampleRUM);
    const seen = [];
    track('cwv', (data) => seen.push(data));
    listeners.cwv.forEach((cb) => cb({ checkpoint: 'cwv', cwv: { lcp: 1200 } }));
    expect(seen).toEqual([{ checkpoint: 'cwv', cwv: { lcp: 1200 } }]);
  });

  it('filters document rum events by checkpoint in the fallback path', async () => {
    const { initMartech, initRumTracking } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    const track = initRumTracking({});
    const seen = [];
    track('cwv', (data) => seen.push(data));
    document.dispatchEvent(new CustomEvent('rum', { detail: { checkpoint: 'cwv', foo: 1 } }));
    document.dispatchEvent(new CustomEvent('rum', { detail: { checkpoint: 'click' } }));
    document.dispatchEvent(new CustomEvent('rum', {}));
    expect(seen).toEqual([{ checkpoint: 'cwv', foo: 1 }]);
  });

  it('passes the event detail to the callback, not the raw DOM event', async () => {
    const { initMartech, initRumTracking } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    const track = initRumTracking({});
    const seen = [];
    track('click', (data) => seen.push(data));
    document.dispatchEvent(new CustomEvent('rum', { detail: { checkpoint: 'click', target: 'a' } }));
    expect(seen[0]).not.toBeInstanceOf(Event);
    expect(seen[0].target).toBe('a');
  });

  it('loads the RUM enhancer when requested', async () => {
    const { initMartech, initRumTracking } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    initRumTracking({ baseURL: 'https://rum.hlx.page/' }, { withRumEnhancer: true });
    const script = document.head.querySelector('script[src*="helix-rum-enhancer"]');
    expect(script).toBeTruthy();
  });
});
