# Form-Based Target activities — `propositionMetadata` reference

> **Status: Experimental.** This documents the developer-owned-config alternative to the
> recommended `data-mbox` section-metadata auto-discovery (covered in the main
> [`README.md`](../README.md#working-with-form-based-activities)). It's a working
> approach for demos and early customer validation. It requires developers to maintain
> mbox-to-selector mappings in code, which means every new Target location or rename
> needs a developer cycle. The plugin may evolve the recommended Form-Based authoring
> model based on production customer learnings; this doc will be updated rather than
> removed.

## When to reach for this

- The personalization target isn't section-shaped (a specific element inside a block,
  for example) and the synthetic `.martech-mbox-{name}` selector from auto-discovery
  doesn't reach it.
- A VEC offer's embedded selector is non-visual (`head` / `body` / `html`) and you need
  to rescue the offer by overriding the selector. This is the "non-visual rescue" path.
- A project already maintains a hand-curated selector-ownership convention (e.g. shared
  utility classes specifically reserved for personalization targets) and you want to
  keep that convention rather than switching to `data-mbox` markup.

## API

### `decisionScopes`

`String[]` — additional decision scopes to request beyond the default `__view__` scope.
Included in both the eager `propositionFetch` (when `performanceOptimized` is `true`,
the default) and the lazy `sendEvent` (when `performanceOptimized` is `false`).
`__view__` is always included implicitly.

```js
initMartech(webSDK, {
  decisionScopes: ['my-mbox-name'],
});
```

This config key landed in `upstream/main` separately via PR #18.

### `propositionMetadata`

`Object<scope, { selector, actionType }>` — per-scope override metadata for Form-Based
HTML offers and the dom-action non-visual rescue path.

```js
initMartech(webSDK, {
  decisionScopes: ['homepage-hero-mbox', 'recommendation-band-mbox'],
  propositionMetadata: {
    'homepage-hero-mbox':       { selector: '.hero',                  actionType: 'setHtml' },
    'recommendation-band-mbox': { selector: 'main .recommendations',  actionType: 'replaceHtml' },
  },
});
```

| Field | Type | Required | Default |
|---|---|---|---|
| `selector` | String | Yes | n/a — the consumer authored it |
| `actionType` | `'setHtml'` \| `'replaceHtml'` \| `'appendHtml'` | No | `'setHtml'` (preserves the matched element — see action vocabulary below) |

Resolution order for an `html-content-item` proposition:

1. `item.data.selector` from the offer itself (highest priority).
2. `propositionMetadata[scope].selector` (this config).
3. If neither is present, the item is dropped.

The chosen selector is then validated by `isVisualSelector()`: empty / non-string
selectors, document-chrome selectors (`head` / `body` / `html`, case- and
whitespace-insensitive), and syntactically-invalid CSS are all dropped with a debug log.

### Action vocabulary

| `actionType` | What it does |
|---|---|
| `setHtml` | Replaces the *children* of the matched element. Preserves the element itself + any classes, attributes, decoration state, event listeners attached to the element. |
| `replaceHtml` | Replaces the *entire matched element* with the offer's HTML. Removes element identity. |
| `appendHtml` | Appends the offer's HTML to the matched element's children. Used for additive personalization (notification bars, footer banners). |

## Selector contract

Selectors are validated through `isVisualSelector(selector, contextLabel)` at resolution
time. The validator:

- Rejects empty / non-string values.
- Rejects `head` / `body` / `html` after `trim().toLowerCase()` normalization.
- Catches syntactically-invalid CSS by trying `document.querySelector(selector)` inside a
  `try` / `catch`.
- Debug-logs the reason on every rejection (`debugEnabled: true` to surface).

Rejected items are dropped — they don't render and don't get reported as displayed.

## Reporting

Display events (`decisioning.propositionDisplay`) fire exactly once per displayed
proposition:

- Direct-injected (rescued) propositions: reported immediately after injection via
  `reportPropositionDisplay()`.
- Alloy-applied propositions: reported in the page-activation event (page view or
  display event depending on `trackPageView`).
- Dropped propositions (no resolvable selector, invalid selector, schema mismatch): not
  reported.

Fetched propositions and displayed propositions are not the same set once filtering and
direct injection are in play: the plugin tracks which propositions were actually rendered
and which were already reported, so the page-activation event reports each displayed
proposition exactly once and never reports a dropped one.

## Migration to `data-mbox` auto-discovery

If you're currently using `propositionMetadata` for section-shaped targets, you can
migrate to the recommended `data-mbox` model:

1. In DA, add a `section-metadata` block to each section being targeted; add an `mbox`
   row with the scope name.
2. Remove the corresponding entry from `propositionMetadata` and the scope from
   `decisionScopes` in your `initMartech` call.
3. (Optional) Add an `mbox-action` row to the section metadata if the scope needs a
   non-default action type.

Sections without `data-mbox` are untouched; `propositionMetadata` entries you don't
remove keep working. The two models coexist — discovered scopes are merged with
consumer-supplied entries, with consumer entries winning on conflict.

## Future direction

The plugin's recommended Form-Based authoring model may evolve based on production
customer learnings. Current candidates being explored:

- A `personalizeLateScopes` opt-in that fires a follow-up `propositionFetch` for mboxes
  introduced after the eager fetch (e.g. mboxes inside fragments).
- A category-neutral authoring key alias (e.g. `decision-scope`) reflecting that the
  value can be a Target mbox, an AJO offer activity, an AJO CBE surface, or a
  datastream-mapped friendly name.
- A first-class Universal Editor affordance for the section-metadata key.

This doc will be updated as the direction stabilizes.
