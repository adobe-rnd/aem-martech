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
 */
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
};

let config;
let alloyConfig;
let isAlloyConfigured = false;
const pendingAlloyCommands = [];
const pendingDatalayerEvents = [];

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
  // ACDL only ever processes the `adobeDataLayer` array, so always initialize it, and alias
  // custom instance names to the same array so events pushed before the library is loaded
  // are picked up when it initializes
  window.adobeDataLayer ||= [];
  if (instanceName !== 'adobeDataLayer') {
    window[instanceName] ||= window.adobeDataLayer;
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
    debugEnabled: hostname === 'localhost' || hostname.endsWith('.hlx.page') || hostname.endsWith('.aem.page'),
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
  if (!config.analytics) {
    return Promise.resolve();
  }
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
 * @returns {Function} a function to stop watching for new decorated blocks/sections
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
  // Watch sections and blocks being decorated async (pages without a `main`, like error
  // pages, are still watched via the body observer below)
  const main = document.querySelector('main');
  if (main) {
    observer.observe(main, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-block-status', 'data-section-status'],
    });
  }
  // Watch anything else added to the body
  observer.observe(document.body, { childList: true });
  return () => observer.disconnect();
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
        // Check whether the event should be processed or not
        if (!config.shouldProcessEvent(payload)) {
          return;
        }

        // Do not mutate the payload: it is the data layer's own state object and other
        // listeners may rely on it
        const {
          event: eventType, xdm, data, configOverrides,
        } = payload;
        const args = [
          { eventType, ...xdm },
          data,
          configOverrides,
        ];

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
      const blockClass = el.classList[0];
      const siblings = blockClass
        ? [...document.querySelectorAll(`.${blockClass}`)]
        : [...document.querySelectorAll('[data-block-data-layer]')].filter((e) => !e.classList.length);
      const index = siblings.indexOf(el);
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
 * @param {Object} consent The consent config to use
 * @param {Boolean} [consent.collect] Whether data collection is allowed
 * @param {Boolean|Object} [consent.marketing] Whether data can be used for marketing purposes
 * @param {String} [consent.marketing.preferred] The preferred medium for marketing communication
 * @param {Boolean} [consent.marketing.email] Whether marketing emails are consented to or not
 * @param {Boolean} [consent.marketing.push] Whether marketing push notifications are consented to
 * @param {Boolean} [consent.marketing.sms] Whether marketing messages are consented to or not
 * @param {Boolean} [consent.personalize] Whether data can be used for personalization purposes
 * @param {Boolean} [consent.share] Whether data can be shared/sold to 3rd parties
 * @returns {Promise<*>} a promise that the consent settings have been applied (if alloy is not
 *                       configured yet, the promise only resolves once it is and the queued
 *                       consent has effectively been set)
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
        val: (consent.marketing.email || consent.marketing.push || consent.marketing.sms)
          ? 'y'
          : 'n',
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
  return new Promise((resolve, reject) => {
    pendingAlloyCommands.push(() => fn().then(resolve, reject));
  });
}

let response;
// Tracks which of the fetched propositions are dom-actions, which of those were effectively
// rendered, and which were already reported as displayed to the backend
let domActionPropositionIds = new Set();
const renderedPropositionIds = new Set();
const reportedPropositionIds = new Set();
let initialDisplayReported = false;
let personalizationTimedOut = false;

/**
 * Reports the specified propositions as displayed to the backend.
 * @param {Object[]} propositions the propositions that were displayed
 * @returns a promise that the display event was sent
 */
function reportDisplayedPropositions(propositions) {
  return sendAnalyticsEvent({
    eventType: 'decisioning.propositionDisplay',
    _experience: {
      decisioning: {
        propositions,
        propositionEventType: { display: 1 },
      },
    },
  });
}

/**
 * Reports propositions that were rendered after the initial display report was already sent
 * (i.e. on blocks that were decorated late), so their displays are not lost.
 * @param {String[]} propositionIds the ids of the newly rendered propositions
 */
