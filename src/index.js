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
 * @property {String[]} launchUrls A list of launch container URLs to load (defults to empty list)
 * @property {Boolean} personalization Indicates whether Adobe Target should be enabled
 *                                     (defaults to true)
 */
export const DEFAULT_CONFIG = {
  analytics: true,
  alloyInstanceName: 'alloy',
  dataLayer: true,
  dataLayerInstanceName: 'adobeDataLayer',
  launchUrls: [],
  personalization: true,
};

let config;
let alloyConfig;

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
 * Loads the alloy library and configures it.
 * Documentation:
 * https://experienceleague.adobe.com/docs/experience-platform/edge/fundamentals/configuring-the-sdk.html
 * @param {String} instanceName The name of the instance in the blobal scope
 * @param {Object} webSDKConfig The configuration to use
 * @returns a promise that the library was loaded and configured
 */
function loadAndConfigureAlloy(instanceName, webSDKConfig) {
  return import('./alloy.min.js')
    .then(() => window[instanceName]('configure', webSDKConfig))
    .catch((err) => handleRejectedPromise(new Error(err)));
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
 * @param {Object} payload the payload to push
 */
export function pushEventToDataLayer(event, payload) {
  pushToDataLayer({ event, eventInfo: payload });
}

/**
 * Sends an analytics event to alloy
 * @param {Object} xdmData the xdm data object to send
 * @param {Object} [dataMapping] additional data mapping for the event
 * @returns {Promise<*>} a promise that the event was sent
 */
export async function sendAnalyticsEvent(xdmData, dataMapping) {
  // eslint-disable-next-line no-console
  console.assert(config.alloyInstanceName && window[config.alloyInstanceName], 'Martech needs to be initialized before the `sendAnalyticsEvent` method is called');
  // eslint-disable-next-line no-console
  console.assert(config.analytics, 'Analytics tracking is disabled in the martech config');
  // eslint-disable-next-line no-undef
  return window[config.alloyInstanceName]('sendEvent', {
    documentUnloading: true,
    xdm: xdmData,
    data: dataMapping,
  });
}

/**
 * Loads the ACDL library.
 * @returns the ACDL instance
 */
async function loadAndConfigureDataLayer() {
  return import('./acdl.min.js')
    .then(() => {
      if (config.analytics) {
        window[config.dataLayerInstanceName].push((dl) => {
          dl.addEventListener('adobeDataLayer:event', (event) => {
            sendAnalyticsEvent({ eventType: event.event, ...event.eventInfo });
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
    })
    .catch((err) => handleRejectedPromise(new Error(err)));
}

/**
 * Sets Adobe standard v2.0 consent for alloy based on the input
 * Documentation:
 * https://experienceleague.adobe.com/en/docs/experience-platform/landing/governance-privacy-security/consent/adobe/dataset#structure
 * https://experienceleague.adobe.com/en/docs/experience-platform/xdm/data-types/consents
 * @param {Object} config The consent config to use
 * @param {Boolean} [config.collect] Whether data collection is allowed
 * @param {Boolean} [config.marketing] Whether data can be used for marketing purposes
 * @param {Boolean} [config.personalize] Whether data can be used for personalization purposes
 * @param {Boolean} [config.share] Whether data can be shared/sold to 3rd parties
 * @returns {Promise<*>} a promise that the consent setting shave been updated
 */
export async function updateUserConsent(consent) {
  // eslint-disable-next-line no-console
  console.assert(config.alloyInstanceName, 'Martech needs to be initialized before the `updateUserConsent` method is called');

  return window[config.alloyInstanceName]('setConsent', {
    consent: [{
      standard: 'Adobe',
      version: '2.0',
      value: {
        collect: { val: consent.collect ? 'y' : 'n' },
        marketing: {
          any: { val: consent.marketing ? 'y' : 'n' },
        },
        personalize: {
          content: { val: consent.personalize ? 'y' : 'n' },
        },
        share: { val: consent.share ? 'y' : 'n' },
      },
    }],
  });
}

/**
 * Converts an internal element selector to a proper CSS selector.
 * @param {String} selector the internal selector
 * @returns {String} the corresponding CSS selector
 */
function toCssSelector(selector) {
  return selector.replace(/(\.\S+)?:eq\((\d+)\)/g, (_, clss, i) => `:nth-child(${Number(i) + 1}${clss ? ` of ${clss})` : ''}`);
}

/**
 * Find the element for the specified proposition.
 * @param {Object} proposition The proprosition for the element
 * @param {String} [proposition.cssSelector] The CSS selector for the proposition
 * @param {String} [proposition.selector] The internal selector for the proposition
 * @returns {HTMLElement} The DOM element for the proposition
 */
async function getElementForProposition(proposition) {
  const selector = proposition.data.prehidingSelector || toCssSelector(proposition.data.selector);
  return document.querySelector(selector);
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
  const renderDecisionResponse = await window[instanceName]('sendEvent', { renderDecisions: false });
  const propositions = window.structuredClone(renderDecisionResponse.propositions);
  onDecoratedElement(async () => {
    await window[instanceName]('applyPropositions', { propositions });
    propositions.forEach((p) => {
      p.items = p.items.filter((i) => i.schema !== 'https://ns.adobe.com/personalization/dom-action' || !getElementForProposition(i));
    });
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
let response;
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
  };
  if (config.personalization) {
    return loadAndConfigureAlloy(config.alloyInstanceName, alloyConfig)
      .then((resp) => { response = resp; });
  }
  return Promise.resolve();
}

/**
 * Reports the displayed propositions so they can be tracked in Analytics
 * @param {String} instanceName The name of the instance in the blobal scope
 * @param {Object[]} propositions The list of propositions that were shown
 * @returns a promise the the displayed propositions have been reported
 */
async function reportDisplayedPropositions(instanceName, propositions) {
  return window[instanceName]('sendEvent', {
    documentUnloading: true,
    xdm: {
      eventType: 'decisioning.propositionDisplay',
      _experience: {
        decisioning: { propositions },
      },
    },
  });
}

/**
 * Martech logic to be executed in the eager phase.
 * @returns a promise that the eager logic was executed
 */
export async function martechEager() {
  if (config.personalization) {
    // eslint-disable-next-line no-console
    console.assert(response, 'Martech needs to be initialized before the `martechEager` method is called');
    return applyPropositions('alloy');
  }
  return Promise.resolve();
}

/**
 * Martech logic to be executed in the lazy phase.
 * @returns a promise that the lazy logic was executed
 */
export async function martechLazy() {
  if (config.personalization && response.propositions?.length) {
    // eslint-disable-next-line no-console
    console.assert(response, 'Martech needs to be initialized before the `martechLazy` method is called');
    await reportDisplayedPropositions('alloy', response.propositions);
  } else if (!config.personalization) {
    await loadAndConfigureAlloy(config.alloyInstanceName, alloyConfig)
      .then((resp) => { response = resp; });
  }
  if (config.dataLayer) {
    return loadAndConfigureDataLayer({});
  }
  return Promise.resolve();
}

/**
 * Martech logic to be executed in the delayed phase.
 * @returns a promise that the delayed logic was executed
 */
export async function martechDelayed() {
  // eslint-disable-next-line no-console
  console.assert(response, 'Martech needs to be initialized before the `martechDelayed` method is called');

  const { launchUrls } = config;
  return Promise.all(launchUrls.map((url) => import(url)))
    .catch((err) => handleRejectedPromise(new Error(err)));
}
