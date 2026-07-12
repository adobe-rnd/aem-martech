/* eslint-disable no-underscore-dangle */
/**
 * Default configuration for the library.
 * @typedef {Object} MartechConfig
 * @property {Boolean} analytics Indicates whether analytics tracking should be enabled
 *                               (defaults to true)
 * @property {String} alloyInstanceName The name of the alloy instance in the global scope
 *                                      (defaults to "alloy")
 * @property {Boolean} dataLayer Indicates whether the data layer should be used
 *                               (defaults to true)
 * @property {String} dataLayerInstanceName The name of the data ayer instance in the global scope
 *                                          (defaults to "adobeDataLayer")
 * @property {Boolean} includeDataLayerState Whether to include the datalayer state on every
 *                                           event that is sent by alloy (defaults to true)
 * @property {String[]} launchUrls A list of launch container URLs to load (defults to empty list)
 * @property {Boolean} personalization Indicates whether Adobe Target should be enabled
 *                                     (defaults to true)
 * @property {Boolean} performanceOptimized Whether to use the agressive performance optimized
 *                                          instrumentation, or the more traditional alloy approach
 *                                          (defaults to true)
 * @property {Number} personalizationTimeout Indicates the amount of time to wait before bailing
 *                                           out on the personalization and continue rendering the
 *                                           page (defaults to 1s)
 * @property {Boolean} trackPageView Whether the library should automatically send a page view
 *                                   event on page activation. When disabled, a
 *                                   `decisioning.propositionDisplay` event is sent instead so
 *                                   proposition display is still reported to Target without
 *                                   triggering an extra page view. Disable this if a TMS
 *                                   (e.g. Ensighten) already handles page view tracking.
 *                                   (defaults to true)
 * @property {Function} shouldProcessEvent Optional function to filter which events are sent to
 *                                         analytics. It gets the datalayer event as a parameter
 *                                         and returns a boolean. Return true to process the event,
 *                                         false to ignore it. The default is a function that
 *                                         always returns true.
 * @property {String[]} [decisionScopes]   Additional decision scopes to request beyond the
 *                                         default `__view__` scope. The scopes are included
 *                                         in both the eager `propositionFetch` (performance
 *                                         path) and the `martechLazy` `sendEvent`
 *                                         (non-performance path), with `__view__` always
 *                                         included.
 *                                         (defaults to [])
 * @property {String|null} propositionScopeAttribute The `data-*` attribute name the plugin
 *                                          scans for to auto-discover decision scopes from
 *                                          the DOM. Multiple scopes per element supported
 *                                          via comma-separated values. Set to `null` to
 *                                          disable auto-discovery. Auto-discovery only runs in
 *                                          the performance-optimized eager path (the default);
 *                                          when `performanceOptimized` is false, request scopes
 *                                          explicitly via `decisionScopes`. (defaults to "mbox")
 * @property {String} discoveredScopeActionType The default `actionType` for auto-discovered
 *                                          scopes when neither the offer nor the section's
 *                                          `data-mbox-action` attribute specifies one.
 *                                          Valid values: 'setHtml', 'replaceHtml',
 *                                          'appendHtml'. (defaults to "setHtml")
 */
const SCHEMA_DOM_ACTION = 'https://ns.adobe.com/personalization/dom-action';
const SCHEMA_HTML_CONTENT_ITEM = 'https://ns.adobe.com/personalization/html-content-item';
// Selectors that target the document chrome rather than visible content. If a dom-action item
// arrives with one of these, alloy's applyPropositions injects directly into <head>/<body>/<html>.
const NON_VISUAL_SELECTORS = new Set(['head', 'body', 'html']);
// Action types the plugin understands for applying an offer to its target element.
const VALID_ACTION_TYPES = new Set(['setHtml', 'replaceHtml', 'appendHtml']);

export const DEFAULT_CONFIG = {
  analytics: true,
  alloyInstanceName: 'alloy',
  trackPageView: true,
  dataLayer: true,
  dataLayerInstanceName: 'adobeDataLayer',
  includeDataLayerState: true,
  launchUrls: [],
  personalization: true,
  performanceOptimized: true,
  personalizationTimeout: 1000,
  shouldProcessEvent: () => true,
  decisionScopes: [],
  propositionScopeAttribute: 'mbox',
  discoveredScopeActionType: 'setHtml',
};

