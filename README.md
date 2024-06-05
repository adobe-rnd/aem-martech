:construction: This is an early access technology and is still heavily in development. Reach out to us over slack before using it.

# AEM Edge Delivery Services Marketing Technology

The AEM Marketing Technology plugin helps you quickly set up a complete MarTech stack for your AEM project. It is currently available to customers in collaboration with AEM Engineering via co-innovation VIP Projects. To implement your use cases, please reach out to the AEM Engineering team in the Slack channel dedicated to your project.


## Features

The AEM MarTech plugin is essentially a wrapper around the Adobe Experience Platform WebSDK (v2.19.2) and the Adobe Client Data Layer (v2.0.2), and that can seamlessly integrate your website with:

- 🎯 Adobe Target or Adobe Journey Optimizer: to personalize your pages
- 📊 Adobe Analytics: to track customer journey data
- 🚩 Adobe Experience Platform Tags (a.k.a. Launch): to track your custom events

It's key differentiator are:
- 🌍 Experience Platform enabled: the library fully integrates with our main Adobe Experience Platform and all the services of our ecosystem
- 🚀 extremely fast: the library is optimized to reduce load delay, TBT and CLS, and has minimal impact on your Core Web Vitals
- 👤 privacy-first: the library does not track you by default, and can easily be integrated with your preferred consent management system

## Prerequisites

You need to have access to:
- Adobe Experience Platform (AEP)
- Adobe Analytics
- Adobe Target or Adobe Journey Optimizer

And you need to have preconfigured:
- a datastream in AEP with Adobe Analytics, and Adobe Target or Adobe Journey Optimizer configured
- an Adobe Experience Platform Tag (Launch) container with the Adobe Analytics & Adobe Client Data Layer extensions at a minimum


## Installation

Add the plugin to your AEM project by running:
```sh
git subtree add --squash --prefix plugins/martech git@github.com:adobe-rnd/aem-martech.git main
```

If you later want to pull the latest changes and update your local copy of the plugin
```sh
git subtree pull --squash --prefix plugins/martech git@github.com:adobe-rnd/aem-martech.git main
```

If you prefer using `https` links you'd replace `git@github.com:adobe-rnd/aem-martech.git` in the above commands by `https://github.com/adobe-rnd/aem-martech.git`.

If the `subtree pull` command is failing with an error like:
```
fatal: can't squash-merge: 'plugins/martech' was never added
```
you can just delete the folder and re-add the plugin via the `git subtree add` command above.


## Project instrumentation

To properly connect and configure the plugin for your project, you'll need to edit both the `head.html` and `scripts.js` in your AEM project and add the following:

1. Add preload hints for the dependencies we need to speed up the page load at the end of your `head.html`:
    ```html
    <link rel="preload" as="script" crossorigin="anonymous" href="/scripts/adobe-martech/index.js"></link>
    <link rel="preload" as="script" crossorigin="anonymous" href="/scripts/adobe-martech/alloy.min.js"></link>
    <link rel="preconnect" href="https://edge.adobedc.net"></link>
    <!-- change to adobedc.demdex.net if you enable third party cookies -->
    ```
2. Import the various plugin methods at the top of your `scripts.js` file:
    ```js
    import {
      initMartech,
      updateUserConsent,
      martechEager,
      martechLazy,
      martechDelayed,
    } from './adobe-martech/index.js';
    ```
3. Configure the plugin just after the import:
    ```js
    const martechLoadedPromise = initMartech(
      // The WebSDK config
      // Documentation: https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/commands/configure/overview#configure-js
      {
        datastreamId: /* your datastream id here, formally edgeConfigId */,
        orgId: /* your ims org id here */,
      },
      // The library config
      {
        launchUrls: [/* your Launch container URLs here */],
        personalization: !!getMetadata('target'),
      },
    );
    ```
    Note that:
    - the WebSDK `context` flag will, by default, track the `web`, `device` and `environment` details
    - the WebSDK `debugEnabled` flag will, by default, be set to `true` on localhost and any `.page` URL
    - the WebSDK `defaultConsent` is set to `pending` to avoid tracking any sensitive information by default
    - we recommend enabling `personalization` only if needed to limit the performance impact. We typically recommend using a page metadata flag for this
4. Adjust your `loadEager` method so it waits for the martech to load and personalize the page:
    ```js
    /**
     * loads everything needed to get to LCP.
    */
    async function loadEager(doc) {
      …
      if (main) {
        decorateMain(main);
        await Promise.all([
          martechLoadedPromise.then(martechEager),
          waitForLCP(LCP_BLOCKS),
        ]);
      }
    }
    ```
5. Add a reference to the lazy logic at the end of your `loadLazy` method:
    ```js
    async function loadLazy(doc) {
      …
      await martechLazy();
    }
    ```
6. Add a reference to the delayed logic in the `loadDelayed` method:
    ```js
    function loadDelayed() {
      // eslint-disable-next-line import/no-cycle
      window.setTimeout(() => {
        martechDelayed();
        return import('./delayed.js');
      }, 3000);
    }
    ```
7. Connect your consent management system so you can track when consent is given. Typically call the `updateUserConsent` with a set of categories & booleans pairs once your consent management sends the event. Here is an example for the [consent banner block](https://github.com/adobe/aem-block-collection/pull/50) in AEM Block Collection:
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

### Custom options

There are various aspects of the plugin that you can configure via options you can pass to the `initMartech` method above.
Here is the full list we support:

```js
initMartech(
  // Documentation: https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/commands/configure/overview#configure-js
  {
    datastreamId: '...', // the Datastream ID you want to report to
    orgId: '...', // your IMS organisation ID,
    // See https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/commands/configure/overview for other options
  }
  // The library config
  {
    analytics: true, // whether to track data in Adobe Analytics (AA)
    alloyInstanceName: 'alloy', // the name of the global WebSDK instance
    dataLayer: true, // whether to use the Adobe Client Data Layer (ACDL)
    dataLayerInstanceName: 'adobeDataLayer', // the name of the global ACDL instance
    launchUrls: [], // the list of Launch containers to load
    personalization: true, // whether to apply page personalization from Adobe Target (AT) or Adobe Journey Optimizer (AJO)
  },
);
```
