import {
  beforeEach, describe, expect, it,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

describe('initMartech', () => {
  beforeEach(() => resetBrowserState());

  it('sets up the alloy command queue and data layer globals', async () => {
    const { initMartech } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    expect(window.__alloyNS).toContain('alloy');
    expect(typeof window.alloy).toBe('function');
    expect(Array.isArray(window.adobeDataLayer)).toBe(true);
  });

  it('loads and configures alloy eagerly when personalization is enabled', async () => {
    const { initMartech } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    const [configure] = alloyCalls('configure');
    expect(configure).toBeTruthy();
    expect(configure.options.datastreamId).toBe(TEST_WEBSDK_CONFIG.datastreamId);
    expect(configure.options.orgId).toBe(TEST_WEBSDK_CONFIG.orgId);
    expect(configure.options.defaultConsent).toBe('pending');
  });

  it('does not load alloy eagerly when personalization is disabled', async () => {
    const { initMartech } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    expect(window.alloy.calls).toBeUndefined();
  });

  it('supports a custom alloy instance name', async () => {
    const { initMartech } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { alloyInstanceName: 'myAlloy' });
    expect(window.__alloyNS).toContain('myAlloy');
    expect(alloyCalls('configure', 'myAlloy').length).toBe(1);
    delete window.myAlloy;
  });
});

describe('martechEager (performance-optimized personalization)', () => {
  beforeEach(() => resetBrowserState());

  it('fetches propositions eagerly and applies them once blocks are decorated', async () => {
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? {
          propositions: [{
            id: 'p1',
            scope: '__view__',
            scopeDetails: {},
            items: [{ schema: 'https://ns.adobe.com/personalization/dom-action' }],
          }],
        }
        : {}),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    await martechEager();

    const [fetch] = alloyCalls('sendEvent');
    expect(fetch.options.type).toBe('decisioning.propositionFetch');
    expect(fetch.options.renderDecisions).toBe(false);
    expect(alloyCalls('applyPropositions').length).toBeGreaterThan(0);

    await flushAsync();
    const pageView = alloyCalls('sendEvent')
      .find((c) => c.options.xdm?.eventType === 'web.webpagedetails.pageViews');
    expect(pageView).toBeTruthy();
    expect(pageView.options.xdm._experience.decisioning.propositions).toEqual([
      { id: 'p1', scope: '__view__', scopeDetails: {} },
    ]);
  });

  it('includes custom decision scopes in the eager fetch', async () => {
    window.__alloyMockHandlers = { sendEvent: () => ({ propositions: [] }) };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { decisionScopes: ['my-scope'] });
    await martechEager();
    const [fetch] = alloyCalls('sendEvent');
    expect(fetch.options.personalization.decisionScopes).toEqual(['my-scope']);
  });
});

describe('martechLazy (analytics without personalization)', () => {
  beforeEach(() => resetBrowserState());

  it('loads alloy lazily and sends a page view', async () => {
    const { initMartech, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    await martechLazy();
    await flushAsync();
    const pageView = alloyCalls('sendEvent')
      .find((c) => c.options.xdm?.eventType === 'web.webpagedetails.pageViews');
    expect(pageView).toBeTruthy();
  });

  it('does not send a page view when trackPageView is disabled', async () => {
    const { initMartech, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false, trackPageView: false });
    await martechLazy();
    await flushAsync();
    const pageView = alloyCalls('sendEvent')
      .find((c) => c.options.xdm?.eventType === 'web.webpagedetails.pageViews');
    expect(pageView).toBeUndefined();
  });

  it('forwards data layer events to alloy', async () => {
    const { initMartech, martechLazy, pushEventToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    await martechLazy();
    pushEventToDataLayer('my.custom.event', { foo: 'bar' });
    await flushAsync();
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'my.custom.event');
    expect(evt).toBeTruthy();
    expect(evt.options.xdm.foo).toBe('bar');
  });

  it('honors the shouldProcessEvent filter', async () => {
    const { initMartech, martechLazy, pushEventToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      personalization: false,
      shouldProcessEvent: (payload) => payload.event !== 'ignored.event',
    });
    await martechLazy();
    pushEventToDataLayer('ignored.event', { foo: 'bar' });
    pushEventToDataLayer('kept.event', { foo: 'baz' });
    await flushAsync();
    const events = alloyCalls('sendEvent').map((c) => c.options.xdm?.eventType);
    expect(events).not.toContain('ignored.event');
    expect(events).toContain('kept.event');
  });

  it('queues data layer events fired before alloy is configured', async () => {
    const { initMartech, martechLazy, pushEventToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    pushEventToDataLayer('early.event', { foo: 'early' });
    await martechLazy();
    await flushAsync();
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'early.event');
    expect(evt).toBeTruthy();
  });

  it('registers block data layer elements with generated ids', async () => {
    document.body.innerHTML = '<main><div class="hero" data-block-data-layer=\'{"foo":1}\'></div></main>';
    const { initMartech, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    await martechLazy();
    const el = document.querySelector('.hero');
    expect(el.id).toBe('1');
    const state = window.adobeDataLayer.getState();
    expect(state.blocks['1']).toEqual({ foo: 1 });
  });
});

describe('updateUserConsent', () => {
  beforeEach(() => resetBrowserState());

  it('sends consent to alloy once configured', async () => {
    const { initMartech, updateUserConsent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await updateUserConsent({
      collect: true, marketing: true, personalize: true, share: false,
    });
    const [consent] = alloyCalls('setConsent');
    expect(consent).toBeTruthy();
    const { value } = consent.options.consent[0];
    expect(value.collect.val).toBe('y');
    expect(value.personalize.content.val).toBe('y');
    expect(value.share.val).toBe('n');
    expect(value.marketing.any.val).toBe('y');
  });

  it('queues consent until alloy is configured', async () => {
    const { initMartech, updateUserConsent, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    // The promise only resolves once alloy is configured and the consent is applied
    const promise = updateUserConsent({ collect: true });
    expect(window.alloy.calls).toBeUndefined();
    await martechLazy();
    await promise;
    expect(alloyCalls('setConsent').length).toBe(1);
  });
});

describe('sendEvent / sendAnalyticsEvent', () => {
  beforeEach(() => resetBrowserState());

  it('proxies raw events to alloy', async () => {
    const { initMartech, sendEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await sendEvent({ xdm: { eventType: 'raw.event' } });
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'raw.event');
    expect(evt).toBeTruthy();
  });

  it('cleans up empty data mappings before sending', async () => {
    const { initMartech, sendAnalyticsEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await sendAnalyticsEvent({ eventType: 'analytics.event' });
    await flushAsync();
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'analytics.event');
    expect(evt).toBeTruthy();
    expect(evt.options.data).toBeUndefined();
  });

  it('lets the project onBeforeEventSend veto events', async () => {
    const { initMartech, sendAnalyticsEvent } = await importMartech();
    await initMartech(
      { ...TEST_WEBSDK_CONFIG, onBeforeEventSend: (payload) => payload.xdm?.eventType !== 'vetoed.event' },
      {},
    );
    await sendAnalyticsEvent({ eventType: 'vetoed.event' });
    await flushAsync();
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'vetoed.event');
    expect(evt).toBeUndefined();
    expect(window.alloy.cancelledCalls.length).toBe(1);
  });
});
