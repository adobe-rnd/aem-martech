// @vitest-environment-options { "url": "https://main--site--org.aem.network/" }
import {
  beforeEach, describe, expect, it,
} from 'vitest';
import {
  alloyCalls, importMartech, resetBrowserState, TEST_WEBSDK_CONFIG,
} from './helpers.js';

describe('debug logging', () => {
  beforeEach(() => resetBrowserState());

  it('is on for .aem.network QA hosts', async () => {
    const { initMartech } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG);
    const [configure] = alloyCalls('configure');
    expect(window.location.hostname).toBe('main--site--org.aem.network');
    expect(configure.options.debugEnabled).toBe(true);
  });
});
