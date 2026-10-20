/* eslint-disable no-underscore-dangle */
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

const options = {
  decisionScopes: ['region-one', 'region-two'],
  defaultPersonalizationEnabled: false,
  pageURL: 'https://example.com/page?qa=preview&experience=2',
};
const proposition = (id = 'p1', schema = 'custom-schema') => ({
  id,
  scope: 'region-one',
  scopeDetails: { decisionProvider: 'TGT', activity: { id: 'activity-one' } },
  items: [{ schema, data: { value: 'opaque project data' } }],
});
const displays = (instanceName) => alloyCalls('sendEvent', instanceName)
  .filter((c) => c.options.xdm?.eventType === 'decisioning.propositionDisplay');

async function setup(propositions = [proposition()], config = {}) {
  window.__alloyMockHandlers = { sendEvent: () => ({ propositions }) };
  const martech = await importMartech();
  await martech.initMartech(TEST_WEBSDK_CONFIG, {
    personalization: true,
    analytics: false,
    dataLayer: false,
    trackPageView: false,
    ...config,
  });
  return martech;
}

describe('manual proposition fetching (AC1, AC2)', () => {
  beforeEach(() => resetBrowserState(['siteSDK']));

  it('makes one manual SDK request with exact scopes, flags and complete page URL', async () => {
    const original = [proposition(), proposition('p2', 'unknown-schema')];
    const { fetchPropositions } = await setup(original, { decisionScopes: ['not-requested'] });
    const result = await fetchPropositions(options);

    expect(result.propositions).toBe(original);
    expect(result.propositions[0]).toBe(original[0]);
    expect(typeof result.display).toBe('function');
    expect(alloyCalls('sendEvent')).toHaveLength(1);
    expect(alloyCalls('sendEvent')[0].options).toEqual({
      type: 'decisioning.propositionFetch',
      renderDecisions: false,
      personalization: {
        decisionScopes: options.decisionScopes,
        sendDisplayEvent: false,
        defaultPersonalizationEnabled: false,
      },
      xdm: { web: { webPageDetails: { URL: options.pageURL } } },
    });
    expect(alloyCalls('applyPropositions')).toHaveLength(0);
    expect(alloyCalls('setConsent')).toHaveLength(0);
    expect(displays()).toHaveLength(0);
  });

  it('defaults to the full current URL and disables default personalization', async () => {
    const { fetchPropositions } = await setup();
    await fetchPropositions({ decisionScopes: ['region-one'] });
    const [{ options: request }] = alloyCalls('sendEvent');
    expect(request.xdm.web.webPageDetails.URL).toBe(window.location.href);
    expect(request.personalization.defaultPersonalizationEnabled).toBe(false);
  });

  it('passes the standard defaultPersonalizationEnabled option through when explicitly true', async () => {
    const { fetchPropositions } = await setup();
    await fetchPropositions({ ...options, defaultPersonalizationEnabled: true });
    expect(alloyCalls('sendEvent')[0].options.personalization.defaultPersonalizationEnabled).toBe(true);
  });

  it.each([undefined, 'siteSDK'])('uses the configured SDK instance (argument %s)', async (name) => {
    const { fetchPropositions } = await setup(undefined, { alloyInstanceName: 'siteSDK' });
    const { propositions, display } = await fetchPropositions(options, name);
    await display(propositions[0]);
    expect(alloyCalls('sendEvent', 'siteSDK')).toHaveLength(2);
    expect(alloyCalls('sendEvent')).toHaveLength(0);
  });

  it('binds fetch and display to an explicitly selected existing instance', async () => {
    const { fetchPropositions } = await setup();
    window.siteSDK = vi.fn(window.alloy);
    const { propositions, display } = await fetchPropositions(options, 'siteSDK');
    await display(propositions[0]);
    expect(window.siteSDK).toHaveBeenCalledTimes(2);
    expect(window.siteSDK.mock.calls.map(([command]) => command)).toEqual(['sendEvent', 'sendEvent']);
  });

  it('rejects an unavailable instance without sending', async () => {
    const { fetchPropositions } = await setup();
    await expect(fetchPropositions(options, 'missingSDK')).rejects.toThrow('The WebSDK instance is not available.');
    expect(alloyCalls('sendEvent')).toHaveLength(0);
  });

  it('rejects before initialization', async () => {
    const { fetchPropositions } = await importMartech();
    await expect(fetchPropositions(options)).rejects.toThrow(/initialized before.*fetchPropositions/);
  });

  it('rejects when personalization is disabled without queuing a request', async () => {
    const { fetchPropositions } = await setup([], { personalization: false });
    await expect(fetchPropositions(options)).rejects.toThrow(/personalization is disabled/i);
    expect(window.alloy.q).toHaveLength(0);
  });

  it.each([
    {}, { decisionScopes: [] }, { decisionScopes: 'region-one' },
    { decisionScopes: [null] }, { decisionScopes: [' '] },
  ])('rejects invalid explicit scopes: %j', async (input) => {
    const { fetchPropositions } = await setup();
    await expect(fetchPropositions(input)).rejects.toThrow(/decisionScopes/);
    expect(alloyCalls('sendEvent')).toHaveLength(0);
  });

  it.each([
    { ...options, defaultPersonalizationEnabled: 'false' },
    { ...options, pageURL: null },
    { ...options, pageURL: '' },
  ])('rejects invalid options without sending: %j', async (input) => {
    const { fetchPropositions } = await setup();
    await expect(fetchPropositions(input)).rejects.toThrow();
    expect(alloyCalls('sendEvent')).toHaveLength(0);
  });

  it('accepts an explicitly empty proposition list without a display', async () => {
    const { fetchPropositions } = await setup([]);
    const result = await fetchPropositions(options);
    expect(result.propositions).toEqual([]);
    await expect(result.display(proposition())).rejects.toThrow(/not returned by this fetch/);
    expect(displays()).toHaveLength(0);
  });

  it.each([
    undefined, null, {}, { propositions: null }, { propositions: {} },
    { propositions: [null] }, { propositions: [{ id: 'p1' }] },
    { propositions: [{ ...proposition(), scopeDetails: null }] },
  ])('rejects malformed SDK results rather than returning empty success: %j', async (result) => {
    const { fetchPropositions } = await setup();
    window.__alloyMockHandlers.sendEvent = () => result;
    await expect(fetchPropositions(options)).rejects.toThrow('Invalid proposition response.');
    expect(displays()).toHaveLength(0);
  });

  it('sanitizes SDK fetch failures and does not report display', async () => {
    const { fetchPropositions } = await setup();
    window.__alloyMockHandlers.sendEvent = () => {
      throw new Error('private SDK payload https://example.com/?secret=value');
    };
    await expect(fetchPropositions(options)).rejects.toThrow('Could not fetch propositions.');
    expect(displays()).toHaveLength(0);
  });
});

