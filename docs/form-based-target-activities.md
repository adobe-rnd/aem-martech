# Using Form-Based Target activities

Form-Based activities (Experience Targeting, A/B Test) deliver **HTML offers** that the
plugin places into the page. Unlike VEC activities, a Form-Based HTML offer usually
doesn't carry its own CSS selector, so the plugin needs to know *where* on the page each
offer's decision scope (mbox) should land.

There are two ways to provide that mapping.

## Option 1 (recommended): `data-mbox` section metadata

Authors tag a section with the mbox name; no code change is needed for new locations.

1. In the document, add a **Section Metadata** block to the section you want to personalize.
2. Add an `mbox` row whose value is the decision scope (mbox) name from your Target activity.
3. (Optional) add an `mbox-action` row to override the action type (`setHtml` default,
   or `replaceHtml` / `appendHtml`).

Helix renders this as `data-mbox="my-scope"` on the section. At page load the plugin
discovers the attribute, requests the scope, and applies the offer to that section. See
the [README](../README.md#working-with-form-based-activities) for the full walkthrough.

## Option 2 (experimental): `propositionMetadata` config

> **Status: Experimental.** This keeps the mbox→selector mapping in code, so every new
> Target location or rename needs a developer cycle. Prefer Option 1 unless you need to
> target an element that isn't section-shaped.

Map each decision scope to a selector (and optional action type) when initializing the
plugin:

```js
initMartech(webSDK, {
  decisionScopes: ['homepage-hero-mbox', 'recommendation-band-mbox'],
  propositionMetadata: {
    'homepage-hero-mbox':       { selector: '.hero' },
    'recommendation-band-mbox': { selector: 'main .recommendations', actionType: 'replaceHtml' },
  },
});
```

- `decisionScopes` — scopes to request beyond the default `__view__` (VEC) scope.
- `propositionMetadata[scope].selector` — **required**; where the offer is applied.
- `propositionMetadata[scope].actionType` — optional; defaults to `setHtml`.

If an offer already embeds its own selector (`item.data.selector`), that wins over the
config entry. Selectors that are empty, point at `head` / `body` / `html`, or aren't valid
CSS are dropped (enable `debugEnabled: true` to see why).

## Action types

| `actionType` | What it does |
|---|---|
| `setHtml` (default) | Replaces the **children** of the matched element, preserving the element, its classes, and its EDS decoration. |
| `replaceHtml` | Replaces the **entire matched element** with the offer's HTML. |
| `appendHtml` | **Appends** the offer's HTML to the matched element (notification bars, banners). |

## Rescuing a misconfigured VEC offer

A VEC offer whose embedded selector is non-visual (`head` / `body` / `html`) can't be
placed by alloy. Add a `propositionMetadata` entry for that scope with a real selector and
the plugin will inject the offer at your selector instead of dropping it.
