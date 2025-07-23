:construction: This is an early access technology and is still heavily in development. Reach out to us over Slack before using it.

# AEM Edge Delivery Services Marketing Technology

The AEM Marketing Technology plugin helps you quickly set up a complete MarTech stack for your AEM project. It is currently available to customers in collaboration with AEM Engineering via co-innovation VIP Projects. To implement your use cases, please reach out to the AEM Engineering team in the Slack channel dedicated to your project.

## Table of Contents

- [AEM Edge Delivery Services Marketing Technology](#aem-edge-delivery-services-marketing-technology)
  - [Table of Contents](#table-of-contents)
  - [How It Works](#how-it-works)
  - [Features](#features)
  - [Prerequisites](#prerequisites)
    - [Launch Container Configuration](#launch-container-configuration)
  - [Installation](#installation)
  - [Project Instrumentation](#project-instrumentation)
    - [1. Add Preload Hints](#1-add-preload-hints)
    - [2. Import Plugin Methods](#2-import-plugin-methods)
    - [3. Configure the Plugin](#3-configure-the-plugin)
    - [4. Wait for Personalization](#4-wait-for-personalization)
    - [5. Load Lazy Logic](#5-load-lazy-logic)
    - [6. Load Delayed Logic](#6-load-delayed-logic)
  - [API Reference](#api-reference)
    - [`initMartech(webSDKConfig, martechConfig)`](#initmartechwebsdkconfig-martechconfig)
    - [`updateUserConsent(consent)`](#updateuserconsentconsent)
    - [`pushToDataLayer(payload)`](#pushtodatalayerpayload)
    - [`pushEventToDataLayer(event, xdm, data, configOverrides)`](#pusheventtodatalayerevent-xdm-data-configoverrides)
    - [`sendEvent(payload)`](#sendeventpayload)
    - [`sendAnalyticsEvent(xdmData, dataMapping, configOverrides)`](#sendanalyticseventxdmdata-datamapping-configoverrides)
    - [`initRumTracking(sampleRUM, options)`](#initrumtrackingsamplerum-options)
    - [`isPersonalizationEnabled()`](#ispersonalizationenabled)
  - [Consent Management](#consent-management)
      - [Integrating with AEM Consent Banner Block](#integrating-with-aem-consent-banner-block)
      - [Integrating with OneTrust](#integrating-with-onetrust)
  - [Managing Adobe Target Personalization](#managing-adobe-target-personalization)
    - [1. Initial Page Load Personalization](#1-initial-page-load-personalization)
    - [2. Personalization for Dynamic Content (SPAs)](#2-personalization-for-dynamic-content-spas)
  - [Using Adobe Launch With This Plugin](#using-adobe-launch-with-this-plugin)
    - [Example: Tracking an Event in Launch](#example-tracking-an-event-in-launch)
    - [Alternative Workflows](#alternative-workflows)
  - [FAQ](#faq)
    - [Why not use the default Adobe Launch approach?](#why-not-use-the-default-adobe-launch-approach)
    - [Can't I just defer the Launch script?](#cant-i-just-defer-the-launch-script)
    - [What guarantees do I have that this won't break?](#what-guarantees-do-i-have-that-this-wont-break)
    - [What's the catch?](#whats-the-catch)
    - [Why is `git subtree` used for installation?](#why-is-git-subtree-used-for-installation)

## How It Works

This plugin optimizes the integration of Adobe's marketing technology stack by moving away from a monolithic Adobe Launch script. Instead, it "decomposes" the key components—Adobe Experience Platform WebSDK and Adobe Client Data Layer (ACDL)—and loads them at the optimal time during the page load lifecycle.

This is achieved through a phased approach that aligns with modern web performance best practices:

- **Eager Phase**: Handles critical tasks like personalization during the initial page load to prevent content flicker, ensuring a smooth user experience.
- **Lazy Phase**: Loads analytics and the data layer after the main content has rendered, capturing metrics without delaying the Largest Contentful Paint (LCP).
- **Delayed Phase**: Executes non-essential scripts, like third-party tags via Launch, after the page is fully interactive.

By instrumenting the core Adobe libraries directly but in a controlled sequence, this plugin minimizes performance impact while retaining the full power of the Adobe Experience Cloud.

## Features

The AEM MarTech plugin is essentially a wrapper around the Adobe Experience Platform WebSDK and the Adobe Client Data Layer that seamlessly integrates your website with:

- 🎯 Adobe Target or Adobe Journey Optimizer: to personalize your pages
- 📊 Adobe Analytics: to track customer journey data
- 🚩 Adobe Experience Platform Tags (a.k.a. Launch): to track your custom events

Its key differentiators are:
- 🌍 **Experience Platform enabled**: The library fully integrates with our main Adobe Experience Platform and all the services of our ecosystem.
- 🚀 **Extremely fast**: The library is optimized to reduce load delay, TBT, and CLS, and has a minimal impact on your Core Web Vitals.
- 👤 **Privacy-first**: The library does not track end-users by default and can be easily integrated with your preferred consent management system.
- 🔬 **Speculative prerender aware**: The library supports [speculative prerendering](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API) and won't fire Analytics events (and artificially inflate your page views) until the page is actually viewed.

## Prerequisites

You need access to:
- **Adobe Experience Platform** (no full license needed, just basic permissions for data collection)
- **Adobe Analytics**
- **Adobe Target** or **Adobe Journey Optimizer**

### Launch Container Configuration

:warning: **CRITICAL SETUP STEP**

Before instrumenting your project, you must configure your Adobe Experience Platform Tags (Launch) container correctly for use with this plugin.

- **DO NOT** include the following extensions in your Launch container:
    - `Adobe Experience Platform Web SDK`
    - `Adobe Analytics`
    - `Adobe Target`

This plugin handles the initialization of these components directly to optimize performance. Including them in Launch will lead to conflicts and potential data duplication.

- **DO** ensure you have the `Adobe Client Data Layer` extension configured.

:warning: **Legal Disclaimer:** This library defaults user consent to `pending` to comply with privacy regulations. Overriding this behavior to grant consent by default (e.g., setting it to `in`) without explicit user agreement may have significant legal implications under regulations like GDPR and CCPA. We strongly advise consulting with your legal team before altering the default consent handling.

We also recommend using a proper consent management system.

## Installation

We have a comprehensive [tutorial on Experience League](https://experienceleague.adobe.com/en/docs/platform-learn/tutorial-one-adobe/assetmgmt/assetm1/ex6), or you can just follow the steps below.

Add the plugin to your AEM project by running:
```sh
git subtree add --squash --prefix plugins/martech git@github.com:adobe-rnd/aem-martech.git main
```

If you later want to pull the latest changes and update your local copy of the plugin:
```sh
git subtree pull --squash --prefix plugins/martech git@github.com:adobe-rnd/aem-martech.git main
```

If the `subtree pull` command fails, you can delete the `plugins/martech` folder and re-add it using the `git subtree add` command.

If you use a linter, make sure to ignore minified files in your `.eslintignore`:
```
*.min.js
```

## Project Instrumentation

To connect and configure the plugin, you'll need to edit your project's `head.html` and `scripts.js`.

### 1. Add Preload Hints

Add the following lines at the end of your `head.html` to speed up page load:
```html
<link rel="preload" as="script" crossorigin="anonymous" href="/plugins/martech/src/index.js"/>
<link rel="preload" as="script" crossorigin="anonymous" href="/plugins/martech/src/alloy.min.js"/>
<link rel="preconnect" href="https://edge.adobedc.net"/>
<!-- Change to adobedc.demdex.net if you enable third-party cookies -->
```

### 2. Import Plugin Methods

Import the necessary methods at the top of your `scripts.js` file:
```js
import {
  initMartech,
  updateUserConsent,
  martechEager,
  martechLazy,
  martechDelayed,
} from '../plugins/martech/src/index.js';
```

### 3. Configure the Plugin

Call `initMartech` at the top of the `loadEager` method in your `scripts.js`. This function takes two arguments: the WebSDK configuration and the library-specific configuration.

```js
/**
 * Loads everything needed to get to LCP.
 */
async function loadEager(doc) {
  // Hook in your consent check to determine if personalization can run.
  const isConsentGiven = true; /* your consent logic here */

  const martechLoadedPromise = initMartech(
    // 1. WebSDK Configuration
    // Docs: https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/commands/configure/overview#configure-js
    {
      datastreamId: /* your datastream id here */,
      orgId: /* your IMS org id here */,
      // The `debugEnabled` flag is automatically set to true on localhost and .page URLs.
      // The `defaultConsent` is automatically set to "pending".
      onBeforeEventSend: (payload) => {
        // This callback allows you to modify the payload before it's sent.
        // Return false to prevent the event from being sent.
      },
      edgeConfigOverrides: {
        // Optional datastream overrides for different environments.
      },
    },
    // 2. Library Configuration
    {
      personalization: !!getMetadata('target') && isConsentGiven,
      launchUrls: [/* your Launch script URLs here */],
      // See the API Reference for all available options.
    },
  );
  // ... rest of loadEager
}
```

### 4. Wait for Personalization

Adjust your `loadEager` method to wait for the MarTech promise to resolve before rendering the main content. This prevents content flicker from personalized content.

```js
// ... inside loadEager
if (main) {
  decorateMain(main);
  document.body.classList.add('appear');
  await Promise.all([
    martechLoadedPromise.then(martechEager),
    loadSection(main.querySelector('.section'), waitForFirstImage),
  ]);
}
```

### 5. Load Lazy Logic

Add a reference to `martechLazy` just after the `loadFooter(…);` call in your `loadLazy` method:
```js
async function loadLazy(doc) {
  // ...
  loadFooter(doc.querySelector('footer'));
  await martechLazy();
  // ...
}
```

### 6. Load Delayed Logic

Add a reference to `martechDelayed` in your `loadDelayed` method:
```js
function loadDelayed() {
  window.setTimeout(() => {
    martechDelayed();
    import('./delayed.js');
  }, 3000);
}
```

## API Reference

The plugin exports several functions to interact with the marketing stack.

---

### `initMartech(webSDKConfig, martechConfig)`
Initializes the library. This should be called once in `loadEager`.

- **`webSDKConfig`** `{Object}`: Configuration for the Adobe Experience Platform WebSDK. Requires `datastreamId` and `orgId`.
- **`martechConfig`** `{Object}`: Optional configuration for this library.
  - `analytics` `{Boolean}`: Enable analytics. Default: `true`.
  - `alloyInstanceName` `{String}`: Global name for the alloy instance. Default: `'alloy'`.
  - `dataLayer` `{Boolean}`: Enable Adobe Client Data Layer (ACDL). Default: `true`.
  - `dataLayerInstanceName` `{String}`: Global name for the ACDL instance. Default: `'adobeDataLayer'`.
  - `includeDataLayerState` `{Boolean}`: Include the full data layer state on every event. Default: `true`.
  - `launchUrls` `{String[]}`: Array of Launch script URLs to load.
  - `personalization` `{Boolean}`: Enable personalization. Default: `true`.
  - `performanceOptimized` `{Boolean}`: Use aggressive performance optimizations. Default: `true`.
  - `personalizationTimeout` `{Number}`: Timeout in ms for personalization. Default: `1000`.
  - `shouldProcessEvent` `{Function}`: A function that receives a data layer event payload and returns `false` to prevent it from being sent.

---

### `updateUserConsent(consent)`
Sets user consent based on the IAB TCF 2.0 standard.

- **`consent`** `{Object}`: An object detailing user consent choices (`collect`, `marketing`, `personalize`, `share`).

---

### `pushToDataLayer(payload)`
Pushes a generic payload to the Adobe Client Data Layer.

- **`payload`** `{Object}`: The data object to push.

---

### `pushEventToDataLayer(event, xdm, data, configOverrides)`
A helper for pushing a standardized event to the data layer.

- **`event`** `{String}`: The name of the event.
- **`xdm`** `{Object}`: The XDM data object.
- **`data`** `{Object}`: Additional data mappings.
- **`configOverrides`** `{Object}`: Optional Edge configuration overrides.

---

### `sendEvent(payload)`
A proxy for the `alloy('sendEvent', ...)` command to send a raw event.

- **`payload`** `{Object}`: The full event payload for the WebSDK.

---

### `sendAnalyticsEvent(xdmData, dataMapping, configOverrides)`
A helper for sending an analytics event directly.

- **`xdmData`** `{Object}`: The XDM data object.
- **`dataMapping`** `{Object}`: Data mappings for the event.
- **`configOverrides`** `{Object}`: Optional Edge configuration overrides.

---

### `initRumTracking(sampleRUM, options)`
Initializes RUM (Real User Monitoring) tracking.

- **`sampleRUM`** `{Object}`: The RUM sampling object.
- **`options`** `{Object}`: Optional configuration.

---

### `isPersonalizationEnabled()`
- **Returns** `{Boolean}`: `true` if personalization is configured and enabled.

---

## Consent Management

Connect your consent management system (CMS) to track user consent. Call `updateUserConsent` when your CMS sends a consent event.

#### Integrating with AEM Consent Banner Block
Example for the [AEM Consent Banner Block](https://github.com/adobe/aem-block-collection/pull/50):
```js
function consentEventHandler(ev) {
  const collect = ev.detail.categories.includes('CC_ANALYTICS');
  const marketing = ev.detail.categories.includes('CC_MARKETING');
  const personalize = ev.detail.categories.includes('CC_TARGETING');
  const share = ev.detail.categories.includes('CC_SHARING');
  updateUserConsent({ collect, marketing, personalize, share });
}
window.addEventListener('consent', consentEventHandler);
window.addEventListener('consent-updated', consentEventHandler);
```

#### Integrating with OneTrust
Example for [OneTrust](https://www.onetrust.com):
```js
function consentEventHandler(ev) {
 const groups = ev.detail;
 const collect = groups.includes('C0002'); // Performance Cookies
 const personalize = groups.includes('C0003'); // Functional Cookies
 const share = groups.includes('C0008'); // Targeted Advertising
 updateUserConsent({ collect, personalize, share });
}
window.addEventListener('consent.onetrust', consentEventHandler);
```

## Managing Adobe Target Personalization

This plugin takes over the responsibility of fetching and rendering Adobe Target offers from the AEP Web SDK extension to optimize performance. The process is handled in two stages.

### 1. Initial Page Load Personalization

The `martechEager()` function, which is executed during the initial page load, automatically requests and applies Target propositions as the page is rendering. This is designed to prevent content flicker and ensures that personalized content is visible as early as possible. This single function call replaces the default offer-rendering behavior of the standard Launch extension.

### 2. Personalization for Dynamic Content (SPAs)

For Single Page Applications or any content that is loaded asynchronously after the initial page load, personalization must be managed manually for those specific parts of the page. This ensures Target is aware of new content and can apply offers to it.

1.  **Follow the SPA approach** and define [views in Adobe Target](https://experienceleague.adobe.com/en/docs/target/using/experiences/spa-visual-experience-composer). A "view" corresponds to a logical section of your page that might change, like a product listing that gets updated.

2.  **Import the helper methods** in the components or blocks responsible for rendering the dynamic content:
    ```js
    import {
      isPersonalizationEnabled,
      getPersonalizationForView,
      applyPersonalization,
    } from '../plugins/martech/src/index.js';
    ```

3.  **Fetch the personalization offers** for the view when it is about to be rendered. Use a unique `viewName` for each distinct dynamic area.
    ```js
    if (isPersonalizationEnabled()) {
      // This fetches the offers for 'product-grid' but doesn't apply them yet.
      await getPersonalizationForView('product-grid');
    }
    ```

4.  **Apply the personalization** every time there is a meaningful DOM update within your component.
    ```js
    // This applies the previously fetched offers to the current DOM.
    applyPersonalization('product-grid');
    ```

## Using Adobe Launch With This Plugin

When the **AEP Web SDK Extension** is not used in the Launch container, its UI-based actions (e.g., "Send Event") and Data Element types (e.g., "XDM Object") are not available. This is the expected behavior, as this plugin takes over the direct initialization and configuration of the Web SDK.

The recommended workflow is to use Launch rules to **prepare and push events to the data layer**, which allows this plugin to automatically handle sending the data to Adobe.

The key components for this workflow are:
1.  **The Adobe Client Data Layer (ACDL) Extension**: This extension must remain in your Launch container. It allows you to create rules that trigger based on events pushed to the data layer.
2.  **The "Custom Code" Action**: Instead of a Web SDK-specific action, the "Core > Custom Code" action is used to construct and push the event object.
3.  **Automatic Event Forwarding**: This plugin automatically listens for events pushed to `window.adobeDataLayer` and forwards them to the Adobe Edge Network.

### Example: Tracking an Event in Launch

Here is a standard workflow for tracking a "product viewed" event:

1.  **Create a Rule**: In the Launch UI, create a new rule that triggers on the desired condition (e.g., "DOM Ready" on a product page).

2.  **Use a Custom Code Action**: Add a "Core > Custom Code" action to the rule. Inside the editor, construct the XDM payload and push it to the data layer.

    ```javascript
    // Use Launch Data Elements to gather product details dynamically.
    var productSku = _satellite.getVar('Product SKU');

    // Construct the XDM payload as a standard JavaScript object.
    var xdmData = {
      eventType: 'commerce.productViews',
      commerce: {
        productViews: {
          value: 1
        }
      },
      productListItems: [{
        SKU: productSku,
        name: _satellite.getVar('Product Name'), // another data element
      }]
    };

    // Push the event object to the data layer.
    // "event" is used by the ACDL extension to trigger rules.
    // "xdm" and "data" are passed to the Web SDK by the plugin.
    window.adobeDataLayer.push({
      event: 'product-view',
      xdm: xdmData
    });
    ```

This workflow provides full control over the data while leveraging Launch's powerful rules engine.

### Alternative Workflows

For more direct control or specific use cases, two other patterns can be used:

1.  **Direct `alloy` Calls**: From a "Custom Code" action, it is possible to bypass the data layer and call the Web SDK directly. Since this plugin ensures `window.alloy` is available globally, you can invoke it with any valid command, such as `sendEvent`.

    ```javascript
    // Example of calling alloy directly from a Launch rule
    window.alloy('sendEvent', {
      xdm: {
        /* your xdm data */
      }
    });
    ```

2.  **Community Analytics Extension**: For use cases primarily focused on Adobe Analytics, the **"AA via AEP Web SDK"** community extension can be a useful replacement. When the official AEP Web SDK extension is removed, this community extension can be installed to bring back a UI-driven way to map Analytics variables and trigger events, similar to the functionality customers are used to. This can be a good middle-ground for teams who prefer a UI-based workflow for their Analytics tracking.


## FAQ

### Why not use the default Adobe Launch approach?
A default Launch implementation can negatively impact Core Web Vitals. Our approach optimizes for performance by loading components intelligently.

### Can't I just defer the Launch script?
Deferring the entire script introduces content flickering for personalization use cases and can lead to missed analytics events from users who bounce early.

### What guarantees do I have that this won't break?
This library uses the same official Adobe Experience Platform WebSDK and Adobe Client Data Layer as Launch. We are building on documented Adobe APIs, such as [top and bottom of page events](https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/use-cases/top-bottom-page-events), to ensure compatibility.

### What's the catch?
Since some logic is moved from the Launch UI into your project's code, not all features can be managed from the Launch UI. We recommend a baseline of the _Core_, _ACDL_, and _AA via AEP Web SDK_ extensions in your Launch container.

### Why is `git subtree` used for installation?
`git subtree` is used to vendor the plugin's code directly into your project. This approach avoids the need for a package manager like `npm` and the complexities of `git submodule`, providing a simple way to pull in updates while keeping the code self-contained within your repository.
