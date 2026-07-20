import {
  beforeEach, describe, expect, it,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

const DOM_ACTION_SCHEMA = 'https://ns.adobe.com/personalization/dom-action';
const JSON_SCHEMA = 'https://ns.adobe.com/personalization/json-content-item';

const proposition = (id, schema = DOM_ACTION_SCHEMA) => ({
  id, scope: '__view__', scopeDetails: {}, items: [{ schema }],
});

const displayEvents = () => alloyCalls('sendEvent')
  .filter((c) => ['web.webpagedetails.pageViews', 'decisioning.propositionDisplay']
    .includes(c.options.xdm?.eventType));

describe('proposition application robustness', () => {
  beforeEach(() => resetBrowserState());

  it('applies propositions on pages without a main element', async () => {
    document.body.innerHTML = '<div data-block-status="loaded"></div>';
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? { propositions: [proposition('p1')] }
        : {}),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    expect(alloyCalls('applyPropositions').length).toBe(1);
  });

  it('serializes concurrent proposition applications', async () => {
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    let inFlight = 0;
    let maxInFlight = 0;
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? { propositions: [proposition('p1')] }
        : {}),
      applyPropositions: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        inFlight -= 1;
        // Nothing gets rendered, so the propositions stay pending
        return { propositions: [] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    // Trigger a few DOM updates in quick succession
    document.body.appendChild(document.createElement('div'));
    document.body.appendChild(document.createElement('div'));
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(alloyCalls('applyPropositions').length).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
  });

  it('stops watching the DOM once all propositions are applied', async () => {
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? { propositions: [proposition('p1')] }
        : {}),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    const count = alloyCalls('applyPropositions').length;
    document.body.appendChild(document.createElement('div'));
    await flushAsync();
    expect(alloyCalls('applyPropositions').length).toBe(count);
  });

  it('does not apply propositions that arrive after the timeout', async () => {
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    let resolveFetch;
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? new Promise((resolve) => { resolveFetch = resolve; })
        : {}),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalizationTimeout: 50 });
    await martechEager();
    // The response arrives after the page already gave up waiting
    resolveFetch({ propositions: [proposition('p1')] });
    await flushAsync();
    expect(alloyCalls('applyPropositions').length).toBe(0);
  });
});

describe('display reporting accuracy', () => {
  beforeEach(() => resetBrowserState());

  it('only reports rendered dom-action propositions and non-dom-action propositions', async () => {
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? { propositions: [proposition('p1'), proposition('p2'), proposition('p3', JSON_SCHEMA)] }
        : {}),
      // Only p1 gets rendered; p2 has no matching DOM element
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    const [pageView] = displayEvents();
    expect(pageView).toBeTruthy();
    const ids = pageView.options.xdm._experience.decisioning.propositions.map((p) => p.id);
    expect(ids).toEqual(['p1', 'p3']);
  });

  it('reports late-rendered propositions with a follow-up display event', async () => {
    // No decorated blocks yet, so nothing can be applied at first
    document.body.innerHTML = '<main><div class="block"></div></main>';
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? { propositions: [proposition('p1')] }
        : {}),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    // The initial page view has nothing to report
    const [pageView] = displayEvents();
    expect(pageView.options.xdm._experience).toBeUndefined();

    // The block is now decorated and the proposition applied
    document.querySelector('.block').dataset.blockStatus = 'loaded';
    await flushAsync();
    expect(alloyCalls('applyPropositions').length).toBe(1);
    const display = alloyCalls('sendEvent')
      .find((c) => c.options.xdm?.eventType === 'decisioning.propositionDisplay');
    expect(display).toBeTruthy();
    expect(display.options.xdm._experience.decisioning.propositions.map((p) => p.id))
      .toEqual(['p1']);
  });

  it('does not report the same proposition twice', async () => {
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? { propositions: [proposition('p1')] }
        : {}),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    // Trigger more DOM updates after everything was reported
    document.body.appendChild(document.createElement('div'));
    await flushAsync();
    const reported = displayEvents()
      .flatMap((c) => c.options.xdm._experience?.decisioning.propositions || [])
      .filter((p) => p.id === 'p1');
    expect(reported.length).toBe(1);
  });
});
