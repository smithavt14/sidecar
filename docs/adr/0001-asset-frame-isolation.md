# Asset frame: an iframe with an injected picker, never same-origin

Assets (HTML files reviewed as rendered visuals) render in a sandboxed iframe. The server
strips the asset's own `<script>` tags before serving and injects sidecar's picker; the sandbox
carries `allow-scripts` and never `allow-same-origin`, so the picker talks to the page only via
postMessage and nothing inside the frame can reach sidecar's file read/write API. The exact
guarantee: **the asset's scripts never run, and the only script in the frame is sidecar's
picker.**

## Considered options

Shadow-DOM adoption was the zero-script alternative: sanitize the HTML (strip scripts, keep
styles), adopt it into a shadow root, and the existing highlight and dock machinery works on
the elements directly. Rejected because a shadow root is not a document: page CSS variables and
the root font size leak in, viewport units resolve against the page, fixed positioning escapes,
and CSS can still fetch remote URLs. Render fidelity is the point of reviewing a poster, and
only a real frame gives the asset its own root and viewport.

## Consequences

Element picking, highlight pulses, and card docking all cross the frame boundary through a
postMessage protocol, and geometry must be re-reported on scroll, resize, and reload. A plain
`sandbox` attribute without `allow-scripts` would silently break picking, so tests must pin
both the flag set and the script-stripping.
