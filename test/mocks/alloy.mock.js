/*
 * Minimal stand-in for alloy.min.js used in tests.
 *
 * On import, it performs the same handover the real WebSDK does: it looks up the instance
 * names registered in `window.__alloyNS`, replaces the command queue stub created by
 * `initAlloyQueue` with a live instance, and drains any commands already queued.
 *
 * The live instance records every command in `instance.calls` (as `{ command, options }`)
 * and resolves them through optional per-command handlers that tests can define via
 * `window.__alloyMockHandlers = { sendEvent: (options) => ({ ... }) }`.
 *
 * Like the real SDK, the `onBeforeEventSend` callback from the `configure` options is
 * invoked for every `sendEvent` command, and returning `false` from it cancels the event.
 */
function createInstance() {
  const instance = (command, options = {}) => {
    let payload = options;
    if (command === 'configure') {
      instance.config = options;
    }
    if (command === 'sendEvent') {
      payload = {
        ...options,
        xdm: { ...(options.xdm || {}) },
        ...(options.data ? { data: JSON.parse(JSON.stringify(options.data)) } : {}),
      };
      const cb = instance.config?.onBeforeEventSend;
      if (cb && cb(payload) === false) {
        instance.cancelledCalls.push({ command, options: payload });
        return Promise.resolve({});
      }
    }
    instance.calls.push({ command, options: payload });
    const handler = window.__alloyMockHandlers?.[command];
    try {
      return Promise.resolve(handler ? handler(payload) : {});
    } catch (err) {
      return Promise.reject(err);
    }
  };
  instance.calls = [];
  instance.cancelledCalls = [];
  // The stub defers queue pushes with setTimeout, so some commands may only be pushed after
  // this module has loaded. Mimic a live queue by executing those pushes directly.
  instance.q = {
    push: ([resolve, reject, args]) => {
      instance(...args).then(resolve, reject);
    },
  };
  return instance;
}

(window.__alloyNS || []).forEach((name) => {
  const stub = window[name];
  const instance = createInstance();
  (Array.isArray(stub?.q) ? stub.q : []).forEach(([resolve, reject, args]) => {
    instance(...args).then(resolve, reject);
  });
  window[name] = instance;
});

export default {};