let config;
let alloyConfig;
let isAlloyConfigured = false;
const pendingAlloyCommands = [];
const pendingDatalayerEvents = [];
/** IDs of propositions that have been actually displayed (direct-inject or alloy-applied). */
const renderedPropositionIds = new Set();
/** IDs of propositions that have already been reported via a manual sendEvent call. */
const reportedPropositionIds = new Set();
/**
 * Scope -> { selector, actionType } map for Form-Based html-content-item offers, built only by
 * `data-mbox` auto-discovery (see discoverPropositionScopes). Internal — there is no consumer
 * config for hand-mapping scopes to selectors; authors declare targets via section metadata.
 */
const discoveredScopeMeta = new Map();

const debug = (label = 'martech', ...args) => {
  if (alloyConfig?.debugEnabled) {
    // eslint-disable-next-line no-console
    console.debug.call(null, `[${label}]`, ...args);
  }
};

/**
 * Decides whether a selector is safe to hand to alloy or to a direct-injection target
 * lookup. Rejects empty/non-string values, document-chrome selectors (head/body/html,
 * case- and whitespace-insensitive), and syntactically-invalid CSS. Debug-logs the
 * reason on every rejection, prefixed with the supplied context label for traceability.
 *
 * @param {String} rawSelector The raw selector — from `item.data.selector`, from the
 *                              auto-discovered `data-mbox` synthetic selector, or any
 *                              other untrusted source.
 * @param {String} contextLabel Free-form short label like `html-content-item scope "foo"`.
 *                              Surfaced in debug logs.
 * @returns {Boolean} true if the selector is non-empty, visual, and parseable; false
 *                    otherwise.
 */
function isVisualSelector(rawSelector, contextLabel) {
  if (!rawSelector || typeof rawSelector !== 'string') {
    debug('martech', `dropping ${contextLabel}: selector is empty or non-string`);
    return false;
  }
  const normalized = rawSelector.trim().toLowerCase();
  if (NON_VISUAL_SELECTORS.has(normalized)) {
    debug('martech', `dropping ${contextLabel}: non-visual selector "${rawSelector}"`);
    return false;
  }
  try {
    document.querySelector(rawSelector);
  } catch (err) {
    debug('martech', `dropping ${contextLabel}: invalid CSS — "${rawSelector}" (${err.message})`);
    return false;
  }
  return true;
}

/**
 * Triggers the callback when the page is actually activated,
 * This is to properly handle speculative page prerendering and marketing events.
 * @param {Function} cb The callback to run
 */
async function onPageActivation(cb) {
  // Speculative prerender-aware execution.
  // See: https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API#unsafe_prerendering
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', cb, { once: true });
  } else {
    cb();
  }
}

/**
 * Runs a promise with a timeout that rejects it if the time has passed.
 * @param {Promise} promise The base promise to use
 * @param {Number} [timeout=1000] The timeout to use in ms
 * @returns the promise result, or a rejected promise if it did not resolve in time
 */
function promiseWithTimeout(promise, timeout = 1000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(reject, timeout); }),
  ]).finally((result) => {
    clearTimeout(timer);
    return result;
  });
}

/**
 * Error handler for rejected promises.
 * @param {Error} error The base error
 * @throws a decorated error that can be intercepted by RUM handlers.
 */
function handleRejectedPromise(error) {
  const [, file, line] = error.stack.split('\n')[1].trim().split(' ')[1].match(/(.*):(\d+):(\d+)/);
  error.sourceURL = file;
  error.line = line;
  throw error;
}

/**
 * Initializes a queue for the alloy instance in order to be ready to receive events before the
 * alloy library is fully loaded.
 * Documentation:
 * https://experienceleague.adobe.com/docs/experience-platform/edge/fundamentals/installing-the-sdk.html?lang=en#adding-the-code
 * @param {String} instanceName The name of the instance in the blobal scope
 */
function initAlloyQueue(instanceName) {
  if (window[instanceName]) {
    return;
  }
  // eslint-disable-next-line no-underscore-dangle
  (window.__alloyNS ||= []).push(instanceName);
  window[instanceName] = (...args) => new Promise((resolve, reject) => {
    window.setTimeout(() => {
      window[instanceName].q.push([resolve, reject, args]);
    });
  });
  window[instanceName].q = [];
}