describe('explicit bound display (AC3)', () => {
  beforeEach(() => resetBrowserState());
  afterEach(() => {
    vi.useRealTimers();
    delete document.prerendering;
  });

  it('reports only on explicit display, once, with original metadata and analytics disabled', async () => {
    const original = proposition();
    const metadata = window.structuredClone({
      id: original.id, scope: original.scope, scopeDetails: original.scopeDetails,
    });
    const { fetchPropositions } = await setup([original]);
    const { propositions, display } = await fetchPropositions(options);
    // Project decoding or mutation must not let it replace the reporting identity.
    propositions[0].id = 'changed';
    propositions[0].scope = 'changed';
    propositions[0].scopeDetails.activity.id = 'changed';
    await flushAsync();
    expect(displays()).toHaveLength(0);
    await Promise.all([display(original), display(original), display(original)]);
    await display(original);
    expect(displays()).toHaveLength(1);
    expect(displays()[0].options).toEqual({
      renderDecisions: false,
      personalization: { sendDisplayEvent: false, defaultPersonalizationEnabled: false },
      xdm: {
        eventType: 'decisioning.propositionDisplay',
        _experience: {
          decisioning: { propositions: [metadata], propositionEventType: { display: 1 } },
        },
      },
    });
    expect(alloyCalls('sendEvent')).toHaveLength(2);
  });

  it('rejects clones, payloads and propositions from a different fetch', async () => {
    const { fetchPropositions } = await setup();
    const first = await fetchPropositions(options);
    window.__alloyMockHandlers.sendEvent = () => ({ propositions: [proposition()] });
    const second = await fetchPropositions(options);
    await Promise.all([
      window.structuredClone(first.propositions[0]),
      first.propositions[0].items[0].data,
      second.propositions[0],
      undefined,
    ].map((foreign) => expect(first.display(foreign))
      .rejects.toThrow('Proposition was not returned by this fetch.')));
    expect(displays()).toHaveLength(0);
  });

  it('deduplicates duplicate proposition identities in a response', async () => {
    const { fetchPropositions } = await setup([proposition(), proposition()]);
    const { propositions, display } = await fetchPropositions(options);
    await Promise.all(propositions.map(display));
    expect(displays()).toHaveLength(1);
  });

  it('reports the same ID independently per original scope and rejects foreign objects', async () => {
    const first = proposition('shared');
    const second = {
      ...proposition('shared'),
      scope: 'region-two',
      scopeDetails: { decisionProvider: 'TGT', activity: { id: 'activity-two' } },
    };
    const expected = [first, second].map((p) => window.structuredClone({
      id: p.id, scope: p.scope, scopeDetails: p.scopeDetails,
    }));
    const { fetchPropositions } = await setup([first, second]);
    const { display } = await fetchPropositions(options);
    await expect(display(window.structuredClone(first)))
      .rejects.toThrow('Proposition was not returned by this fetch.');
    // Dedupe must use captured scopes, not the project's mutable returned objects.
    first.scope = second.scope;
    first.scopeDetails.activity.id = 'changed';
    await Promise.all([display(first), display(second), display(first), display(second)]);
    await Promise.all([display(first), display(second)]);
    expect(displays()).toHaveLength(2);
    expect(displays().map((c) => c.options.xdm._experience.decisioning.propositions[0]))
      .toEqual(expected);
  });

  it('caches a failed attempt without blocking the same ID in another scope', async () => {
    const first = proposition('shared');
    const second = {
      ...proposition('shared'),
      scope: 'region-two',
      scopeDetails: { decisionProvider: 'TGT', activity: { id: 'activity-two' } },
    };
    const { fetchPropositions } = await setup([first, second]);
    const { display } = await fetchPropositions(options);
    window.__alloyMockHandlers.sendEvent = (request) => {
      if (request.xdm._experience.decisioning.propositions[0].scope === first.scope) {
        throw new Error('private SDK failure');
      }
      return {};
    };
    await expect(display(first)).rejects.toThrow('Could not report proposition display.');
    await display(second);
    await expect(display(first)).rejects.toThrow('Could not report proposition display.');
    await display(second);
    expect(displays()).toHaveLength(2);
    expect(displays().map((c) => c.options.xdm._experience.decisioning.propositions[0].scope))
      .toEqual(['region-one', 'region-two']);
  });

  it('leaves unapplied, failed or timed-out regions unreported while another region can display', async () => {
    vi.useFakeTimers();
    const { fetchPropositions } = await setup([proposition('failed'), proposition('late')]);
    const { propositions, display } = await fetchPropositions(options);
    const render = Promise.reject(new Error('project application failed'));
    await expect(render).rejects.toThrow('project application failed');
    await vi.advanceTimersByTimeAsync(5000);
    expect(displays()).toHaveLength(0);
    await display(propositions[1]);
    expect(displays()[0].options.xdm._experience.decisioning.propositions[0].id).toBe('late');
    expect(displays()).toHaveLength(1);
  });

  it('awaits the SDK display promise and never retries a failed display attempt', async () => {
    const { fetchPropositions } = await setup();
    const { propositions, display } = await fetchPropositions(options);
    let rejectSend;
    window.__alloyMockHandlers.sendEvent = () => new Promise((resolve, reject) => {
      rejectSend = reject;
    });
    let settled = false;
    const pending = display(propositions[0]);
    const failure = expect(pending).rejects.toThrow('Could not report proposition display.');
    pending.catch(() => { settled = true; });
    await flushAsync();
    expect(settled).toBe(false);
    rejectSend(new Error('private SDK error'));
    await failure;
    await expect(display(propositions[0])).rejects.toThrow('Could not report proposition display.');
    expect(displays()).toHaveLength(1);
  });

  it('defers display until page activation and resolves only after the SDK send', async () => {
    Object.defineProperty(document, 'prerendering', { configurable: true, value: true });
    const { fetchPropositions } = await setup();
    const { propositions, display } = await fetchPropositions(options);
    let settled = false;
    const pending = display(propositions[0]).then(() => { settled = true; });
    await flushAsync();
    expect(displays()).toHaveLength(0);
    expect(settled).toBe(false);
    document.dispatchEvent(new Event('prerenderingchange'));
    await pending;
    await display(propositions[0]);
    document.dispatchEvent(new Event('prerenderingchange'));
    expect(displays()).toHaveLength(1);
  });
});

