# Brand assets

Vector logos for sidecar, traced from the original artwork (potrace) and cleaned to a tight
viewBox. Every file uses `fill="currentColor"`, so the logo takes the surrounding text color —
set `color` (CSS) and it recolors: black, white on a dark background, or spktr yellow.

| File | What it is | Use for |
|---|---|---|
| `sidecar-horizontal.svg` | Line-art bike + wordmark, horizontal | README headers, site nav, email signature |
| `sidecar-lockup.svg` | Filled bike + wordmark, stacked/square | Splash, social card, anywhere with vertical room |
| `sidecar-mark.svg` | Filled bike only, no wordmark | App icon, favicon, square avatar |
| `sidecar-mark-line.svg` | Line-art bike only, no wordmark | Lighter mark, watermarks, inline |
| `sidecar-horizontal-dark.svg` | White-filled horizontal (fixed color) | GitHub dark-mode `<picture>` only |

## Recoloring

```html
<!-- inherits the text color -->
<span style="color:#111"><!-- inline the svg here --></span>

<!-- or force a color -->
<img src="brand/sidecar-mark.svg" style="color:#FFD84D">   <!-- when inlined -->
```

For `<img>` embeds the SVG renders in isolation and `currentColor` falls back to black — inline
the SVG (or use the `-dark` variant) when you need a non-black color.
