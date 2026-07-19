import {
  beforeEach, describe, expect, it,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

const pageViewCalls = () => alloyCalls('sendEvent')
  .filter((c) => c.options.xdm?.eventType === 'web.webpagedetails.pageViews');

describe('non-performance-optimized personalization', () => {
  beforeEach(() => resetBrowserState());

  it('restores the page visibility when the personalization request fails', async () => {
    window.__alloyMockHandlers = {
      sendEvent: (options) => {
        if (options.renderDecisions) {
          throw new Error('blocked by ad blocker');
        }
        return {};
      },
    };
    const { initMartech, martechEager, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { performanceOptimized: false });
    await martechEager();
    expect(document.body.style.visibility).toBe('hidden');
    await martechLazy();
    expect(document.body.style.visibility).toBe('');
  });

  it('restores the page visibility when the personalization request hangs', async () => {
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.renderDecisions ? new Promise(() => {}) : {}),
    };
    const { initMartech, martechEager, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      performanceOptimized: false,
      personalizationTimeout: 50,
    });
    await martechEager();
    expect(document.body.style.visibility).toBe('hidden');
    await martechLazy();
    expect(document.body.style.visibility).toBe('');
  });

  it('still tracks the page view when the personalization request fails', async () => {
    window.__alloyMockHandlers = {
      sendEvent: (options) => {
        if (options.renderDecisions) {
          throw new Error('blocked');
        }
        return {};
      },
    };
    const { initMartech, martechEager, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { performanceOptimized: false });
    await martechEager();
    await martechLazy();
    await flushAsync();
    expect(pageViewCalls().length).toBe(1);
  });
});

describe('performance-optimized personalization', () => {
  beforeEach(() => resetBrowserState());

  it('still tracks the page view when the eager fetch times out', async () => {
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? new Promise(() => {})
        : {}),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalizationTimeout: 50 });
    await martechEager();
    await flushAsync();
    const [pageView] = pageViewCalls();
    expect(pageView).toBeTruthy();
    expect(pageView.options.xdm._experience).toBeUndefined();
  });

  it('still tracks the page view when the response has no propositions', async () => {
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch' ? {} : {}),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    const [pageView] = pageViewCalls();
    expect(pageView).toBeTruthy();
    expect(pageView.options.xdm._experience).toBeUndefined();
  });

  it('sends no event at all when page views are tracked elsewhere and there are no propositions', async () => {
    window.__alloyMockHandlers = { sendEvent: () => ({ propositions: [] }) };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { trackPageView: false });
    await martechEager();
    await flushAsync();
    expect(pageViewCalls().length).toBe(0);
    const displays = alloyCalls('sendEvent')
      .filter((c) => c.options.xdm?.eventType === 'decisioning.propositionDisplay');
    expect(displays.length).toBe(0);
  });

  it('reports displayed propositions without a page view when trackPageView is disabled', async () => {
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
    await initMartech(TEST_WEBSDK_CONFIG, { trackPageView: false });
    await martechEager();
    await flushAsync();
    expect(pageViewCalls().length).toBe(0);
    const [display] = alloyCalls('sendEvent')
      .filter((c) => c.options.xdm?.eventType === 'decisioning.propositionDisplay');
    expect(display).toBeTruthy();
    expect(display.options.xdm._experience.decisioning.propositions).toEqual([
      { id: 'p1', scope: '__view__', scopeDetails: {} },
    ]);
  });
});

describe('configuration matrix', () => {
  beforeEach(() => resetBrowserState());

  it('loads alloy and tracks the page view with personalization and performance optimization both disabled', async () => {
    const { initMartech, martechEager, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      personalization: false,
      performanceOptimized: false,
    });
    await martechEager();
    // The page is never hidden when personalization is disabled
    expect(document.body.style.visibility).toBe('');
    await martechLazy();
    await flushAsync();
    expect(alloyCalls('configure').length).toBe(1);
    expect(pageViewCalls().length).toBe(1);
  });
});
