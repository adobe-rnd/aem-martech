import {
  beforeEach, describe, expect, it,
} from 'vitest';
import { importMartech, resetBrowserState, TEST_WEBSDK_CONFIG } from './helpers.js';

const LAUNCH_URLS = [
  'https://assets.adobedtm.com/12345/launch-abcdef.min.js',
  'https://assets.adobedtm.com/12345/launch-fedcba.min.js',
];

describe('martechDelayed launch container loading', () => {
  beforeEach(() => resetBrowserState());

  it('injects a classic script tag for every launch container', async () => {
    const { initMartech, martechDelayed } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false, launchUrls: LAUNCH_URLS });
    const promise = martechDelayed();
    const scripts = [...document.head.querySelectorAll('script')]
      .filter((s) => s.src.includes('adobedtm.com'));
    expect(scripts.map((s) => s.src)).toEqual(LAUNCH_URLS);
    // Classic scripts, not ES modules: Launch code may rely on sloppy-mode semantics
    scripts.forEach((s) => expect(s.type).not.toBe('module'));
    scripts.forEach((s) => s.dispatchEvent(new Event('load')));
    await promise;
  });

  it('rejects when a launch container fails to load', async () => {
    const { initMartech, martechDelayed } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, {
      personalization: false,
      launchUrls: [LAUNCH_URLS[0]],
    });
    const promise = martechDelayed();
    const script = [...document.head.querySelectorAll('script')]
      .find((s) => s.src.includes('adobedtm.com'));
    script.dispatchEvent(new Event('error'));
    await expect(promise).rejects.toThrow();
  });

  it('resolves immediately without launch containers', async () => {
    const { initMartech, martechDelayed } = await importMartech();
    await initMartech(TEST_WEBSDK_CONFIG, { personalization: false });
    await expect(martechDelayed()).resolves.toBeDefined();
  });
});
