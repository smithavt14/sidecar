/* sidecar — the palette, as data. Loaded by the browser (a <script> in <head>, BEFORE the stylesheet,
   because the pre-paint stamp below it calls boot()) and required by server.js, which validates the
   theme files a human drops in the themes directory against the same rules.

   A THEME is `{ name, scheme, tokens }`: a display name, `light` or `dark`, and the colour tokens the
   stylesheet reads. That is the whole format, and a user's own theme file on disk is the same three
   fields — which is the point. The palette used to live three times in index.html's <style> (a `:root`
   block and two copies of a dark one); it lives here once per theme now, and the CSS holds no colour
   at all. Applying a theme writes its tokens onto <html> as inline custom properties, so no rule in
   the stylesheet knows a theme exists and adding one costs no CSS.

   Three rules every built-in keeps, and a user theme is free to break only the last:
   - YELLOW = THE AGENT. `--yellow` is #ffeb00 in all eight and `--on-yellow` is the dark ink that sits
     on it. An agent that changed colour with the room would stop being a convention.
   - An artboard is paper. `--asset-canvas` is white everywhere: an asset is someone's own design, built
     for a white page, and a dark backing would show through what it does not paint.
   - iA Writer's rule in both directions: never pure black on pure white, never pure white on pure black.

   The LAYOUT tokens are not here and must not be added: --t-*, --r-*, --measure, --prose-*, --rail-w,
   --nav-w, --track-caps and --spring-press stay on :root in the stylesheet, for the reason they were
   always exempt from the palette — a size is a size in every theme, and a theme file that could change
   one would be a palette resizing the tool. */