/**
 * Initializes a queue for the datalayer in order to be ready to receive events before the
 * ACDL library is fully loaded.
 * Documentation:
 * https://github.com/adobe/adobe-client-data-layer/wiki#setup
 * @param {String} instanceName The name of the instance in the blobal scope
 */
function initDatalayer(instanceName) {
  window[instanceName] ||= [];
  if (instanceName !== 'adobeDataLayer') {
    window[instanceName] ||= [];
  }
}

/**
 * Returns the default alloy configuration
 * Documentation:
 * https://experienceleague.adobe.com/docs/experience-platform/edge/fundamentals/configuring-the-sdk.html
 */
function getDefaultAlloyConfiguration() {
  const { hostname } = window.location;

  return {
    context: ['web', 'device', 'environment'],
    // enable while debugging
    debugEnabled: hostname === 'localhost' || hostname.endsWith('.hlx.page') || hostname.endsWith('.aem.page') || hostname.endsWith('.aem.network'),
    // wait for exlicit consent before tracking anything
    defaultConsent: 'pending',
  };
}

/**
 * Just a proxy method for the `alloy('sendEvent', …)` method
 * @param {Object} payload the payload to send
 * @returns {Promise<*>} a promise that the event was sent
 */
export async function sendEvent(payload) {
  // eslint-disable-next-line no-console
  console.assert(config.alloyInstanceName && window[config.alloyInstanceName], 'Martech needs to be initialized before the `sendEvent` method is called');
  return window[config.alloyInstanceName]('sendEvent', payload);
}

/**
 * Sends an analytics event to alloy
 * @param {Object} xdmData the xdm data object to send
 * @param {Object} [dataMapping] additional data mapping for the event
 * @param {Object} [configOverrides] optional config overrides
 * @returns {Promise<*>} a promise that the event was sent
 */
export async function sendAnalyticsEvent(xdmData, dataMapping = {}, configOverrides = {}) {
  // eslint-disable-next-line no-console
  console.assert(config.alloyInstanceName && window[config.alloyInstanceName], 'Martech needs to be initialized before the `sendAnalyticsEvent` method is called');
  // eslint-disable-next-line no-console
  console.assert(config.analytics, 'Analytics tracking is disabled in the martech config');
  try {
    return sendEvent({
      documentUnloading: true,
      xdm: xdmData,
      data: dataMapping,
      edgeConfigOverrides: configOverrides,
    });
  } catch (err) {
    handleRejectedPromise(new Error(err));
    return Promise.reject(new Error(err));
  }
}

/**
 * Loads the alloy library and configures it.
 * Documentation:
 * https://experienceleague.adobe.com/docs/experience-platform/edge/fundamentals/configuring-the-sdk.html
 * @param {String} instanceName The name of the instance in the blobal scope
 * @param {Object} webSDKConfig The configuration to use
 * @returns a promise that the library was loaded and configured
 */
async function loadAndConfigureAlloy(instanceName, webSDKConfig) {
  await import('./alloy.min.js');
  try {
    await window[instanceName]('configure', webSDKConfig);
    isAlloyConfigured = true;
    pendingAlloyCommands.forEach((fn) => fn());
    pendingDatalayerEvents.forEach((args) => sendAnalyticsEvent(...args));
  } catch (err) {
    handleRejectedPromise(new Error(err));
  }
}

/**
 * Runs the specified function on every decorated block/section
 * @param {Function} fn The function to call
 */
function onDecoratedElement(fn) {
  // Apply propositions to all already decorated blocks/sections
  if (document.querySelector('[data-block-status="loaded"],[data-section-status="loaded"]')) {
    fn();
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.target.tagName === 'BODY'
      || m.target.dataset.sectionStatus === 'loaded'
      || m.target.dataset.blockStatus === 'loaded')) {
      fn();
    }
  });
  // Watch sections and blocks being decorated async
  observer.observe(document.querySelector('main'), {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-block-status', 'data-section-status'],
  });
  // Watch anything else added to the body
  document.querySelectorAll('body').forEach((el) => {
    observer.observe(el, { childList: true });
  });
}

/**
 * Pushes data to the data layer
 * @param {Object} payload the data to push
 */
export function pushToDataLayer(payload) {
  // eslint-disable-next-line no-console
  console.assert(config.dataLayerInstanceName && window[config.dataLayerInstanceName], 'Martech needs to be initialized before the `pushToDataLayer` method is called');
  window[config.dataLayerInstanceName].push(payload);
}

