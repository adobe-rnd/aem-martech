import {
  beforeEach, describe, expect, it,
} from 'vitest';
import {
  alloyCalls, flushAsync, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

const consentValue = () => alloyCalls('setConsent')[0]?.options.consent[0].value;

describe('updateUserConsent granular marketing consent', () => {
  beforeEach(() => resetBrowserState());

  it('reports marketing.any as granted when any channel is consented to', async () => {
    const { initMartech, updateUserConsent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await updateUserConsent({
      collect: true,
      marketing: { email: false, push: true, sms: false },
    });
    const value = consentValue();
    expect(value.marketing.any.val).toBe('y');
    expect(value.marketing.email.val).toBe('n');
    expect(value.marketing.push.val).toBe('y');
    expect(value.marketing.sms.val).toBe('n');
  });

  it('reports marketing.any as denied when no channel is consented to', async () => {
    const { initMartech, updateUserConsent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await updateUserConsent({
      collect: true,
      marketing: { email: false, push: false, sms: false },
    });
    expect(consentValue().marketing.any.val).toBe('n');
  });

  it('maps a boolean marketing consent to all channels', async () => {
    const { initMartech, updateUserConsent } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    await updateUserConsent({ collect: true, marketing: false });
    const value = consentValue();
    expect(value.marketing.any.val).toBe('n');
    expect(value.marketing.preferred).toBe('email');
  });
});

describe('updateUserConsent queuing', () => {
  beforeEach(() => resetBrowserState());

  it('resolves the promise only once the queued consent has been applied', async () => {
    const { initMartech, updateUserConsent, martechLazy } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    let applied = false;
    const promise = updateUserConsent({ collect: true }).then(() => { applied = true; });
    await flushAsync();
    expect(applied).toBe(false);
    expect(alloyCalls('setConsent').length).toBe(0);
    await martechLazy();
    await promise;
    expect(applied).toBe(true);
    expect(alloyCalls('setConsent').length).toBe(1);
  });
});
