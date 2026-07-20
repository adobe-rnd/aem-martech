import {
  beforeEach, describe, expect, it,
} from 'vitest';
import {
  alloyCalls, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

describe('initialization guards', () => {
  beforeEach(() => resetBrowserState());

  it('rejects sendEvent with an explicit error before initialization', async () => {
    const { sendEvent } = await importMartech();
    await expect(sendEvent({})).rejects.toThrow(/initialized before the `sendEvent`/);
  });

  it('rejects sendAnalyticsEvent with an explicit error before initialization', async () => {
    const { sendAnalyticsEvent } = await importMartech();
    await expect(sendAnalyticsEvent({ eventType: 'x' })).rejects.toThrow(/initialized/);
  });

  it('throws an explicit error from pushToDataLayer before initialization', async () => {
    const { pushToDataLayer } = await importMartech();
    expect(() => pushToDataLayer({})).toThrow(/initialized/);
  });

  it('throws an explicit error from pushToDataLayer when the data layer is disabled', async () => {
    const { initMartech, pushToDataLayer } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false, dataLayer: false });
    expect(() => pushToDataLayer({})).toThrow(/data layer is disabled/);
  });

  it('returns false from isPersonalizationEnabled before initialization', async () => {
    const { isPersonalizationEnabled } = await importMartech();
    expect(isPersonalizationEnabled()).toBe(false);
  });

  it('rejects getPersonalizationForView without a view name', async () => {
    const { initMartech, getPersonalizationForView } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await expect(getPersonalizationForView()).rejects.toThrow(/viewName/);
  });
});

describe('initMartech validation', () => {
  beforeEach(() => resetBrowserState());

  it('rejects without a datastreamId', async () => {
    const { initMartech } = await importMartech();
    await expect(initMartech({ orgId: 'test-org@AdobeOrg' })).rejects.toThrow(/datastreamId/);
  });

  it('accepts the legacy edgeConfigId instead of datastreamId', async () => {
    const { initMartech } = await importMartech();
    await initMartech(
      { edgeConfigId: 'legacy-id', orgId: 'test-org@AdobeOrg' },
      { personalization: false },
    );
    expect(typeof window.alloy).toBe('function');
  });

  it('rejects without an orgId', async () => {
    const { initMartech } = await importMartech();
    await expect(initMartech({ datastreamId: 'ds' })).rejects.toThrow(/orgId/);
  });

  it('rejects a second initialization', async () => {
    const { initMartech } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    await expect(initMartech(TEST_WEBSDK_CONFIG)).rejects.toThrow(/already initialized/);
  });
});

describe('send failures', () => {
  beforeEach(() => resetBrowserState());

  it('rejects sendAnalyticsEvent when the underlying send fails', async () => {
    window.__alloyMockHandlers = {
      sendEvent: () => { throw new Error('edge down'); },
    };
    const { initMartech, sendAnalyticsEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await expect(sendAnalyticsEvent({ eventType: 'x' })).rejects.toThrow('edge down');
  });

  it('still sends events normally when the send succeeds', async () => {
    const { initMartech, sendAnalyticsEvent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await sendAnalyticsEvent({ eventType: 'ok.event' });
    const evt = alloyCalls('sendEvent').find((c) => c.options.xdm?.eventType === 'ok.event');
    expect(evt).toBeTruthy();
  });
});