/**
 * Pushes an event to the data layer
 * @param {String} event the name of the event to push
 * @param {Object} xdm the xdm data object to send
 * @param {Object} [data] additional data mapping for the event
 * @param {Object} [configOverrides] optional configuration overrides
 */
export function pushEventToDataLayer(event, xdm, data, configOverrides) {
  pushToDataLayer({
    event, xdm, data, configOverrides,
  });
}

/**
 * Loads the ACDL library.
 * @returns the ACDL instance
 */
async function loadAndConfigureDataLayer() {
  await import('./acdl.min.js');
  if (config.analytics) {
    if (config.dataLayerInstanceName !== 'adobeDataLayer') {
      window.adobeDataLayer.push((dl) => {
        window[config.dataLayerInstanceName] = dl;
      });
    }
    window[config.dataLayerInstanceName].push((dl) => {
      dl.addEventListener('adobeDataLayer:event', (payload) => {
        const eventType = payload.event;
        const args = [
          { eventType, ...payload.xdm },
          payload.data,
          payload.configOverrides,
        ];

        // Check whether the event should be processed or not
        if (!config.shouldProcessEvent(payload)) {
          return;
        }

        delete payload.event;

        if (!isAlloyConfigured) {
          pendingDatalayerEvents.push(args);
        } else {
          sendAnalyticsEvent(...args);
        }
      });
    });
  }
  [...document.querySelectorAll('[data-block-data-layer]')].forEach((el) => {
    let data;
    try {
      data = JSON.parse(el.dataset.blockDataLayer);
    } catch (err) {
      data = {};
    }
    if (!el.id) {
      const index = [...document.querySelectorAll(`.${el.classList[0]}`)].indexOf(el);
      el.id = `${data.parentId ? `${data.parentId}-` : ''}${index + 1}`;
    }
    window[config.dataLayerInstanceName].push({
      blocks: { [el.id]: data },
    });
  });
}

/**
 * Sets Adobe standard v2.0 consent for alloy based on the input
 * Documentation:
 * https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/adobe/dataset#structure
 * https://experienceleague.adobe.com/en/docs/experience-platform/xdm/data-types/consents
 * @param {Object} config The consent config to use
 * @param {Boolean} [config.collect] Whether data collection is allowed
 * @param {Boolean|Object} [config.marketing] Whether data can be used for marketing purposes
 * @param {String} [config.marketing.preferred] The preferred medium for marketing communication
 * @param {Boolean} [config.marketing.any] Whether any marketing channels are consented to or not
 * @param {Boolean} [config.marketing.email] Whether marketing emails are consented to or not
 * @param {Boolean} [config.marketing.push] Whether marketing push notifications are consented to
 * @param {Boolean} [config.marketing.sms] Whether marketing messages are consented to or not
 * @param {Boolean} [config.personalize] Whether data can be used for personalization purposes
 * @param {Boolean} [config.share] Whether data can be shared/sold to 3rd parties
 * @returns {Promise<*>} a promise that the consent setting shave been updated
 */
export async function updateUserConsent(consent) {
  // eslint-disable-next-line no-console
  console.assert(config.alloyInstanceName, 'Martech needs to be initialized before the `updateUserConsent` method is called');

  let marketingConfig;
  if (typeof consent.marketing === 'boolean') {
    marketingConfig = {
      any: { val: consent.marketing ? 'y' : 'n' },
      preferred: 'email',
    };
  } else if (typeof consent.marketing === 'object') {
    marketingConfig = {
      preferred: consent.marketing.preferred || 'email',
      any: {
        val: consent.marketing.email ? 'y' : 'n',
      },
      email: {
        val: consent.marketing.email ? 'y' : 'n',
      },
      push: {
        val: consent.marketing.push ? 'y' : 'n',
      },
      sms: {
        val: consent.marketing.sms ? 'y' : 'n',
      },
    };
  }
  const fn = () => window[config.alloyInstanceName]('setConsent', {
    consent: [{
      standard: 'Adobe',
      version: '2.0',
      value: {
        collect: { val: consent.collect ? 'y' : 'n' },
        marketing: marketingConfig,
        personalize: {
          content: { val: consent.personalize ? 'y' : 'n' },
        },
        share: { val: consent.share ? 'y' : 'n' },
      },
    }],
  });
  if (isAlloyConfigured) {
    return fn();
  }
  pendingAlloyCommands.push(fn);
  return Promise.resolve();
}

