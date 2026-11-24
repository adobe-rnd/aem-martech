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
 *
 * Also like the real SDK, propositions `applyPropositions` reports as `renderAttempted` are
 * announced to `window.__alloyMonitors` as rendered right after; set
 * `window.__alloyMockAutoRender = false` to announce rendering from the test instead.
 */
function createInstance(name) {
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
    let result;
    try {
      result = Promise.resolve(handler ? handler(payload) : {});
    } catch (err) {
      return Promise.reject(err);
    }
    if (command === 'applyPropositions' && window.__alloyMockAutoRender !== false) {
      // Like the real SDK, `applyPropositions` resolves before the offers are rendered, and
      // the monitors hear about the rendering afterwards
      result.then((applied) => {
        const rendered = (applied?.propositions || []).filter((p) => p.renderAttempted)
          .map((p) => (payload.propositions || []).find((o) => o.id === p.id) || p);
        if (!rendered.length) return;
        setTimeout(() => {
          const byScope = {};
          rendered.forEach((p) => {
            byScope[p.scope] = [...(byScope[p.scope] || []), { id: p.id, scope: p.scope }];
          });
          (window.__alloyMonitors || []).forEach((m) => m.onContentRendering?.({
            instanceName: name, status: 'rendering-succeeded', payload: byScope,
          }));
        }, 0);
      });
    }
    return result;
  };
  instance.calls = [];
  instance.cancelledCalls = [];
  // Like the real SDK, the live instance does NOT expose a command queue: the stub queue is
  // drained exactly once at load time, and anything pushed to it afterwards is never read
  return instance;
}

(window.__alloyNS || []).forEach((name) => {
  const stub = window[name];
  const instance = createInstance(name);
  (Array.isArray(stub?.q) ? stub.q : []).forEach(([resolve, reject, args]) => {
    instance(...args).then(resolve, reject);
  });
  window[name] = instance;
});

export default {};
