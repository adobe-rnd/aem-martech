import { vi } from 'vitest';

const MANAGED_GLOBALS = ['__alloyNS', 'alloy', 'adobeDataLayer', '__alloyMockHandlers'];

/**
 * Resets the browser globals and the module registry so every test gets a fresh copy of the
 * library (it keeps module-level state such as the config singleton and pending queues).
 * @param {String[]} [extraGlobals] additional window properties to clean up
 */
export function resetBrowserState(extraGlobals = []) {
  [...MANAGED_GLOBALS, ...extraGlobals].forEach((key) => {
    delete window[key];
  });
  document.head.innerHTML = '';
  // Replace the body node entirely so MutationObservers registered by a previous test
  // (the library never disconnects them) do not fire into stale module instances
  const body = document.createElement('body');
  body.innerHTML = '<main></main>';
  document.documentElement.replaceChild(body, document.body);
  vi.resetModules();
}

/**
 * Imports a fresh copy of the library (call `resetBrowserState` first).
 * @returns {Promise<Object>} the module exports
 */
export function importMartech() {
  return import('../src/index.js');
}

/**
 * Flushes pending microtasks and timer-based callbacks (like the alloy stub's deferred
 * queue pushes).
 */
export async function flushAsync() {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Returns the alloy mock calls for a given command.
 * @param {String} command the alloy command name
 * @param {String} [instanceName] the alloy instance name
 */
export function alloyCalls(command, instanceName = 'alloy') {
  return (window[instanceName]?.calls || []).filter((c) => c.command === command);
}

export const TEST_WEBSDK_CONFIG = { datastreamId: 'test-datastream', orgId: 'test-org@AdobeOrg' };