let response;

/**
 * Resolves the target selector and actionType for a Form-Based html-content-item.
 * Priority: selector embedded in item data (DA "Send to Target" offers carry this automatically)
 * > the synthetic selector auto-discovered from the section's `data-mbox` attribute.
 * @returns {{selector: String, actionType: String}|null} null when no selector can be resolved
 */
function resolveHtmlContentTarget(item, scope) {
  const embedded = item?.data?.selector;
  const discovered = discoveredScopeMeta.get(scope);
  const selector = embedded || discovered?.selector;
  if (!isVisualSelector(selector, `html-content-item scope "${scope}"`)) {
    return null;
  }
  const actionType = item?.data?.actionType
    || discovered?.actionType
    || 'setHtml';
  return { selector, actionType };
}

// Marker class added to every element we've already processed. The :not(.martech-mbox-scanned)
// filter on the discovery selector makes the per-tick re-scan O(new-elements), not O(all-mboxes).
const SCANNED_MARKER = 'martech-mbox-scanned';

/**
 * Scans the DOM under `root` for elements carrying the configured proposition-scope
 * attribute (default `data-mbox`) and registers a synthetic-class selector + actionType
 * per scope into the internal `discoveredScopeMeta` map. Returns the discovered scope names
 * so the caller can merge them into `config.decisionScopes`. Idempotent — elements marked
 * with the SCANNED_MARKER class are skipped on subsequent calls.
 *
 * @param {Document|Element} root The DOM root to scan.
 * @returns {String[]} Scope names discovered during this call only (not previously-scanned).
 */
function discoverPropositionScopes(root) {
  if (!config.propositionScopeAttribute) return [];
  const attr = config.propositionScopeAttribute;
  const selector = `[data-${attr}]:not(.${SCANNED_MARKER})`;
  const elements = root.querySelectorAll(selector);
  const newScopes = [];
  elements.forEach((el) => {
    const raw = el.getAttribute(`data-${attr}`);
    if (!raw) {
      el.classList.add(SCANNED_MARKER);
      return;
    }
    const scopes = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const elementAction = el.getAttribute(`data-${attr}-action`);
    let actionType;
    if (elementAction && VALID_ACTION_TYPES.has(elementAction)) {
      actionType = elementAction;
    } else {
      if (elementAction) {
        debug('martech', `ignoring invalid data-${attr}-action="${elementAction}"; valid values: setHtml, replaceHtml, appendHtml`);
      }
      // Fall back to the configured default, validating it too — a bad config value shouldn't
      // be handed to alloy as an actionType.
      const configured = config.discoveredScopeActionType;
      if (configured && !VALID_ACTION_TYPES.has(configured)) {
        debug('martech', `invalid discoveredScopeActionType "${configured}"; using "setHtml"`);
      }
      actionType = VALID_ACTION_TYPES.has(configured) ? configured : 'setHtml';
    }
    scopes.forEach((scope) => {
      const sanitized = scope.replace(/[^a-zA-Z0-9_-]/g, '-');
      if (sanitized !== scope) {
        debug('martech', `mbox name "${scope}" sanitized to "${sanitized}" for CSS class`);
      }
      const scopeSelector = `.martech-mbox-${sanitized}`;
      // Distinct raw scopes can sanitize to the same class (e.g. "a.b" and "a-b"). Warn so a
      // silent wrong-element application is at least discoverable in debug.
      const collision = [...discoveredScopeMeta]
        .find(([s, m]) => s !== scope && m.selector === scopeSelector);
      if (collision) {
        debug('martech', `mbox "${scope}" and "${collision[0]}" both map to ${scopeSelector}; an offer for one may target the other's element`);
      }
      el.classList.add(`martech-mbox-${sanitized}`);
      discoveredScopeMeta.set(scope, { selector: scopeSelector, actionType });
      newScopes.push(scope);
    });
    el.classList.add(SCANNED_MARKER);
  });
  return newScopes;
}

/**
 * Fires a single `decisioning.propositionDisplay` event covering one or more propositions
 * alloy has rendered, so Target Activity reporting records an impression. Idempotent per
 * proposition id for the life of the page.
 */
