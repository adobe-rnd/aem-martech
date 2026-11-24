import {
  beforeEach, describe, expect, it, vi,
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

describe('holding personalized sections', () => {
  beforeEach(() => {
    resetBrowserState();
    // these tests say when the Web SDK has rendered an offer
    window.__alloyMockAutoRender = false;
  });

  const HTML_SCHEMA = 'https://ns.adobe.com/personalization/html-content-item';
  const HOLD_ATTRIBUTE = 'data-martech-personalization-pending';
  const offer = (id, scope) => ({
    id, scope, scopeDetails: {}, items: [{ schema: HTML_SCHEMA, data: { content: '<p>offer</p>' } }],
  });
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const isHeld = (el) => el.hasAttribute(HOLD_ATTRIBUTE) && el.hasAttribute('inert');
  const setup = (sections) => {
    document.body.innerHTML = `<main>${sections.map((scope) => `<div class="section" data-section-status="loaded" data-mbox="${scope}"><p>default ${scope}</p></div>`).join('')}</main>`;
    return sections.map((scope) => document.querySelector(`[data-mbox="${scope}"]`));
  };
  // what the Web SDK tells its monitors once it has rendered (or failed to render) an offer
  const notify = (status, payload) => (window.__alloyMonitors || [])
    .forEach((m) => m.onContentRendering?.({ instanceName: 'alloy', status, payload }));
  // renders an offer the way alloy's setHtml does, then reports it
  const render = (id, scope) => {
    document.querySelector(`[data-mbox="${scope}"]`).innerHTML = '<p>offer</p>';
    notify('rendering-succeeded', { [scope]: [{ id, scope }] });
  };
  const fetchReturns = (propositions) => (options) => (
    options.type === 'decisioning.propositionFetch' ? { propositions } : {});

  it('does not hold anything by default', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = { sendEvent: fetchReturns([]) };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    const eager = martechEager();
    expect(isHeld(hero)).toBe(false);
    await eager;
  });

  it('keeps a section hidden until its offer is rendered', async () => {
    const [hero, banner] = setup(['hero', 'banner']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        render('p1', 'hero');
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    const eager = martechEager();
    expect(isHeld(hero)).toBe(true);
    expect(isHeld(banner)).toBe(true);
    await eager;
    // no offer for the banner: it shows as soon as Target answers
    expect(isHeld(banner)).toBe(false);
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('offer');
  });

  it('waits for the Web SDK to finish rendering, not for it to report the offer applied', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        setTimeout(() => render('p1', 'hero'), 50);
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await wait(20);
    // the project decorating the section meanwhile does not count as the offer
    const wrapper = document.createElement('div');
    wrapper.append(...hero.children);
    hero.append(wrapper);
    await flushAsync();
    expect(isHeld(hero)).toBe(true);
    await wait(60);
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('offer');
  });

  it('shows the default content when the offer fails to render', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        notify('rendering-failed', { propositionDetails: { id: 'p1', scope: 'hero' } });
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('default hero');
  });

  it('shows the default content when Target does not answer in time', async () => {
    const [hero] = setup(['hero']);
    let resolveFetch;
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? new Promise((resolve) => { resolveFetch = resolve; })
        : {}),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, personalizationTimeout: 50,
    });
    await martechEager();
    expect(isHeld(hero)).toBe(false);
    resolveFetch({ propositions: [offer('p1', 'hero')] });
    await flushAsync();
    expect(alloyCalls('applyPropositions').length).toBe(0);
    expect(hero.textContent).toBe('default hero');
  });

  it('shows everything and drops pending offers after the hold timeout', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      // the offer's target never becomes ready
      applyPropositions: () => ({ propositions: [] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, personalizationHoldTimeout: 100,
    });
    await martechEager();
    expect(isHeld(hero)).toBe(true);
    await wait(120);
    expect(isHeld(hero)).toBe(false);
    const calls = alloyCalls('applyPropositions').length;
    document.body.appendChild(document.createElement('div'));
    await flushAsync();
    expect(alloyCalls('applyPropositions').length).toBe(calls);
  });

  it('stopPersonalization shows what is held and stops applying offers', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => ({ propositions: [] }),
    };
    const { initMartech, martechEager, stopPersonalization } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    expect(isHeld(hero)).toBe(true);
    stopPersonalization();
    expect(isHeld(hero)).toBe(false);
    const calls = alloyCalls('applyPropositions').length;
    document.body.appendChild(document.createElement('div'));
    await flushAsync();
    expect(alloyCalls('applyPropositions').length).toBe(calls);
  });

  it('waits for beforePersonalizedReveal before showing the offer', async () => {
    const [hero] = setup(['hero']);
    let finishDecorating;
    const beforePersonalizedReveal = vi.fn(() => new Promise((resolve) => {
      finishDecorating = resolve;
    }));
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        render('p1', 'hero');
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, beforePersonalizedReveal,
    });
    await martechEager();
    await flushAsync();
    expect(beforePersonalizedReveal).toHaveBeenCalledWith([hero]);
    expect(isHeld(hero)).toBe(true);
    finishDecorating();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
  });

  it('keeps markup that replaces a section hidden until its offer is in place', async () => {
    setup(['hero']);
    let replacement;
    let finishDecorating;
    const beforePersonalizedReveal = vi.fn(() => new Promise((resolve) => {
      finishDecorating = resolve;
    }));
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        // replaceHtml: the offer's markup takes the section's place
        replacement = document.createElement('div');
        replacement.innerHTML = '<p>offer</p>';
        document.querySelector('[data-mbox="hero"]').replaceWith(replacement);
        setTimeout(() => notify('rendering-succeeded', { hero: [{ id: 'p1', scope: 'hero' }] }), 0);
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, beforePersonalizedReveal,
    });
    await martechEager();
    await flushAsync();
    expect(beforePersonalizedReveal).toHaveBeenCalledWith([replacement]);
    expect(isHeld(replacement)).toBe(true);
    finishDecorating();
    await flushAsync();
    expect(isHeld(replacement)).toBe(false);
  });

  it('does not hold other content added next to a held section', async () => {
    setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => ({ propositions: [] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    const section = document.createElement('div');
    document.querySelector('main').append(section);
    await flushAsync();
    expect(isHeld(section)).toBe(false);
  });

  it('keeps an inert attribute the section already had', async () => {
    const [hero] = setup(['hero']);
    hero.setAttribute('inert', '');
    window.__alloyMockHandlers = { sendEvent: fetchReturns([]) };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    expect(hero.hasAttribute(HOLD_ATTRIBUTE)).toBe(false);
    expect(hero.hasAttribute('inert')).toBe(true);
  });
  it('keeps an offer the Web SDK is already rendering hidden past the hold timeout', async () => {
    const [hero, banner] = setup(['hero', 'banner']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero'), offer('p2', 'banner')]),
      // p1 is handed to the SDK (still rendering), p2 never finds its target
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, personalizationHoldTimeout: 50,
    });
    await martechEager();
    await wait(70);
    expect(isHeld(banner)).toBe(false);
    expect(isHeld(hero)).toBe(true);
    render('p1', 'hero');
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('offer');
  });

  it('stopPersonalization waits for an offer the Web SDK is already rendering', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager, stopPersonalization } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    stopPersonalization();
    expect(isHeld(hero)).toBe(true);
    notify('rendering-failed', { propositionDetails: { id: 'p1', scope: 'hero' } });
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
  });

  it('matches each replacement to the section it replaced', async () => {
    setup(['hero', 'banner']);
    const replacements = {};
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero'), offer('p2', 'banner')]),
      applyPropositions: () => {
        ['hero', 'banner'].forEach((scope) => {
          const section = document.querySelector(`[data-mbox="${scope}"]`);
          replacements[scope] = document.createElement('div');
          // like alloy's replaceHtml: insert the offer, then remove the section
          section.before(replacements[scope]);
          section.remove();
        });
        return {
          propositions: [{ id: 'p1', renderAttempted: true }, { id: 'p2', renderAttempted: true }],
        };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    notify('rendering-succeeded', { hero: [{ id: 'p1', scope: 'hero' }] });
    await flushAsync();
    expect(isHeld(replacements.hero)).toBe(false);
    expect(isHeld(replacements.banner)).toBe(true);
    notify('rendering-succeeded', { banner: [{ id: 'p2', scope: 'banner' }] });
    await flushAsync();
    expect(isHeld(replacements.banner)).toBe(false);
  });
  it('does not show anything before Target answers, whatever else changes on the page', async () => {
    const [hero] = setup(['hero']);
    let resolveFetch;
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? new Promise((resolve) => { resolveFetch = resolve; })
        : {}),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    const eager = martechEager();
    document.querySelector('main').append(document.createElement('div'));
    await flushAsync();
    expect(isHeld(hero)).toBe(true);
    resolveFetch({ propositions: [] });
    await eager;
    expect(isHeld(hero)).toBe(false);
  });

  it('waits for every item of an offer, not the first one that fails', async () => {
    const [hero] = setup(['hero']);
    const twoItems = {
      ...offer('p1', 'hero'),
      items: [
        { schema: HTML_SCHEMA, data: { content: '<p>a</p>' } },
        { schema: HTML_SCHEMA, data: { content: '<p>b</p>' } },
      ],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([twoItems]),
      applyPropositions: () => {
        notify('rendering-failed', { propositionDetails: { id: 'p1', scope: 'hero' } });
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    // the other item is still rendering
    expect(isHeld(hero)).toBe(true);
    render('p1', 'hero');
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
  });
  it('holds the element a VEC setHtml offer targets around a section until it renders', async () => {
    setup(['hero']);
    const main = document.querySelector('main');
    let finishDecorating;
    const beforePersonalizedReveal = vi.fn(() => new Promise((resolve) => {
      finishDecorating = resolve;
    }));
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'setHtml', selector: 'main', content: '<div id="offer">offer</div>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        // like alloy's setHtml: the children go, then the offer is appended
        [...main.children].forEach((child) => child.remove());
        main.insertAdjacentHTML('beforeend', '<div id="offer">offer</div>');
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, beforePersonalizedReveal,
    });
    await martechEager();
    await flushAsync();
    expect(isHeld(main)).toBe(true);
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(beforePersonalizedReveal).toHaveBeenCalledWith([main]);
    expect(isHeld(main)).toBe(true);
    finishDecorating();
    await flushAsync();
    expect(isHeld(main)).toBe(false);
    expect(main.textContent).toBe('offer');
  });

  it('holds what replaces the element a VEC replaceHtml offer targets around a section', async () => {
    document.body.innerHTML = '<main><div id="wrapper"><div class="section" data-section-status="loaded" data-mbox="hero"><p>default hero</p></div></div></main>';
    const wrapper = document.getElementById('wrapper');
    const replacement = document.createElement('div');
    replacement.textContent = 'offer';
    let finishDecorating;
    const beforePersonalizedReveal = vi.fn(() => new Promise((resolve) => {
      finishDecorating = resolve;
    }));
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '#wrapper', content: '<div>offer</div>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        // like alloy's replaceHtml: insert the offer first, remove the target later
        wrapper.before(replacement);
        setTimeout(() => wrapper.remove(), 0);
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, beforePersonalizedReveal,
    });
    await martechEager();
    await flushAsync();
    expect(isHeld(replacement)).toBe(true);
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(beforePersonalizedReveal).toHaveBeenCalledWith([replacement]);
    expect(isHeld(replacement)).toBe(true);
    finishDecorating();
    await flushAsync();
    expect(isHeld(replacement)).toBe(false);
    expect(document.querySelector('main').textContent).toBe('offer');
  });

  it('does not hold a section for an offer that only tracks clicks on it', async () => {
    const [hero] = setup(['hero']);
    const clickOnly = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'click', selector: '[data-mbox="hero"]' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([clickOnly]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    expect(isHeld(hero)).toBe(false);
  });

  it('stopPersonalization keeps an offer already sent to the Web SDK hidden until it renders', async () => {
    const [hero] = setup(['hero']);
    let finishApplying;
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => new Promise((resolve) => { finishApplying = resolve; }),
    };
    const { initMartech, martechEager, stopPersonalization } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    // the SDK command is queued but has not answered yet
    stopPersonalization();
    expect(isHeld(hero)).toBe(true);
    finishApplying({ propositions: [{ id: 'p1', renderAttempted: true }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(true);
    render('p1', 'hero');
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('offer');
  });

  it('stopPersonalization shows the default when the Web SDK did not take the offer', async () => {
    const [hero] = setup(['hero']);
    let finishApplying;
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => new Promise((resolve) => { finishApplying = resolve; }),
    };
    const { initMartech, martechEager, stopPersonalization } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    stopPersonalization();
    finishApplying({ propositions: [] });
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('default hero');
  });

  it('handles replaceHtml the way the Web SDK does it: insert first, remove later', async () => {
    document.body.innerHTML = '<main><div class="section" data-section-status="loaded" data-mbox="hero" data-mbox-action="replaceHtml"><p>default hero</p></div></main>';
    const hero = document.querySelector('[data-mbox="hero"]');
    const replacement = document.createElement('div');
    replacement.innerHTML = '<p>offer</p>';
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        hero.before(replacement);
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    expect(isHeld(replacement)).toBe(true);
    // the SDK reports it rendered, but removes the section only once the offer's scripts ran
    notify('rendering-succeeded', { hero: [{ id: 'p1', scope: 'hero' }] });
    await flushAsync();
    expect(isHeld(replacement)).toBe(true);
    expect(isHeld(hero)).toBe(true);
    hero.remove();
    await flushAsync();
    expect(isHeld(replacement)).toBe(false);
    expect(document.querySelector('main').textContent).toBe('offer');
  });
  it('shows the default content right away when a replaceHtml offer fails', async () => {
    document.body.innerHTML = '<main><div class="section" data-section-status="loaded" data-mbox="hero" data-mbox-action="replaceHtml"><p>default hero</p></div></main>';
    const hero = document.querySelector('[data-mbox="hero"]');
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        notify('rendering-failed', { propositionDetails: { id: 'p1', scope: 'hero' } });
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('default hero');
  });
  it('reports a held offer as displayed only once it is rendered and shown', async () => {
    setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    const reportedIds = () => alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || [])
      .map((p) => p.id);
    expect(reportedIds()).not.toContain('p1');
    render('p1', 'hero');
    await flushAsync();
    expect(reportedIds()).toEqual(['p1']);
  });

  it('never reports a held offer that failed to render', async () => {
    setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    notify('rendering-failed', { propositionDetails: { id: 'p1', scope: 'hero' } });
    // the Web SDK reports the offer rendered after its items all failed, too
    notify('rendering-succeeded', { hero: [{ id: 'p1', scope: 'hero' }] });
    await flushAsync();
    const reported = alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || []);
    expect(reported.map((p) => p.id)).not.toContain('p1');
  });

  it('does not report offers dropped because personalization was stopped', async () => {
    setup(['hero']);
    let answer;
    window.__alloyMockHandlers = {
      sendEvent: (options) => (options.type === 'decisioning.propositionFetch'
        ? new Promise((resolve) => { answer = resolve; }) : {}),
    };
    const { initMartech, martechEager, stopPersonalization } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    const eager = martechEager();
    await flushAsync();
    stopPersonalization();
    answer({ propositions: [offer('p1', 'hero')] });
    await eager;
    await flushAsync();
    expect(alloyCalls('applyPropositions').length).toBe(0);
    const reported = alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || []);
    expect(reported.map((p) => p.id)).not.toContain('p1');
  });
  it('reports an offer only once the section it shares with another offer is shown', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero'), offer('p2', 'hero')]),
      applyPropositions: () => ({
        propositions: [{ id: 'p1', renderAttempted: true }, { id: 'p2', renderAttempted: true }],
      }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    const reportedIds = () => alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || [])
      .map((p) => p.id);
    notify('rendering-succeeded', { hero: [{ id: 'p1', scope: 'hero' }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(true);
    expect(reportedIds()).toEqual([]);
    notify('rendering-succeeded', { hero: [{ id: 'p2', scope: 'hero' }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(reportedIds().sort()).toEqual(['p1', 'p2']);
  });
  it('hides a held section whatever opacity the site gives it', async () => {
    const [hero] = setup(['hero']);
    hero.style.setProperty('opacity', '1', 'important');
    window.__alloyMockHandlers = { sendEvent: () => new Promise(() => {}) };
    const { initMartech } = await importMartech();
    initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    expect(isHeld(hero)).toBe(true);
    expect(getComputedStyle(hero).filter).toBe('opacity(0)');
    // the site's own opacity is left as it is
    expect(hero.style.getPropertyValue('opacity')).toBe('1');
    expect(hero.style.getPropertyPriority('opacity')).toBe('important');
  });

  it('reports an offer only once nothing around its section is held', async () => {
    const [hero] = setup(['hero']);
    const main = document.querySelector('main');
    const vec = {
      id: 'p2',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'setAttribute', selector: 'main', content: { 'data-x': '1' } } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero'), vec]),
      applyPropositions: () => ({
        propositions: [{ id: 'p1', renderAttempted: true }, { id: 'p2', renderAttempted: true }],
      }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    const reportedIds = () => alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || [])
      .map((p) => p.id);
    render('p1', 'hero');
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(isHeld(main)).toBe(true);
    expect(reportedIds()).not.toContain('p1');
    notify('rendering-succeeded', { __view__: [{ id: 'p2', scope: '__view__' }] });
    await flushAsync();
    expect(isHeld(main)).toBe(false);
    expect(reportedIds().sort()).toEqual(['p1', 'p2']);
  });
  it('holds what replaces a section for a replaceHtml offer with a Target-only selector', async () => {
    const [hero] = setup(['hero']);
    const replacement = document.createElement('div');
    replacement.textContent = 'offer';
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '.section:eq(0)', content: '<div>offer</div>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        hero.before(replacement);
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    expect(isHeld(replacement)).toBe(true);
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    // both stay hidden until the Web SDK removes the section, once the offer's scripts ran
    expect(isHeld(replacement)).toBe(true);
    expect(isHeld(hero)).toBe(true);
    hero.remove();
    await flushAsync();
    expect(isHeld(replacement)).toBe(false);
    expect(document.querySelector('main').textContent).toBe('offer');
  });
  it('never reports an offer whose section another offer removed before it was shown', async () => {
    document.body.innerHTML = '<main><div id="wrapper"><div class="section" data-section-status="loaded" data-mbox="hero"><p>default hero</p></div></div></main>';
    const wrapper = document.getElementById('wrapper');
    const vec = {
      id: 'p2',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '#wrapper', content: '<div>offer</div>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero'), vec]),
      applyPropositions: () => ({
        propositions: [{ id: 'p1', renderAttempted: true }, { id: 'p2', renderAttempted: true }],
      }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    render('p1', 'hero');
    const replacement = document.createElement('div');
    replacement.textContent = 'offer';
    wrapper.before(replacement);
    notify('rendering-succeeded', { __view__: [{ id: 'p2', scope: '__view__' }] });
    await flushAsync();
    wrapper.remove();
    await flushAsync();
    const reportedIds = alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || [])
      .map((p) => p.id);
    expect(isHeld(replacement)).toBe(false);
    expect(reportedIds).toEqual(['p2']);
  });
  it('never reports an offer that failed before the Web SDK answered applyPropositions', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        notify('rendering-failed', { propositionDetails: { id: 'p1', scope: 'hero' } });
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    const reported = alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || []);
    expect(reported.map((p) => p.id)).not.toContain('p1');
  });
  it('holds markup a VEC offer inserts next to a section until the section is shown', async () => {
    const [hero] = setup(['hero']);
    const inserted = document.createElement('div');
    inserted.textContent = 'offer';
    let finishDecorating;
    const beforePersonalizedReveal = vi.fn(() => new Promise((resolve) => {
      finishDecorating = resolve;
    }));
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'insertAfter', selector: '[data-mbox="hero"]', content: '<div>offer</div>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        hero.after(inserted);
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, beforePersonalizedReveal,
    });
    await martechEager();
    await flushAsync();
    expect(isHeld(inserted)).toBe(true);
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(beforePersonalizedReveal).toHaveBeenCalledWith(expect.arrayContaining([hero, inserted]));
    expect(isHeld(inserted)).toBe(true);
    finishDecorating();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(isHeld(inserted)).toBe(false);
  });
  it('waits for a shared section even when the SDK reports rendering before it answers', async () => {
    const [hero] = setup(['hero']);
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero'), offer('p2', 'hero')]),
      applyPropositions: () => {
        notify('rendering-succeeded', { hero: [{ id: 'p1', scope: 'hero' }] });
        return {
          propositions: [{ id: 'p1', renderAttempted: true }, { id: 'p2', renderAttempted: true }],
        };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    const reportedIds = () => alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || [])
      .map((p) => p.id);
    expect(isHeld(hero)).toBe(true);
    expect(reportedIds()).toEqual([]);
    notify('rendering-succeeded', { hero: [{ id: 'p2', scope: 'hero' }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(reportedIds().sort()).toEqual(['p1', 'p2']);
  });
  it('holds markup a VEC offer inserts before an element around a section', async () => {
    document.body.innerHTML = '<main><div id="wrapper"><div class="section" data-section-status="loaded" data-mbox="hero"><p>default hero</p></div></div></main>';
    const wrapper = document.getElementById('wrapper');
    const inserted = document.createElement('div');
    inserted.textContent = 'offer';
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'insertBefore', selector: '#wrapper', content: '<div>offer</div>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        wrapper.before(inserted);
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    expect(isHeld(inserted)).toBe(true);
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(isHeld(wrapper)).toBe(false);
    expect(isHeld(inserted)).toBe(false);
  });
  it('keeps a section held until a replaceHtml offer inside it is finished', async () => {
    document.body.innerHTML = '<main><div class="section" data-section-status="loaded" data-mbox="hero"><p id="nested">default hero</p></div></main>';
    const hero = document.querySelector('[data-mbox="hero"]');
    const nested = document.getElementById('nested');
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '#nested', content: '<p>offer</p>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        nested.insertAdjacentHTML('beforebegin', '<p>offer</p>');
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    // the offer's scripts are still running: the default is still there
    expect(isHeld(hero)).toBe(true);
    nested.remove();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('offer');
  });
  it('shows the section right away when a replaceHtml offer inside it fails', async () => {
    document.body.innerHTML = '<main><div class="section" data-section-status="loaded" data-mbox="hero"><p id="nested">default hero</p></div></main>';
    const hero = document.querySelector('[data-mbox="hero"]');
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '#nested', content: '<p>offer</p>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    notify('rendering-failed', { propositionDetails: { id: 'p1', scope: '__view__' } });
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('default hero');
  });
  it('understands Target :eq() selectors like the Web SDK does', async () => {
    document.body.innerHTML = `<main>
      <div class="section" data-section-status="loaded" data-mbox="hero"><p id="first">default hero</p><p>more</p></div>
      <div class="section" data-section-status="loaded" data-mbox="banner"><p>default banner</p></div>
    </main>`;
    const [hero, banner] = document.querySelectorAll('.section');
    const nested = document.getElementById('first');
    const inserted = document.createElement('div');
    inserted.textContent = 'after banner';
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [
        { schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '.section:eq(0) > p:eq(0)', content: '<p>offer</p>' } },
        { schema: DOM_ACTION_SCHEMA, data: { type: 'insertAfter', selector: '.section:eq(1)', content: '<div>after banner</div>' } },
      ],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        nested.insertAdjacentHTML('beforebegin', '<p>offer</p>');
        banner.after(inserted);
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    expect(isHeld(inserted)).toBe(true);
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    // the replaced paragraph is still there while the offer's scripts run
    expect(isHeld(hero)).toBe(true);
    expect(isHeld(inserted)).toBe(true);
    nested.remove();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(isHeld(banner)).toBe(false);
    expect(isHeld(inserted)).toBe(false);
  });
  it('shows the default right away when an offer fails, without the reveal hook', async () => {
    const [hero] = setup(['hero']);
    const beforePersonalizedReveal = vi.fn(() => new Promise(() => {}));
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, beforePersonalizedReveal,
    });
    await martechEager();
    notify('rendering-failed', { propositionDetails: { id: 'p1', scope: 'hero' } });
    await flushAsync();
    expect(beforePersonalizedReveal).not.toHaveBeenCalled();
    expect(isHeld(hero)).toBe(false);
  });
  it('shows the section once the rest of an offer renders when its replaceHtml item fails', async () => {
    document.body.innerHTML = '<main><div class="section" data-section-status="loaded" data-mbox="hero"><p id="nested">default hero</p><h2 id="title">title</h2></div></main>';
    const hero = document.querySelector('[data-mbox="hero"]');
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [
        { schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '#nested', content: '<p>offer</p>' } },
        { schema: DOM_ACTION_SCHEMA, data: { type: 'setHtml', selector: '#title', content: 'new title' } },
      ],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        document.getElementById('title').textContent = 'new title';
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    notify('rendering-failed', {
      propositionDetails: { id: 'p1', scope: '__view__' },
      item: { data: { type: 'replaceHtml', selector: '#nested' } },
    });
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('default heronew title');
  });
  it('waits for a replaceHtml target that appeared after Target answered', async () => {
    const [hero] = setup(['hero']);
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '#late', content: '<p>offer</p>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    // block decoration creates the target; the SDK, watching for it, inserts the offer before it
    hero.innerHTML = '<p id="late">default</p>';
    const late = document.getElementById('late');
    await flushAsync();
    late.insertAdjacentHTML('beforebegin', '<p>offer</p>');
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(true);
    late.remove();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('offer');
  });
  it('does not wait for a late replaceHtml target whose item failed', async () => {
    const [hero] = setup(['hero']);
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [
        { schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '#late', content: '<p>offer</p>' } },
        { schema: DOM_ACTION_SCHEMA, data: { type: 'setHtml', selector: '#title', content: 'new title' } },
      ],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    hero.innerHTML = '<p id="late">default</p><h2 id="title">new title</h2>';
    notify('rendering-failed', {
      propositionDetails: { id: 'p1', scope: '__view__' },
      item: { data: { type: 'replaceHtml', selector: '#late' } },
    });
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
  });
  it('waits for a late positional replaceHtml target, not for the offer that replaced it', async () => {
    const [hero] = setup(['hero']);
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'replaceHtml', selector: '.section:eq(0) > p:eq(0)', content: '<p>offer</p>' } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    hero.innerHTML = '';
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    hero.innerHTML = '<p id="original">default</p>';
    await flushAsync();
    const original = document.getElementById('original');
    original.insertAdjacentHTML('beforebegin', '<p>offer</p>');
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(true);
    original.remove();
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.textContent).toBe('offer');
  });

  it('keeps an opacity the offer sets on a held section', async () => {
    const [hero] = setup(['hero']);
    hero.style.opacity = '1';
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        hero.style.cssText += ';opacity:0.5;';
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    expect(getComputedStyle(hero).filter).toBe('opacity(0)');
    render('p1', 'hero');
    await flushAsync();
    expect(isHeld(hero)).toBe(false);
    expect(hero.style.opacity).toBe('0.5');
  });
  it('holds replaceHtml markup with whitespace around it', async () => {
    document.body.innerHTML = '<main><div class="section" data-section-status="loaded" data-mbox="hero" data-mbox-action="replaceHtml"><p>default hero</p></div></main>';
    const hero = document.querySelector('[data-mbox="hero"]');
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([offer('p1', 'hero')]),
      applyPropositions: () => {
        // like alloy: every node of the offer, whitespace included
        hero.insertAdjacentHTML('beforebegin', '\n<div id="offer">offer</div>\n');
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { holdPersonalizedSections: true });
    await martechEager();
    await flushAsync();
    expect(isHeld(document.getElementById('offer'))).toBe(true);
    notify('rendering-succeeded', { hero: [{ id: 'p1', scope: 'hero' }] });
    hero.remove();
    await flushAsync();
    expect(isHeld(document.getElementById('offer'))).toBe(false);
  });
  it('keeps a section held when the offer sets its classes', async () => {
    const [hero] = setup(['hero']);
    const beforePersonalizedReveal = vi.fn(() => new Promise(() => {}));
    const vec = {
      id: 'p1',
      scope: '__view__',
      scopeDetails: {},
      items: [{ schema: DOM_ACTION_SCHEMA, data: { type: 'setAttribute', selector: '[data-mbox="hero"]', content: { class: 'section personalized' } } }],
    };
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([vec]),
      applyPropositions: () => {
        hero.setAttribute('class', 'section personalized');
        return { propositions: [{ id: 'p1', renderAttempted: true }] };
      },
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      holdPersonalizedSections: true, beforePersonalizedReveal,
    });
    await martechEager();
    notify('rendering-succeeded', { __view__: [{ id: 'p1', scope: '__view__' }] });
    await flushAsync();
    expect(isHeld(hero)).toBe(true);
    expect(getComputedStyle(hero).filter).toBe('opacity(0)');
  });
});
