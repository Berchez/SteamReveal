/**
 * Confirm-page auto-submit script — single source of truth shared by the
 * route (`confirm/route.ts`) and the e2e mock (`e2e/watch.spec.ts`).
 *
 * Lives here — NOT in route.ts: the e2e mock used to carry a hand-synced
 * copy of this string ("mirrors production byte for byte"), which rots
 * the first time one side changes. Both sides now import this builder,
 * so the mock can never drift from production.
 *
 * Pure string building, zero dependencies: safe to import from the Next
 * route module and from the Playwright runner alike (no next/headers,
 * no DB, no side effects).
 *
 * Contract (pinned by route unit tests + the e2e flow): human-presence
 * gate (visible + focused on load, else first
 * visibilitychange/focus/pointerdown/keydown) plus a two-path
 * single-submission guard. Background tabs, prerendered loads and
 * headless scanners never satisfy the gate.
 *
 * The guard must coordinate BOTH submission paths, not just its own:
 * without this, a background→foreground switch landing within
 * milliseconds of a manual click double-POSTs — the single-use token
 * burns on the first arrival and the second renders the error page over
 * a success. So the script disables the button on its own path (a later
 * native click then no-ops), stands down when it observes the button
 * already disabled (a native click won — the onsubmit disable ran), and
 * re-enables on submit failure so a throw never wedges the form.
 * form.submit() bypasses onsubmit, which is exactly why the onsubmit
 * button-disable alone cannot cover the programmatic path.
 */
// Named (not default) export on purpose: both consumers (the route and
// the e2e mock) import it by name next to their other named imports.
// eslint-disable-next-line import/prefer-default-export
export const buildConfirmAutoSubmitScript = (): string =>
  `<script>(function(){` +
  `var submitted=false;` +
  `function submit(){` +
  `if(submitted){return;}` +
  `var b=null;try{b=document.querySelector('button');}catch(e){}` +
  `if(b&&b.disabled){submitted=true;return;}` +
  `submitted=true;` +
  `try{if(b){b.disabled=true;}}catch(e){}` +
  `try{document.forms[0].submit();}` +
  `catch(e){submitted=false;try{if(b){b.disabled=false;}}catch(_){}}` +
  `}` +
  `function humanPresent(){return document.visibilityState==='visible'&&document.hasFocus();}` +
  `if(humanPresent()){submit();return;}` +
  `function onShow(){if(humanPresent()){submit();cleanup();}}` +
  `function cleanup(){document.removeEventListener('visibilitychange',onShow);window.removeEventListener('focus',onShow);document.removeEventListener('pointerdown',onShow);document.removeEventListener('keydown',onShow);}` +
  `document.addEventListener('visibilitychange',onShow);` +
  `window.addEventListener('focus',onShow);` +
  `document.addEventListener('pointerdown',onShow);` +
  `document.addEventListener('keydown',onShow);` +
  `})();</script>`;
