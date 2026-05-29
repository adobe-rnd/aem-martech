# Using Form-Based Target activities

Form-Based activities (Experience Targeting, A/B Test) deliver **HTML offers** that the
plugin places into the page. Unlike VEC activities, a Form-Based HTML offer usually
doesn't carry its own CSS selector, so the plugin needs to know *where* on the page each
offer's decision scope (mbox) should land.

Authors declare that mapping directly in the content with **section metadata** — no code
change is needed to add or move a Target location.

## How to use

1. In the document, add a **Section Metadata** block to the section you want to personalize.
2. Add an `mbox` row whose value is the decision scope (mbox) name from your Target activity.
   Multiple scopes on one section are comma-separated (`hero-a, hero-b`).
3. (Optional) add an `mbox-action` row to override how the offer is applied — `setHtml`
   (default), `replaceHtml`, or `appendHtml`.

Helix renders this as `data-mbox="my-scope"` (and `data-mbox-action="…"`) on the section.
At page load the plugin:

- scans for `data-mbox` attributes and requests those scopes (alongside the default
  `__view__` scope),
- adds a synthetic `.martech-mbox-{scope}` class to each tagged section, and
- applies the matching offer to that section as it renders. Late-arriving content
  (fragments, dynamic blocks, Universal Editor edits) is picked up on later ticks.

If an offer carries its own selector (DA "Send to Target" offers do), that selector wins
over the auto-discovered one. Offers with no usable selector — none embedded and no
`data-mbox` on the page — are dropped (enable `debugEnabled: true` to see why).

## Action types

| `actionType` | What it does |
|---|---|
| `setHtml` (default) | Replaces the **children** of the matched section, preserving the element, its classes, and its EDS decoration. |
| `replaceHtml` | Replaces the **entire matched element** with the offer's HTML. |
| `appendHtml` | **Appends** the offer's HTML to the matched element (notification bars, banners). |

## VEC activities

Visual Experience Composer offers carry their own selectors and are applied automatically
on the default `__view__` scope — they need no section metadata. A VEC offer authored
against a non-visual target (`head` / `body` / `html`) is a misconfiguration and should be
fixed in Target.