describe('automatic lifecycle isolation (AC1, AC3)', () => {
  beforeEach(() => resetBrowserState());

  it('does not wire manual DOM data or include manual data in automatic reports', async () => {
    const domSchema = 'https://ns.adobe.com/personalization/dom-action';
    const manual = proposition('manual', domSchema);
    const { fetchPropositions, martechEager } = await setup([manual], {
      analytics: true, trackPageView: true,
    });
    await fetchPropositions(options);
    const automatic = proposition('automatic', domSchema);
    window.__alloyMockHandlers = {
      sendEvent: () => ({ propositions: [automatic] }),
      applyPropositions: () => ({ propositions: [{ id: 'automatic', renderAttempted: true }] }),
    };
    document.body.innerHTML = '<main><div data-block-status="loaded"></div></main>';
    await martechEager();
    await flushAsync();
    expect(alloyCalls('applyPropositions')).toHaveLength(1);
    expect(alloyCalls('applyPropositions')[0].options.propositions.map((p) => p.id))
      .toEqual(['automatic']);
    const pageView = alloyCalls('sendEvent')
      .find((c) => c.options.xdm?.eventType === 'web.webpagedetails.pageViews');
    expect(pageView.options.xdm._experience.decisioning.propositions.map((p) => p.id))
      .toEqual(['automatic']);
    expect(displays()).toHaveLength(0);
  });

  it('does not couple a pending manual fetch to the automatic eager timeout', async () => {
    const { fetchPropositions, martechEager } = await setup([], {
      analytics: true, trackPageView: true, personalizationTimeout: 10,
    });
    let resolveManual;
    window.__alloyMockHandlers.sendEvent = (request) => {
      if (request.type !== 'decisioning.propositionFetch') return {};
      return request.personalization?.decisionScopes?.includes('region-one')
        ? new Promise((resolve) => { resolveManual = resolve; })
        : new Promise(() => {});
    };
    const pending = fetchPropositions(options);
    await martechEager();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    resolveManual({ propositions: [proposition()] });
    const result = await pending;
    expect(result.propositions).toHaveLength(1);
    expect(displays()).toHaveLength(0);
    await result.display(result.propositions[0]);
    expect(displays()).toHaveLength(1);
  });
});
