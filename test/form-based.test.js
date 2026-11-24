import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

const HTML_SCHEMA = 'https://ns.adobe.com/personalization/html-content-item';

const htmlOffer = (id, scope, data = {}) => ({
  id, scope, scopeDetails: {}, items: [{ schema: HTML_SCHEMA, data: { content: '<p>offer</p>', ...data } }],
});
const fetchReturns = (propositions) => (options) => (
  options.type === 'decisioning.propositionFetch' ? { propositions } : {});
const debugMessages = (spy) => spy.mock.calls.map((args) => args.join(' '));

describe('Form-Based offers', () => {
  beforeEach(() => resetBrowserState());

  it('applies an offer to the selector it carries', async () => {
    document.body.innerHTML = '<main><div id="promo" data-block-status="loaded"></div></main>';
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([htmlOffer('p1', 'promo-scope', { selector: '#promo' })]),
      applyPropositions: () => ({ propositions: [{ id: 'p1', renderAttempted: true }] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    const [apply] = alloyCalls('applyPropositions');
    // it becomes a dom-action, so it keeps its own target
    expect(apply.options.metadata).toBeUndefined();
    expect(apply.options.propositions[0].items[0]).toMatchObject({
      schema: 'https://ns.adobe.com/personalization/dom-action',
      data: { type: 'setHtml', selector: '#promo', content: '<p>offer</p>' },
    });
  });

  it('drops an offer with no target it can be applied to, and logs it', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([htmlOffer('p1', 'nowhere')]),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    expect(alloyCalls('applyPropositions').length).toBe(0);
    expect(debugMessages(log).some((m) => m.includes('no resolvable selector') && m.includes('nowhere')))
      .toBe(true);
  });

  it('logs a data-mbox section that arrives after the offers were fetched', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    document.body.innerHTML = '<main><div class="section" data-section-status="loaded" data-mbox="hero"></div></main>';
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([htmlOffer('p1', 'hero')]),
      applyPropositions: () => ({ propositions: [] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    const fetch = alloyCalls('sendEvent')
      .find((c) => c.options.type === 'decisioning.propositionFetch');
    expect(fetch.options.personalization.decisionScopes).toContain('hero');

    // a fragment brings in another personalized section later
    const late = document.createElement('div');
    late.className = 'section';
    late.dataset.mbox = 'late-banner';
    document.querySelector('main').append(late);
    late.dataset.sectionStatus = 'loaded';
    await flushAsync();
    expect(debugMessages(log).some((m) => m.includes('"late-banner" discovered after eager propositionFetch')))
      .toBe(true);
    // it is not requested again on this page view
    expect(alloyCalls('sendEvent')
      .filter((c) => c.options.type === 'decisioning.propositionFetch').length).toBe(1);
  });
  it('does not report an offer it could not apply as displayed', async () => {
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([htmlOffer('p1', 'nowhere')]),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    const reported = alloyCalls('sendEvent')
      .flatMap((c) => c.options.xdm?._experience?.decisioning?.propositions || []);
    expect(reported.map((p) => p.id)).not.toContain('p1');
  });

  it('keeps mbox names that look alike apart', async () => {
    document.body.innerHTML = `<main>
      <div class="section" data-section-status="loaded" data-mbox="a.b"></div>
      <div class="section" data-section-status="loaded" data-mbox="a-b"></div>
    </main>`;
    window.__alloyMockHandlers = {
      sendEvent: fetchReturns([htmlOffer('p1', 'a.b'), htmlOffer('p2', 'a-b')]),
      applyPropositions: () => ({ propositions: [] }),
    };
    const { initMartech, martechEager } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await martechEager();
    await flushAsync();
    const { metadata } = alloyCalls('applyPropositions')[0].options;
    expect(metadata['a.b'].selector).not.toBe(metadata['a-b'].selector);
    expect(document.querySelectorAll(metadata['a.b'].selector).length).toBe(1);
    expect(document.querySelectorAll(metadata['a-b'].selector).length).toBe(1);
  });
});