function reportPropositionDisplay(instanceName, propositions) {
  // Idempotent: each proposition is reported at most once for the life of the page, so this is
  // safe to call per decoration tick (and from deferred page-activation callbacks).
  const toReport = (propositions || []).filter((p) => p && !reportedPropositionIds.has(p.id));
  if (!toReport.length) return;
  toReport.forEach((p) => {
    renderedPropositionIds.add(p.id);
    reportedPropositionIds.add(p.id);
  });
  window[instanceName]('sendEvent', {
    xdm: {
      eventType: 'decisioning.propositionDisplay',
      _experience: {
        decisioning: {
          propositions: toReport.map((p) => ({
            id: p.id,
            scope: p.scope,
            scopeDetails: p.scopeDetails,
          })),
          propositionEventType: { display: 1 },
        },
      },
    },
  }).catch(() => { /* reporting failure shouldn't break the page */ });
}

/**
 * Fetching propositions from the backend and applying the propositions as the AEM EDS page loads
 * its content async.
 * Documentation:
 * https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/personalization/rendering-personalization-content#manual
 * @param {String} instanceName The name of the instance in the blobal scope
 * @returns a promise that the propositions were retrieved and will be applied as the page renders
 */
async function applyPropositions(instanceName) {
  const discoveredScopes = discoverPropositionScopes(document);
  if (discoveredScopes.length) {
    debug('martech', `auto-discovered ${discoveredScopes.length} scope(s):`, discoveredScopes);
    config.decisionScopes = [
      ...new Set([...(config.decisionScopes || []), ...discoveredScopes]),
    ];
  }

  // Get the decisions, but don't render them automatically
  // so we can hook up into the AEM EDS page load sequence
  const renderDecisionResponse = await sendEvent({
    type: 'decisioning.propositionFetch',
    renderDecisions: false,
    personalization: {
      sendDisplayEvent: false,
      // Always request `__view__` alongside any named scopes. The Web SDK treats
      // `decisionScopes` as the exact set to fetch, so omitting `__view__` here would silently
      // drop all VEC / page-load (view) propositions on any page that has a discovered mbox.
      decisionScopes: [...new Set(['__view__', ...(config.decisionScopes || [])])],
    },
  });
  response = renderDecisionResponse;
  if (!renderDecisionResponse?.propositions) {
    return [];
  }
  // dom-action (VEC) items carry their own selector and are applied by alloy directly, exactly
  // as upstream does. html-content-item (Form-Based) offers don't carry a selector, so resolve a
  // target from the offer or from `data-mbox` auto-discovery and hand it to alloy via the metadata
  // map; drop items with no resolvable selector so they aren't retried every tick.
  const htmlContentMetadata = {};
  let propositions = window.structuredClone(renderDecisionResponse.propositions)
    .filter((p) => p.items.some(
      (i) => i.schema === SCHEMA_DOM_ACTION || i.schema === SCHEMA_HTML_CONTENT_ITEM,
    ))
    .map((p) => ({
      ...p,
      items: p.items.map((item) => {
        if (item.schema === SCHEMA_HTML_CONTENT_ITEM) {
          const target = resolveHtmlContentTarget(item, p.scope);
          if (!target) {
            debug('martech', `dropping html-content-item with no resolvable selector for scope "${p.scope}"`);
            return null;
          }
          htmlContentMetadata[p.scope] = target;
        }
        return item;
      }).filter(Boolean),
    }))
    .filter((p) => p.items.length > 0);
  onDecoratedElement(async () => {
    const lateScopes = discoverPropositionScopes(document);
    lateScopes.forEach((scope) => {
      if (!response?.propositions?.some((p) => p.scope === scope)) {
        debug('martech', `mbox "${scope}" discovered after eager propositionFetch; not personalized this load`);
      }
    });
    if (!propositions.length) {
      return;
    }
    const applyOptions = { propositions };
    if (Object.keys(htmlContentMetadata).length) {
      applyOptions.metadata = htmlContentMetadata;
    }
    const appliedPropositions = await window[instanceName](
      'applyPropositions',
      applyOptions,
    );
    // Single guarded pass over the applied items: drop rendered propositions from the retry set
    // and collect the freshly-rendered ones to report. Reporting display *here* (as alloy
    // actually renders, across decoration ticks) rather than at page-activation avoids the race
    // where activation fires before async decoration has applied anything.
    const renderedNow = [];
    appliedPropositions.propositions?.forEach((appliedItem) => {
      if (!appliedItem.renderAttempted) return;
      propositions = propositions.filter((p) => p.id !== appliedItem.id);
      if (!renderedPropositionIds.has(appliedItem.id)) {
        const original = response?.propositions?.find((p) => p.id === appliedItem.id);
        renderedNow.push({
          id: appliedItem.id,
          scope: appliedItem.scope ?? original?.scope,
          scopeDetails: appliedItem.scopeDetails ?? original?.scopeDetails,
        });
      }
      renderedPropositionIds.add(appliedItem.id);
    });
    // Prerender-aware: defer the display impression until the page is actually activated.
    if (renderedNow.length) {
      onPageActivation(() => reportPropositionDisplay(instanceName, renderedNow));
    }
  });
  return renderDecisionResponse;
}

