import {
  beforeEach, describe, expect, it,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

describe('analytics config flag', () => {
  beforeEach(() => resetBrowserState());

  it('does not send analytics events when analytics is disabled', async () => {
    const { initMartech, martechLazy, sendAnalyticsEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { analytics: false, personalization: false });
    await martechLazy();
    await sendAnalyticsEvent({ eventType: 'my.event' });
    await flushAsync();
    expect(alloyCalls('sendEvent').length).toBe(0);
  });

  it('does not send the automatic page view when analytics is disabled', async () => {
    const { initMartech, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { analytics: false, personalization: false });
    await martechLazy();
    await flushAsync();
    const pageViews = alloyCalls('sendEvent')
      .filter((c) => c.options.xdm?.eventType === 'web.webpagedetails.pageViews');
    expect(pageViews.length).toBe(0);
  });

  it('does not send the eager page view when analytics is disabled but personalization is on', async () => {
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
    await initMartech(TEST_WEBSDK_CONFIG, { analytics: false });
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    await martechEager();
    await flushAsync();
    // Personalization still works
    expect(alloyCalls('applyPropositions').length).toBeGreaterThan(0);
    // But no page view is tracked
    const pageViews = alloyCalls('sendEvent')
      .filter((c) => c.options.xdm?.eventType === 'web.webpagedetails.pageViews');
    expect(pageViews.length).toBe(0);
  });

  it('does not forward data layer events when analytics is disabled', async () => {
    const { initMartech, martechLazy, pushEventToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { analytics: false, personalization: false });
    await martechLazy();
    pushEventToDataLayer('my.custom.event', { foo: 'bar' });
    await flushAsync();
    expect(alloyCalls('sendEvent').length).toBe(0);
  });
});
