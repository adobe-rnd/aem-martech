import {
  beforeEach, describe, expect, it,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

describe('custom data layer instance name', () => {
  beforeEach(() => resetBrowserState(['myDataLayer']));

  it('initializes the adobeDataLayer array that ACDL processes', async () => {
    const { initMartech } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      personalization: false,
      dataLayerInstanceName: 'myDataLayer',
    });
    expect(Array.isArray(window.adobeDataLayer)).toBe(true);
  });

  it('does not lose events pushed before the data layer is loaded', async () => {
    const { initMartech, martechLazy, pushEventToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      personalization: false,
      dataLayerInstanceName: 'myDataLayer',
    });
    pushEventToDataLayer('early.event', { foo: 'early' });
    await martechLazy();
    await flushAsync();
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'early.event');
    expect(evt).toBeTruthy();
  });

  it('forwards events pushed after the data layer is loaded', async () => {
    const { initMartech, martechLazy, pushEventToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      personalization: false,
      dataLayerInstanceName: 'myDataLayer',
    });
    await martechLazy();
    pushEventToDataLayer('late.event', { foo: 'late' });
    await flushAsync();
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'late.event');
    expect(evt).toBeTruthy();
  });

  it('includes the data layer state on eager events', async () => {
    window.__alloyMockHandlers = { sendEvent: () => ({ propositions: [] }) };
    const { initMartech, martechEager, pushToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { dataLayerInstanceName: 'myDataLayer' });
    pushToDataLayer({ pageContext: { pageName: 'home' } });
    await martechEager();
    const [fetch] = alloyCalls('sendEvent');
    expect(fetch.options.xdm.pageContext).toEqual({ pageName: 'home' });
  });
});

describe('data layer state on events', () => {
  beforeEach(() => resetBrowserState());

  it('merges all queued entries into eager events, not just the first one', async () => {
    window.__alloyMockHandlers = { sendEvent: () => ({ propositions: [] }) };
    const { initMartech, martechEager, pushToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    pushToDataLayer({ first: 1 });
    pushToDataLayer({ second: 2 });
    await martechEager();
    const [fetch] = alloyCalls('sendEvent');
    expect(fetch.options.xdm.first).toBe(1);
    expect(fetch.options.xdm.second).toBe(2);
  });

  it('does not break event sending when the data layer is disabled', async () => {
    window.__alloyMockHandlers = { sendEvent: () => ({ propositions: [] }) };
    const { initMartech, sendAnalyticsEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { dataLayer: false });
    await sendAnalyticsEvent({ eventType: 'my.event' });
    await flushAsync();
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'my.event');
    expect(evt).toBeTruthy();
  });

  it('does not mutate the data layer event payload when forwarding', async () => {
    const { initMartech, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    await martechLazy();
    const payload = { event: 'my.event', xdm: { foo: 'bar' } };
    window.adobeDataLayer.push(payload);
    await flushAsync();
    expect(payload.event).toBe('my.event');
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'my.event');
    expect(evt).toBeTruthy();
  });
});

describe('block data layer instrumentation', () => {
  beforeEach(() => resetBrowserState());

  it('generates ids for block elements without css classes', async () => {
    document.body.innerHTML = '<main><div data-block-data-layer=\'{"foo":1}\'></div></main>';
    const { initMartech, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    await martechLazy();
    const el = document.querySelector('[data-block-data-layer]');
    expect(el.id).toBe('1');
  });

  it('falls back to empty data on invalid JSON', async () => {
    document.body.innerHTML = '<main><div class="hero" data-block-data-layer="not-json"></div></main>';
    const { initMartech, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    await martechLazy();
    const el = document.querySelector('.hero');
    expect(el.id).toBe('1');
    expect(window.adobeDataLayer.getState().blocks['1']).toEqual({});
  });
});