function reportLateDisplayedPropositions(propositionIds) {
  if (!initialDisplayReported) {
    // The initial report has not been sent yet, and will include those propositions
    return;
  }
  const newlyDisplayed = (response?.propositions || [])
    .filter((p) => propositionIds.includes(p.id) && !reportedPropositionIds.has(p.id))
    .map((p) => ({ id: p.id, scope: p.scope, scopeDetails: p.scopeDetails }));
  if (!newlyDisplayed.length) {
    return;
  }
  newlyDisplayed.forEach((p) => reportedPropositionIds.add(p.id));
  onPageActivation(() => {
    reportDisplayedPropositions(newlyDisplayed);
  });
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
  // Get the decisions, but don't render them automatically
  // so we can hook up into the AEM EDS page load sequence
  const renderDecisionResponse = await sendEvent({
    type: 'decisioning.propositionFetch',
    renderDecisions: false,
    personalization: {
      sendDisplayEvent: false,
      ...(config.decisionScopes?.length && { decisionScopes: config.decisionScopes }),
    },
  });
  response = renderDecisionResponse;
  if (!renderDecisionResponse?.propositions) {
    return [];
  }
  if (personalizationTimedOut) {
    // The response came back after the personalization timeout: the page is already showing
    // the default content, so do not apply the propositions anymore to avoid flickering
    return renderDecisionResponse;
  }
  let propositions = window.structuredClone(renderDecisionResponse.propositions)
    .filter((p) => p.items.some(
      (i) => i.schema === 'https://ns.adobe.com/personalization/dom-action',
    ));
  domActionPropositionIds = new Set(propositions.map((p) => p.id));
  let disconnect;
  let isApplying = false;
  let pendingRun = false;
  const run = async () => {
    if (!propositions.length || personalizationTimedOut) {
      disconnect?.();
      return;
    }
    // Serialize the applications, so concurrent DOM updates do not apply the same
    // propositions twice; a trailing run picks up whatever was decorated in the meantime
    if (isApplying) {
      pendingRun = true;
      return;
    }
    isApplying = true;
    try {
      const appliedPropositions = await window[instanceName](
        'applyPropositions',
        { propositions },
      );
      const newlyRendered = [];
      appliedPropositions.propositions.forEach((item) => {
        if (item.renderAttempted) {
          renderedPropositionIds.add(item.id);
          newlyRendered.push(item.id);
          propositions = propositions.filter((p) => p.id !== item.id);
        }
      });
      reportLateDisplayedPropositions(newlyRendered);
      if (!propositions.length) {
        // Everything was applied, no need to keep watching the DOM
        disconnect?.();
      }
    } finally {
      isApplying = false;
      if (pendingRun) {
        pendingRun = false;
        run();
      }
    }
  };
  disconnect = onDecoratedElement(run);
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

  initAlloyQueue(config.alloyInstanceName);
  if (config.dataLayer) {
    initDatalayer(config.dataLayerInstanceName);
  }

  alloyConfig = {
    ...getDefaultAlloyConfiguration(),
    ...webSDKConfig,
    onBeforeEventSend: (payload) => {
      // ACDL is initialized in the lazy phase, so fall back to merging the queued plain
      // objects during the eager phase
      if (config.dataLayer && config.includeDataLayerState) {
        const dl = window[config.dataLayerInstanceName];
        let dlState;
        if (dl?.getState) {
          dlState = dl.getState();
        } else if (Array.isArray(dl)) {
          dlState = dl
            .filter((entry) => typeof entry === 'object' && entry !== null && !entry.event)
            .reduce((state, entry) => ({ ...state, ...entry }), {});
        }
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

const debug = (label = 'martech', ...args) => {
  if (alloyConfig.debugEnabled) {
    // eslint-disable-next-line no-console
    console.debug.call(null, `[${label}]`, ...args);
  }
};

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
    ).catch(() => {
      // Stop applying propositions that arrive after the timeout: the default content is
      // already showing and applying them late would flicker the page
      personalizationTimedOut = true;
      if (alloyConfig.debugEnabled) {
        // eslint-disable-next-line no-console
        console.warn('Could not apply personalization in time. Either backend is taking too long, or user did not give consent in time.');
      }
    }).finally(() => {
      // Track the page view (and report displayed propositions) even if the personalization
      // fetch timed out or returned no propositions, so analytics are not lost
      onPageActivation(() => {
        // Only report propositions that were effectively rendered, or that are not
        // dom-actions (and are handled by project code instead)
        const propositions = (response?.propositions || [])
          .filter((p) => !domActionPropositionIds.has(p.id) || renderedPropositionIds.has(p.id))
          .map((p) => ({ id: p.id, scope: p.scope, scopeDetails: p.scopeDetails }));
        propositions.forEach((p) => reportedPropositionIds.add(p.id));
        initialDisplayReported = true;
        if (!config.trackPageView && !propositions.length) {
          // Without propositions there is nothing to report, and the page view itself
          // is tracked elsewhere
          return;
        }
        sendAnalyticsEvent({
          eventType: config.trackPageView
            ? 'web.webpagedetails.pageViews'
            : 'decisioning.propositionDisplay',
          ...(propositions.length && {
            _experience: {
              decisioning: {
                propositions,
                propositionEventType: { display: 1 },
              },
            },
          }),
        });
      });
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
    await loadAndConfigureDataLayer();
  }

  if (!config.personalization) {
    // Alloy is only loaded in the eager phase when personalization is enabled,
    // so make sure it is loaded here in all other configurations
    if (!isAlloyConfigured) {
      await loadAndConfigureAlloy(config.alloyInstanceName, alloyConfig);
    }
    if (config.trackPageView) {
      onPageActivation(() => {
        sendAnalyticsEvent({ eventType: 'web.webpagedetails.pageViews' });
      });
    }
  } else if (!config.performanceOptimized) {
    try {
      const renderDecisionResponse = await promiseWithTimeout(
        sendEvent({
          renderDecisions: true,
          decisionScopes: [...new Set(['__view__', ...(config.decisionScopes || [])])],
        }),
        config.personalizationTimeout,
      );
      response = renderDecisionResponse;
    } catch (err) {
      if (alloyConfig.debugEnabled) {
        // eslint-disable-next-line no-console
        console.warn('Could not apply personalization in time. Either backend is taking too long, or user did not give consent in time.');
      }
    } finally {
      // Always restore the page visibility, even if the personalization request failed
      // (network error, request blocked by an ad blocker, consent not given in time, …)
      document.body.style.visibility = null;
    }
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
