import { buildConfirmAutoSubmitScript } from './confirmAutoSubmit';

describe('buildConfirmAutoSubmitScript', () => {
  it('builds a deterministic single script tag', () => {
    expect(buildConfirmAutoSubmitScript()).toBe(
      buildConfirmAutoSubmitScript(),
    );
    const html = buildConfirmAutoSubmitScript();
    expect(html.startsWith('<script>')).toBe(true);
    expect(html.endsWith('</script>')).toBe(true);
    // Exactly one script element: no room for a second payload to hide.
    expect(html.split('<script>').length).toBe(2);
  });

  it('carries the human-presence gate and the single-submit guard', () => {
    const html = buildConfirmAutoSubmitScript();
    expect(html).toContain("document.visibilityState==='visible'");
    expect(html).toContain('document.hasFocus()');
    expect(html).toContain('var submitted=false');
    expect(html).toContain('document.forms[0].submit()');
    for (const signal of [
      'visibilitychange',
      'focus',
      'pointerdown',
      'keydown',
    ]) {
      expect(html).toContain(signal);
    }
  });

  it('coordinates with the native path: disables the button, stands down when already disabled', () => {
    // The race this pins: background→foreground switch landing within
    // milliseconds of a manual click. A real double-POST here is
    // timing-flaky by nature, so the builder pins the coordination
    // textually instead — string-identical for route and e2e mock.
    const html = buildConfirmAutoSubmitScript();
    // Own path disables the button: a later native click no-ops.
    expect(html).toContain('if(b){b.disabled=true;}');
    // Native path won (onsubmit disable ran): stand down, mark spent.
    expect(html).toContain('if(b&&b.disabled){submitted=true;return;}');
    // A throw must never wedge the form disabled with no submission.
    expect(html).toContain('b.disabled=false');
  });

  it('composes no interpolated values (nothing to break out of markup)', () => {
    // The builder takes no arguments by design: every byte is a fixed
    // literal, so no token/locale string can ever inject markup here.
    expect(buildConfirmAutoSubmitScript.length).toBe(0);
  });
});