/**
 * Initializes the martech library.
 * Documentation:
 * https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/commands/configure/overview
 * @param {Object} webSDKConfig the WebSDK config
 * @param {Object} [martechConfig] the martech config
 * @param {String} [martechConfig.alloyInstanceName="alloy"] the WebSDK instance name in the global
 *                 scope (defaults to `alloy`)
 * @param {String} [martechConfig.dataLayerInstanceName="adobeDataLayer"] the ACDL instance name in
 *                  the global scope (defaults to `adobeDataLayer`)
 * @param {String[]} [martechConfig.launchUrls] a list of Launch configurations to load
 * @returns a promise that the library was loaded and configured
 */
export async function initMartech(webSDKConfig, martechConfig = {}) {
  // eslint-disable-next-line no-console
  console.assert(!config, 'Martech already initialized.');
  // eslint-disable-next-line no-console
  console.assert(webSDKConfig?.datastreamId || webSDKConfig?.edgeConfigId, 'Please set your "datastreamId" for the WebSDK config.');
  // eslint-disable-next-line no-console
  console.assert(webSDKConfig?.orgId, 'Please set your "orgId" for the WebSDK config.');

  config = {
    ...DEFAULT_CONFIG,
    ...martechConfig,
  };

  renderedPropositionIds.clear();
  reportedPropositionIds.clear();
  discoveredScopeMeta.clear();
  initAlloyQueue(config.alloyInstanceName);
  if (config.dataLayer) {
    initDatalayer(config.dataLayerInstanceName);
  }

  alloyConfig = {
    ...getDefaultAlloyConfiguration(),
    ...webSDKConfig,
    onBeforeEventSend: (payload) => {
      // ACDL is initialized in the lazy phase, so fetching from the JS array as a fallback during
      // the eager phase
      if (config.includeDataLayerState) {
        const dlState = window.adobeDataLayer.getState
          ? window.adobeDataLayer.getState()
          : window.adobeDataLayer[0];
        payload.xdm = {
          ...payload.xdm,
          ...dlState,
        };
      }

      payload.data ||= {};
      payload.data.__adobe ||= {};
      // Documentation: https://experienceleague.adobe.com/en/docs/analytics/implementation/aep-edge/data-var-mapping
      payload.data.__adobe.analytics ||= {};
      // Documentation: https://experienceleague.adobe.com/en/docs/platform-learn/migrate-target-to-websdk/send-parameters
      payload.data.__adobe.target ||= {};

      // Let project override the data if needed
      if (webSDKConfig?.onBeforeEventSend) {
        try {
          const shouldSend = webSDKConfig?.onBeforeEventSend(payload);
          if (shouldSend === false) {
            return false;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('Error in "onBeforeEventSend" handler:', err);
          return false;
        }
      }
      if (!Object.keys(payload.data.__adobe.target).length) {
        delete payload.data.__adobe.target;
      }
      if (!Object.keys(payload.data.__adobe.analytics).length) {
        delete payload.data.__adobe.analytics;
      }
      if (!Object.keys(payload.data.__adobe).length) {
        delete payload.data.__adobe;
      }
      if (!Object.keys(payload.data).length) {
        delete payload.data;
      }
      return true;
    },
  };
  if (config.personalization) {
    await loadAndConfigureAlloy(config.alloyInstanceName, alloyConfig);
  }
  return Promise.resolve();
}

export function initRumTracking(sampleRUM, options = {}) {
  // Load the RUM enhancer so we can map all RUM events even on non-sampled pages
  if (options.withRumEnhancer) {
    const script = document.createElement('script');
    script.src = new URL('.rum/@adobe/helix-rum-enhancer@^1/src/index.js', sampleRUM.baseURL).href;
    document.head.appendChild(script);
  }

  // Define RUM tracking function
  let track;
  if (sampleRUM.always) {
    track = (ev, cb) => sampleRUM.always.on(ev, (data) => {
      debug('rum', ev, data);
      cb(data);
    });
  } else {
    track = (ev, cb) => document.addEventListener('rum', (data) => {
      debug('rum', ev, data);
      cb(data);
    });
  }
  return track;
}

/**
 * Checks whether personalization is enabled or not.
 * @returns a `true` if personalization is enabled, or `false` otherwise
 */
export function isPersonalizationEnabled() {
  return config.personalization;
}

/**
 * Retrieves the list of propositions to personalize the specified view.
 * @param {String} viewName The view name, or defaults to the page context
 * @returns a promise that resolves to an array of propositions to be used with
 * `applyPersonalization`.
 */
export async function getPersonalizationForView(viewName) {
  // eslint-disable-next-line no-console
  console.assert(viewName, 'The `viewName` parameter needs to be defined');
  return sendEvent({
    renderDecisions: true,
    xdm: {
      web: {
        webPageDetails: { viewName },
      },
    },
  });
}

/**
 * Applies the specified propositions to personalize the current page.
 * @param {String} viewName The view name the personalization applies to
 * @returns a promise that the propositions were applied
 */
export async function applyPersonalization(viewName) {
  // eslint-disable-next-line no-console
  console.assert(viewName, 'The `viewName` parameter needs to be defined');
  return window[config.alloyInstanceName]('applyPropositions', { viewName });
}

/**
 * Martech logic to be executed in the eager phase.
 * @returns a promise that the eager logic was executed
 */
export async function martechEager() {
  if (config.personalization && config.performanceOptimized) {
    // eslint-disable-next-line no-console
    console.assert(config.alloyInstanceName && window[config.alloyInstanceName], 'Martech needs to be initialized before the `martechEager` method is called');
    return promiseWithTimeout(
      applyPropositions(config.alloyInstanceName),
      config.personalizationTimeout,
    ).then((result) => {
      // Page-view tracking is decoupled from proposition rendering. Proposition *display* events
      // are emitted from applyPropositions as each proposition actually renders (see
      // reportPropositionDisplay), so they aren't lost to the race between page activation and
      // the async decoration ticks that apply offers. Here we only fire the plain page view.
      if (config.trackPageView) {
        onPageActivation(() => {
          sendAnalyticsEvent({ eventType: 'web.webpagedetails.pageViews' });
        });
      }
      return result;
    }).catch(() => {
      if (alloyConfig.debugEnabled) {
        // eslint-disable-next-line no-console
        console.warn('Could not apply personalization in time. Either backend is taking too long, or user did not give consent in time.');
      }
    });
  }
  if (config.personalization) {
    document.body.style.visibility = 'hidden';
  }
  return Promise.resolve();
}

/**
 * Martech logic to be executed in the lazy phase.
 * @returns a promise that the lazy logic was executed
 */
export async function martechLazy() {
  if (config.dataLayer) {
    await loadAndConfigureDataLayer({});
  }

  if (!config.personalization && config.performanceOptimized) {
    await loadAndConfigureAlloy(config.alloyInstanceName, alloyConfig);
    if (config.trackPageView) {
      onPageActivation(() => {
        sendAnalyticsEvent({ eventType: 'web.webpagedetails.pageViews' });
      });
    }
  } else if (!config.performanceOptimized) {
    const renderDecisionResponse = await sendEvent({
      renderDecisions: true,
      decisionScopes: [...new Set(['__view__', ...(config.decisionScopes || [])])],
    });
    response = renderDecisionResponse;
    document.body.style.visibility = null;
    // Automatically report displayed propositions
    if (config.trackPageView) {
      onPageActivation(() => {
        sendAnalyticsEvent({ eventType: 'web.webpagedetails.pageViews' });
      });
    }
  }
}

/**
 * Martech logic to be executed in the delayed phase.
 * @returns a promise that the delayed logic was executed
 */
export async function martechDelayed() {
  // eslint-disable-next-line no-console
  console.assert(config.alloyInstanceName && window[config.alloyInstanceName], 'Martech needs to be initialized before the `martechDelayed` method is called');

  const { launchUrls } = config;
  return Promise.all(launchUrls.map((url) => import(url)))
    .catch((err) => handleRejectedPromise(new Error(err)));
}