(function (root) {
  // Every token a theme carries, in the order the stylesheet declared them. A theme file naming
  // something that is not on this list has that key ignored rather than the file rejected: a token
  // renamed in a future version must not turn every theme on disk into an error.
  const TOKENS = [
    '--bg', '--fill', '--card', '--card-off',
    '--card-fade', '--ink', '--ink-btn', '--ink-btn-hover',
    '--on-ink', '--on-ink-edge', '--on-ink-edge-strong', '--fg',
    '--ink-2', '--ink-3', '--muted', '--faint',
    '--fainter', '--dead', '--line', '--line-2',
    '--line-strong', '--shell', '--shell-row', '--shell-on',
    '--yellow', '--yellow-ring', '--chip', '--chip-fg',
    '--on-yellow', '--chip-n', '--chip-n-2', '--toast',
    '--toast-fg', '--toast-btn', '--toast-btn-fg', '--toast-btn-hover',
    '--toast-shadow', '--asset-canvas', '--anchor-wash', '--anchor-wash-mine',
    '--flash-fill', '--flash-ring', '--flash-ring-strong', '--scrim',
    '--scrim-soft', '--shadow', '--shadow-raise', '--shadow-panel',
    '--shadow-pill', '--ring',
  ];
  const TOKEN_SET = new Set(TOKENS);
  const SCHEMES = ['light', 'dark'];

  // ---------- the eight built-ins ----------
  // paper and ink are the two palettes sidecar shipped with, moved here verbatim. The other six were
  // built on the same ramps: the ink steps down toward the ground at fixed distances (fg .13, muted
  // .50, dead .74 on a light ground; .12, .42, .70 on a dark one), the surfaces step up off it, and
  // the hairlines are the ink at 8/14/16% on light and white at 10/16/22% on dark. Every one of them
  // clears 7:1 for body copy on its own ground, which a test asserts rather than trusts.
  const BUILTIN = {
    // The white ground sidecar was designed on: warm off-whites, a near-black warm ink.
    paper: { name: 'paper', scheme: 'light', tokens: {
      '--bg': '#ffffff',
      '--fill': '#faf9f4',
      '--card': '#ffffff',
      '--card-off': '#fafaf8',
      '--card-fade': 'rgba(255,255,255,0)',
      '--ink': '#141410',
      '--ink-btn': '#1b1a15',
      '--ink-btn-hover': '#26251e',
      '--on-ink': '#ffffff',
      '--on-ink-edge': 'rgba(255,255,255,.16)',
      '--on-ink-edge-strong': 'rgba(255,255,255,.3)',
      '--fg': '#33332c',
      '--ink-2': '#57574f',
      '--ink-3': '#6b6b64',
      '--muted': '#8a8a82',
      '--faint': '#a3a39b',
      '--fainter': '#b0b0a8',
      '--dead': '#c2c2ba',
      '--line': 'rgba(20,20,15,.08)',
      '--line-2': 'rgba(20,20,15,.14)',
      '--line-strong': 'rgba(20,20,15,.16)',
      '--shell': '#f6f5ef',
      '--shell-row': 'rgba(20,20,15,.05)',
      '--shell-on': 'rgba(20,20,15,.095)',
      '--yellow': '#ffeb00',
      '--yellow-ring': 'rgba(190,172,0,.65)',
      '--chip': '#fffce0',
      '--chip-fg': '#2b2a20',
      '--on-yellow': '#2b2a20',
      '--chip-n': '#f2f2ee',
      '--chip-n-2': '#e4e4dc',
      '--toast': '#1b1a15',
      '--toast-fg': '#faf9f4',
      '--toast-btn': '#ffffff',
      '--toast-btn-fg': '#141410',
      '--toast-btn-hover': '#f0f0ea',
      '--toast-shadow': '0 1px 2px rgba(0,0,0,.2), 0 18px 40px -18px rgba(0,0,0,.5)',
      '--asset-canvas': '#ffffff',
      '--anchor-wash': 'rgba(255,235,0,.30)',
      '--anchor-wash-mine': 'rgba(20,20,15,.085)',
      '--flash-fill': 'rgba(255,235,0,.32)',
      '--flash-ring': 'rgba(255,235,0,.3)',
      '--flash-ring-strong': 'rgba(255,235,0,.55)',
      '--scrim': 'rgba(20,20,18,.82)',
      '--scrim-soft': 'rgba(20,20,15,.28)',
      '--shadow': '0 1px 2px rgba(20,20,15,.05), 0 10px 30px -20px rgba(20,20,15,.35)',
      '--shadow-raise': '0 1px 2px rgba(20,20,15,.06)',
      '--shadow-panel': 'rgba(20,20,15,.18)',
      '--shadow-pill': 'rgba(20,20,15,.4)',
      '--ring': '0 0 0 3px rgba(20,20,15,.08)',
    } },
    // Cream paper and brown-black ink, the colour of a book left in the sun.
    sepia: { name: 'sepia', scheme: 'light', tokens: {
      '--bg': '#f6efdd',
      '--fill': '#f0e7d1',
      '--card': '#fdf8ea',
      '--card-off': '#f8f3e5',
      '--card-fade': 'rgba(253,248,234,0)',
      '--ink': '#2a2017',
      '--ink-btn': '#30261d',
      '--ink-btn-hover': '#393026',
      '--on-ink': '#fdf8ea',
      '--on-ink-edge': 'rgba(255,255,255,.16)',
      '--on-ink-edge-strong': 'rgba(255,255,255,.3)',
      '--fg': '#453b31',
      '--ink-2': '#635a4e',
      '--ink-3': '#756d60',
      '--muted': '#90887a',
      '--faint': '#a69e90',
      '--fainter': '#b1a99a',
      '--dead': '#c1b9aa',
      '--line': 'rgba(42,32,23,.08)',
      '--line-2': 'rgba(42,32,23,.14)',
      '--line-strong': 'rgba(42,32,23,.16)',
      '--shell': '#efe6cd',
      '--shell-row': 'rgba(42,32,23,.05)',
      '--shell-on': 'rgba(42,32,23,.095)',
      '--yellow': '#ffeb00',
      '--yellow-ring': 'rgba(190,172,0,.65)',
      '--chip': '#f7eebe',
      '--chip-fg': '#2b2a20',
      '--on-yellow': '#2b2a20',
      '--chip-n': '#eae3d1',
      '--chip-n-2': '#ddd5c4',
      '--toast': '#30261d',
      '--toast-fg': '#f0e7d1',
      '--toast-btn': '#fdf8ea',
      '--toast-btn-fg': '#2a2017',
      '--toast-btn-hover': '#e8e1cf',
      '--toast-shadow': '0 1px 2px rgba(0,0,0,.2), 0 18px 40px -18px rgba(0,0,0,.5)',
      '--asset-canvas': '#ffffff',
      '--anchor-wash': 'rgba(255,235,0,.3)',
      '--anchor-wash-mine': 'rgba(42,32,23,.085)',
      '--flash-fill': 'rgba(255,235,0,.32)',
      '--flash-ring': 'rgba(255,235,0,.3)',
      '--flash-ring-strong': 'rgba(255,235,0,.55)',
      '--scrim': 'rgba(42,32,23,.82)',
      '--scrim-soft': 'rgba(42,32,23,.28)',
      '--shadow': '0 1px 2px rgba(42,32,23,.05), 0 10px 30px -20px rgba(42,32,23,.35)',
      '--shadow-raise': '0 1px 2px rgba(42,32,23,.06)',
      '--shadow-panel': 'rgba(42,32,23,.18)',
      '--shadow-pill': 'rgba(42,32,23,.4)',
      '--ring': '0 0 0 3px rgba(42,32,23,.08)',
    } },
    // A cool grey-blue ground, and the ink carries the same blue.
    slate: { name: 'slate', scheme: 'light', tokens: {
      '--bg': '#eef1f6',
      '--fill': '#e7ebf2',
      '--card': '#fbfcfe',
      '--card-off': '#f6f7f9',
      '--card-fade': 'rgba(251,252,254,0)',
      '--ink': '#141a22',
      '--ink-btn': '#1a2028',
      '--ink-btn-hover': '#242a32',
      '--on-ink': '#fbfcfe',
      '--on-ink-edge': 'rgba(255,255,255,.16)',
      '--on-ink-edge-strong': 'rgba(255,255,255,.3)',
      '--fg': '#30363e',
      '--ink-2': '#51565d',
      '--ink-3': '#656a70',
      '--muted': '#81868c',
      '--faint': '#999da3',
      '--fainter': '#a4a8ae',
      '--dead': '#b5b9bf',
      '--line': 'rgba(20,26,34,.08)',
      '--line-2': 'rgba(20,26,34,.14)',
      '--line-strong': 'rgba(20,26,34,.16)',
      '--shell': '#e5eaf1',
      '--shell-row': 'rgba(20,26,34,.05)',
      '--shell-on': 'rgba(20,26,34,.095)',
      '--yellow': '#ffeb00',
      '--yellow-ring': 'rgba(190,172,0,.65)',
      '--chip': '#f0f0d4',
      '--chip-fg': '#2b2a20',
      '--on-yellow': '#2b2a20',
      '--chip-n': '#e1e4e9',
      '--chip-n-2': '#d3d6dc',
      '--toast': '#1a2028',
      '--toast-fg': '#e7ebf2',
      '--toast-btn': '#fbfcfe',
      '--toast-btn-fg': '#141a22',
      '--toast-btn-hover': '#dfe2e7',
      '--toast-shadow': '0 1px 2px rgba(0,0,0,.2), 0 18px 40px -18px rgba(0,0,0,.5)',
      '--asset-canvas': '#ffffff',
      '--anchor-wash': 'rgba(255,235,0,.3)',
      '--anchor-wash-mine': 'rgba(20,26,34,.085)',
      '--flash-fill': 'rgba(255,235,0,.32)',
      '--flash-ring': 'rgba(255,235,0,.3)',
      '--flash-ring-strong': 'rgba(255,235,0,.55)',
      '--scrim': 'rgba(20,26,34,.82)',
      '--scrim-soft': 'rgba(20,26,34,.28)',
      '--shadow': '0 1px 2px rgba(20,26,34,.05), 0 10px 30px -20px rgba(20,26,34,.35)',
      '--shadow-raise': '0 1px 2px rgba(20,26,34,.06)',
      '--shadow-panel': 'rgba(20,26,34,.18)',
      '--shadow-pill': 'rgba(20,26,34,.4)',
      '--ring': '0 0 0 3px rgba(20,26,34,.08)',
    } },
    // For a bright room and tired eyes: ink at full strength, hairlines you can see.
    contrast: { name: 'contrast', scheme: 'light', tokens: {
      '--bg': '#ffffff',
      '--fill': '#f0f0ee',
      '--card': '#ffffff',
      '--card-off': '#f9f9f9',
      '--card-fade': 'rgba(255,255,255,0)',
      '--ink': '#0d0d0c',
      '--ink-btn': '#141413',
      '--ink-btn-hover': '#1f1f1e',
      '--on-ink': '#ffffff',
      '--on-ink-edge': 'rgba(255,255,255,.16)',
      '--on-ink-edge-strong': 'rgba(255,255,255,.3)',
      '--fg': '#1c1c1b',
      '--ink-2': '#2f2f2e',
      '--ink-3': '#3d3d3d',
      '--muted': '#515150',
      '--faint': '#646463',
      '--fainter': '#777777',
      '--dead': '#959594',
      '--line': 'rgba(13,13,12,.16)',
      '--line-2': 'rgba(13,13,12,.28)',
      '--line-strong': 'rgba(13,13,12,.4)',
      '--shell': '#ececeb',
      '--shell-row': 'rgba(13,13,12,.05)',
      '--shell-on': 'rgba(13,13,12,.095)',
      '--yellow': '#ffeb00',
      '--yellow-ring': 'rgba(190,172,0,.65)',
      '--chip': '#fffcdb',
      '--chip-fg': '#2b2a20',
      '--on-yellow': '#2b2a20',
      '--chip-n': '#f0f0f0',
      '--chip-n-2': '#e1e1e1',
      '--toast': '#141413',
      '--toast-fg': '#f0f0ee',
      '--toast-btn': '#ffffff',
      '--toast-btn-fg': '#0d0d0c',
      '--toast-btn-hover': '#eeeeee',
      '--toast-shadow': '0 1px 2px rgba(0,0,0,.2), 0 18px 40px -18px rgba(0,0,0,.5)',
      '--asset-canvas': '#ffffff',
      '--anchor-wash': 'rgba(255,235,0,.32)',
      '--anchor-wash-mine': 'rgba(13,13,12,.085)',
      '--flash-fill': 'rgba(255,235,0,.32)',
      '--flash-ring': 'rgba(255,235,0,.3)',
      '--flash-ring-strong': 'rgba(255,235,0,.55)',
      '--scrim': 'rgba(13,13,12,.82)',
      '--scrim-soft': 'rgba(13,13,12,.28)',
      '--shadow': '0 1px 2px rgba(13,13,12,.05), 0 10px 30px -20px rgba(13,13,12,.35)',
      '--shadow-raise': '0 1px 2px rgba(13,13,12,.06)',
      '--shadow-panel': 'rgba(13,13,12,.18)',
      '--shadow-pill': 'rgba(13,13,12,.4)',
      '--ring': '0 0 0 3px rgba(13,13,12,.08)',
    } },
    // The warm near-black the toast was already wearing, under a warm light grey ink.
    ink: { name: 'ink', scheme: 'dark', tokens: {
      '--bg': '#16150f',
      '--fill': '#211f18',
      '--card': '#272520',
      '--card-off': '#1d1b15',
      '--card-fade': 'rgba(39,37,32,0)',
      '--ink': '#e6e4da',
      '--ink-btn': '#e6e4da',
      '--ink-btn-hover': '#f3f1e7',
      '--on-ink': '#16150f',
      '--on-ink-edge': 'rgba(20,20,15,.2)',
      '--on-ink-edge-strong': 'rgba(20,20,15,.34)',
      '--fg': '#cdcbc0',
      '--ink-2': '#b7b5aa',
      '--ink-3': '#a29f95',
      '--muted': '#918e83',
      '--faint': '#7b786e',
      '--fainter': '#6b6860',
      '--dead': '#56534a',
      '--line': 'rgba(255,255,255,.10)',
      '--line-2': 'rgba(255,255,255,.16)',
      '--line-strong': 'rgba(255,255,255,.22)',
      '--shell': '#1b1a14',
      '--shell-row': 'rgba(255,255,255,.055)',
      '--shell-on': 'rgba(255,255,255,.10)',
      '--yellow': '#ffeb00',
      '--yellow-ring': 'rgba(216,197,28,.75)',
      '--chip': '#2e2a12',
      '--chip-fg': '#efe7bd',
      '--on-yellow': '#2b2a20',
      '--chip-n': '#27251c',
      '--chip-n-2': '#35322a',
      '--toast': '#e9e7dd',
      '--toast-fg': '#1b1a15',
      '--toast-btn': '#16150f',
      '--toast-btn-fg': '#f0eee4',
      '--toast-btn-hover': '#2a2820',
      '--toast-shadow': '0 1px 2px rgba(0,0,0,.3), 0 18px 40px -16px rgba(0,0,0,.75)',
      '--asset-canvas': '#ffffff',
      '--anchor-wash': 'rgba(255,235,0,.17)',
      '--anchor-wash-mine': 'rgba(255,255,255,.11)',
      '--flash-fill': 'rgba(255,235,0,.26)',
      '--flash-ring': 'rgba(255,235,0,.26)',
      '--flash-ring-strong': 'rgba(255,235,0,.5)',
      '--scrim': 'rgba(0,0,0,.86)',
      '--scrim-soft': 'rgba(0,0,0,.55)',
      '--shadow': '0 1px 2px rgba(0,0,0,.45), 0 10px 30px -18px rgba(0,0,0,.9)',
      '--shadow-raise': '0 1px 2px rgba(0,0,0,.5)',
      '--shadow-panel': 'rgba(0,0,0,.6)',
      '--shadow-pill': 'rgba(0,0,0,.7)',
      '--ring': '0 0 0 3px rgba(255,255,255,.14)',
    } },
    // Sepia after dark: a warm brown ground under the same cream ink.
    'sepia-dark': { name: 'sepia dark', scheme: 'dark', tokens: {
      '--bg': '#1e1710',
      '--fill': '#282019',
      '--card': '#2e271f',
      '--card-off': '#241d16',
      '--card-fade': 'rgba(46,39,31,0)',
      '--ink': '#e9dcc4',
      '--ink-btn': '#e9dcc4',
      '--ink-btn-hover': '#f3ecdf',
      '--on-ink': '#1e1710',
      '--on-ink-edge': 'rgba(30,23,16,.2)',
      '--on-ink-edge-strong': 'rgba(30,23,16,.34)',
      '--fg': '#d1c4ae',
      '--ink-2': '#baaf9b',
      '--ink-3': '#a69b89',
      '--muted': '#948978',
      '--faint': '#7f7666',
      '--fainter': '#6f6658',
      '--dead': '#5b5246',
      '--line': 'rgba(255,255,255,.1)',
      '--line-2': 'rgba(255,255,255,.16)',
      '--line-strong': 'rgba(255,255,255,.22)',
      '--shell': '#231c14',
      '--shell-row': 'rgba(255,255,255,.055)',
      '--shell-on': 'rgba(255,255,255,.10)',
      '--yellow': '#ffeb00',
      '--yellow-ring': 'rgba(216,197,28,.75)',
      '--chip': '#352c0e',
      '--chip-fg': '#f0e189',
      '--on-yellow': '#2b2a20',
      '--chip-n': '#2d261d',
      '--chip-n-2': '#3b3329',
      '--toast': '#ebe0ca',
      '--toast-fg': '#261f17',
      '--toast-btn': '#1e1710',
      '--toast-btn-fg': '#ebe0ca',
      '--toast-btn-hover': '#302920',
      '--toast-shadow': '0 1px 2px rgba(0,0,0,.3), 0 18px 40px -16px rgba(0,0,0,.75)',
      '--asset-canvas': '#ffffff',
      '--anchor-wash': 'rgba(255,235,0,.17)',
      '--anchor-wash-mine': 'rgba(255,255,255,.11)',
      '--flash-fill': 'rgba(255,235,0,.26)',
      '--flash-ring': 'rgba(255,235,0,.26)',
      '--flash-ring-strong': 'rgba(255,235,0,.5)',
      '--scrim': 'rgba(0,0,0,.86)',
      '--scrim-soft': 'rgba(0,0,0,.55)',
      '--shadow': '0 1px 2px rgba(0,0,0,.45), 0 10px 30px -18px rgba(0,0,0,.9)',
      '--shadow-raise': '0 1px 2px rgba(0,0,0,.5)',
      '--shadow-panel': 'rgba(0,0,0,.6)',
      '--shadow-pill': 'rgba(0,0,0,.7)',
      '--ring': '0 0 0 3px rgba(255,255,255,.14)',
    } },
    // A cool near-black, blue where the ink and the paper both were.
    'slate-dark': { name: 'slate dark', scheme: 'dark', tokens: {
      '--bg': '#0f131a',
      '--fill': '#191d24',
      '--card': '#20242b',
      '--card-off': '#151920',
      '--card-fade': 'rgba(32,36,43,0)',
      '--ink': '#dce2ea',
      '--ink-btn': '#dce2ea',
      '--ink-btn-hover': '#eceff3',
      '--on-ink': '#0f131a',
      '--on-ink-edge': 'rgba(15,19,26,.2)',
      '--on-ink-edge-strong': 'rgba(15,19,26,.34)',
      '--fg': '#c3c9d1',
      '--ink-2': '#adb2ba',
      '--ink-3': '#989ea5',
      '--muted': '#868b93',
      '--faint': '#71767e',
      '--fainter': '#61666d',
      '--dead': '#4d5158',
      '--line': 'rgba(255,255,255,.1)',
      '--line-2': 'rgba(255,255,255,.16)',
      '--line-strong': 'rgba(255,255,255,.22)',
      '--shell': '#14181f',
      '--shell-row': 'rgba(255,255,255,.055)',
      '--shell-on': 'rgba(255,255,255,.10)',
      '--yellow': '#ffeb00',
      '--yellow-ring': 'rgba(216,197,28,.75)',
      '--chip': '#272917',
      '--chip-fg': '#e7e5a4',
      '--on-yellow': '#2b2a20',
      '--chip-n': '#1e2229',
      '--chip-n-2': '#2c3037',
      '--toast': '#e0e5ec',
      '--toast-fg': '#171b22',
      '--toast-btn': '#0f131a',
      '--toast-btn-fg': '#e0e5ec',
      '--toast-btn-hover': '#21262d',
      '--toast-shadow': '0 1px 2px rgba(0,0,0,.3), 0 18px 40px -16px rgba(0,0,0,.75)',
      '--asset-canvas': '#ffffff',
      '--anchor-wash': 'rgba(255,235,0,.17)',
      '--anchor-wash-mine': 'rgba(255,255,255,.11)',
      '--flash-fill': 'rgba(255,235,0,.26)',
      '--flash-ring': 'rgba(255,235,0,.26)',
      '--flash-ring-strong': 'rgba(255,235,0,.5)',
      '--scrim': 'rgba(0,0,0,.86)',
      '--scrim-soft': 'rgba(0,0,0,.55)',
      '--shadow': '0 1px 2px rgba(0,0,0,.45), 0 10px 30px -18px rgba(0,0,0,.9)',
      '--shadow-raise': '0 1px 2px rgba(0,0,0,.5)',
      '--shadow-panel': 'rgba(0,0,0,.6)',
      '--shadow-pill': 'rgba(0,0,0,.7)',
      '--ring': '0 0 0 3px rgba(255,255,255,.14)',
    } },
    // The high-contrast pair, after dark.
    'contrast-dark': { name: 'contrast dark', scheme: 'dark', tokens: {
      '--bg': '#0b0b0a',
      '--fill': '#161615',
      '--card': '#1c1c1a',
      '--card-off': '#121211',
      '--card-fade': 'rgba(28,28,26,0)',
      '--ink': '#f7f7f3',
      '--ink-btn': '#f7f7f3',
      '--ink-btn-hover': '#fbfbf8',
      '--on-ink': '#0b0b0a',
      '--on-ink-edge': 'rgba(11,11,10,.2)',
      '--on-ink-edge-strong': 'rgba(11,11,10,.34)',
      '--fg': '#e9e9e5',
      '--ink-2': '#d6d6d2',
      '--ink-3': '#c8c8c4',
      '--muted': '#b5b5b2',
      '--faint': '#a2a29f',
      '--fainter': '#8f8f8c',
      '--dead': '#737371',
      '--line': 'rgba(255,255,255,.2)',
      '--line-2': 'rgba(255,255,255,.34)',
      '--line-strong': 'rgba(255,255,255,.46)',
      '--shell': '#141413',
      '--shell-row': 'rgba(255,255,255,.055)',
      '--shell-on': 'rgba(255,255,255,.10)',
      '--yellow': '#ffeb00',
      '--yellow-ring': 'rgba(216,197,28,.75)',
      '--chip': '#232109',
      '--chip-fg': '#f9f3aa',
      '--on-yellow': '#2b2a20',
      '--chip-n': '#1c1c1b',
      '--chip-n-2': '#2c2c2b',
      '--toast': '#f8f8f4',
      '--toast-fg': '#141413',
      '--toast-btn': '#0b0b0a',
      '--toast-btn-fg': '#f8f8f4',
      '--toast-btn-hover': '#20201f',
      '--toast-shadow': '0 1px 2px rgba(0,0,0,.3), 0 18px 40px -16px rgba(0,0,0,.75)',
      '--asset-canvas': '#ffffff',
      '--anchor-wash': 'rgba(255,235,0,.2)',
      '--anchor-wash-mine': 'rgba(255,255,255,.11)',
      '--flash-fill': 'rgba(255,235,0,.26)',
      '--flash-ring': 'rgba(255,235,0,.26)',
      '--flash-ring-strong': 'rgba(255,235,0,.5)',
      '--scrim': 'rgba(0,0,0,.86)',
      '--scrim-soft': 'rgba(0,0,0,.55)',
      '--shadow': '0 1px 2px rgba(0,0,0,.45), 0 10px 30px -18px rgba(0,0,0,.9)',
      '--shadow-raise': '0 1px 2px rgba(0,0,0,.5)',
      '--shadow-panel': 'rgba(0,0,0,.6)',
      '--shadow-pill': 'rgba(0,0,0,.7)',
      '--ring': '0 0 0 3px rgba(255,255,255,.14)',
    } },
  };

  // The menu's order: the light four, then the dark four. Nothing sorts these at runtime — the reading
  // order is a decision, and paper and ink lead their own groups because they are the defaults.
  const ORDER = ['paper', 'sepia', 'slate', 'contrast', 'ink', 'sepia-dark', 'slate-dark', 'contrast-dark'];
  const DEFAULT = { light: 'paper', dark: 'ink' };
  const schemeOf = (s) => (s === 'dark' ? 'dark' : 'light');
  const base = (scheme) => BUILTIN[DEFAULT[schemeOf(scheme)]];

  /* ---------- the value grammar ----------
     This is the security boundary, and it is why the server requires this file rather than trusting
     what it reads. A theme file is a JSON document a human (or something pretending to be one) put in
     a directory, and every value in it ends up inside a CSS custom property that rules all over the
     page read. A custom property is not inert: `url(…)` fetches, and a value that escaped its
     declaration would be writing CSS. So a value is not sanitized, it is PARSED — a hex colour, an
     rgb/hsl function, a length, or a bare keyword, in any comma- or space-separated combination, which
     is exactly what a colour, a length and a box-shadow are made of. Anything else is not a value.
     `url` is refused by name as well as by shape, because it is the one function worth naming. */
  const HEX = /^#[0-9a-f]{3,8}$/i;
  const FN = /^(?:rgb|rgba|hsl|hsla)\(\s*[-0-9.,%\s/]*\)$/i;
  const LEN = /^-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|%)?$/;
  const WORD = /^[a-z]{3,24}$/i;
  function validValue(v) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (!s || s.length > 240) return false;
    // Nothing that could close a declaration, open a tag, start a comment or quote a string. The parse
    // below refuses all of these anyway; they are named here so the refusal is not an accident of which
    // patterns happen not to match.
    if (/[;{}<>\\"'@]/.test(s) || s.indexOf('/*') > -1 || /url\s*\(/i.test(s)) return false;
    // A function call is taken whole (its own parens, no nesting); everything else is a run of
    // non-separator characters. So `rgba(0,0,0,.5)` is one part and the commas inside it are not
    // separators, while a stray `)` or a nested call falls out as a part that matches nothing.
    const parts = s.match(/[a-z]+\([^()]*\)|[^\s,]+/gi) || [];
    if (!parts.length || parts.length > 24) return false;
    return parts.every((p) => HEX.test(p) || FN.test(p) || LEN.test(p)
      || (WORD.test(p) && p.toLowerCase() !== 'url'));
  }
  // A name is shown in a menu and slugified into a filename, so it is letters, digits and separators.
  const validName = (n) => typeof n === 'string' && /^[a-z0-9][a-z0-9 ._-]{0,39}$/i.test(n.trim());
  const isPlainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

  /* Read one theme file's parsed JSON. Returns `{ theme }` or `{ error }` — the error is a sentence
     shown to the human, since a theme they are editing in sidecar is a thing they will get wrong.
     Unknown token names are DROPPED and a missing one falls back to the built-in of the same scheme
     (see resolve), so the smallest useful theme file is a name, a scheme and one colour. A bad VALUE
     is a refusal rather than a drop: a token silently ignored because of a typo is a theme that half
     applies, which is harder to see than one that does not. */
  function validate(obj) {
    if (!isPlainObject(obj)) return { error: 'a theme is a JSON object' };
    if (!validName(obj.name)) return { error: 'name must be 1 to 40 letters, digits, spaces, dots, dashes or underscores' };
    if (SCHEMES.indexOf(obj.scheme) === -1) return { error: 'scheme must be "light" or "dark"' };
    if (!isPlainObject(obj.tokens)) return { error: 'tokens must be a JSON object of --token: value' };
    const tokens = {};
    for (const k of Object.keys(obj.tokens)) {
      if (!TOKEN_SET.has(k)) continue;                      // not a token sidecar reads — ignored, not fatal
      if (!validValue(obj.tokens[k])) return { error: k + ' is not a colour, a length or a shadow' };
      tokens[k] = String(obj.tokens[k]).trim();
    }
    return { theme: { name: obj.name.trim(), scheme: obj.scheme, tokens: tokens } };
  }

  // A theme's tokens over the built-in of its own scheme, so a file carrying three colours is a real
  // theme rather than a page with 47 empty properties.
  function resolve(theme) {
    const t = theme && isPlainObject(theme.tokens) ? theme.tokens : {};
    const fallback = base(theme && theme.scheme).tokens;
    const out = {};
    for (const k of TOKENS) out[k] = validValue(t[k]) ? String(t[k]).trim() : fallback[k];
    return out;
  }

  /* Put a theme on the page. The tokens go on as INLINE custom properties, which is what lets the
     stylesheet stay one set of rules reading one set of names: there is no per-theme CSS anywhere, and
     an inline property beats every selector, so nothing can out-specify a theme.
     `data-theme` carries the resolved SCHEME rather than the reader's mode, so the two things that
     genuinely need to know which way round the page is (the wordmark's inversion filter, and
     `color-scheme` for scrollbars and native controls) read one attribute and are right in every
     theme, a user's own included. */
  function apply(el, theme) {
    const scheme = schemeOf(theme && theme.scheme);
    const t = resolve(theme);
    for (let i = 0; i < TOKENS.length; i++) el.style.setProperty(TOKENS[i], t[TOKENS[i]]);
    el.style.setProperty('color-scheme', scheme);
    el.setAttribute('data-theme', scheme);
    return scheme;
  }

  // A built-in by id, or null. User themes are `user:<filename>`, which is what keeps a file called
  // paper.json from becoming a second paper.
  const isUserId = (id) => typeof id === 'string' && id.slice(0, 5) === 'user:';
  function builtin(id, scheme) {
    const t = BUILTIN[id];
    if (!t) return null;
    return scheme && t.scheme !== schemeOf(scheme) ? null : t;
  }

  /* What the page is wearing, resolved from storage alone, and the ONE function the pre-paint stamp in
     <head> calls. It has to work before anything else exists: no fetch, no uiStore, no DOM beyond
     <html>, and a localStorage that throws on every access (Safari in private mode) costs it nothing.

     A user theme cannot be read from a file before the first paint, so the page caches the one it
     applied under `sc:themeCache:<scheme>` and the stamp re-validates it through the same `validate`
     the server runs. Same rules, same refusals — the cache is not a second door, it is the first one
     with a shorter walk. A cache that does not match the stored choice is ignored and the scheme's
     built-in paints instead, which is one frame of paper before the file arrives. */
  function boot(doc, store) {
    const get = (k) => { try { return store.getItem('sc:' + k); } catch (e) { return null; } };
    const stored = get('theme');
    const mode = stored === 'light' || stored === 'dark' ? stored : 'system';
    const scheme = mode === 'system' ? systemScheme(doc) : mode;
    const id = get(scheme === 'dark' ? 'themeDark' : 'themeLight') || DEFAULT[scheme];
    let theme = builtin(id, scheme);
    if (!theme && isUserId(id)) {
      try {
        const c = JSON.parse(get('themeCache:' + scheme));
        if (c && c.id === id) theme = validate(c.theme).theme || null;
        if (theme && theme.scheme !== scheme) theme = null;
      } catch (e) {}
    }
    if (!theme) theme = base(scheme);
    apply(doc.documentElement, theme);
    return { mode: mode, scheme: scheme, id: id, theme: theme };
  }
  // What the room is set to. The stylesheet used to answer this on its own through a media query; a
  // theme is applied by script now, so the question is asked rather than delegated — and `system` has
  // to keep following the room, which is why index.html listens to the same query for changes.
  function systemScheme(doc) {
    try {
      const w = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
      return w && w.matchMedia && w.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  // A theme copied for editing: every token spelled out, so the file a human opens shows the whole
  // palette rather than the handful that happened to differ from a built-in.
  function expand(theme, name) {
    return { name: name || theme.name, scheme: schemeOf(theme && theme.scheme), tokens: resolve(theme) };
  }
  // The filename a copy lands under. Everything outside [a-z0-9-] goes, because this string is joined
  // onto a directory path — and the server checks the join as well, rather than trusting this.
  const slug = (name) => String(name || 'theme').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40) || 'theme';

  const api = { TOKENS: TOKENS, BUILTIN: BUILTIN, ORDER: ORDER, DEFAULT: DEFAULT, SCHEMES: SCHEMES,
    validValue: validValue, validName: validName, validate: validate, resolve: resolve, apply: apply,
    boot: boot, systemScheme: systemScheme, builtin: builtin, isUserId: isUserId, expand: expand,
    slug: slug, schemeOf: schemeOf, base: base };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Themes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
