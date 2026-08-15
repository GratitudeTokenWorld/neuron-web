import { describe, it, expect } from 'vitest';
// Read through Vite's `?raw`, not node:fs — @types/node is scoped to
// tsconfig.storage.json, so a node import here would add app-layer type errors.
import html from '../../index.html?raw';

/**
 * The capture guide's markup has to satisfy two CSS contracts that nothing else
 * checks — `index.html` is not typechecked, not bundled through any test, and
 * the failure mode of breaking either is *silent* (the guide simply is not
 * there, on a screen the user only reaches during enrollment).
 *
 * Both rules below were written as comments first and broken anyway.
 */

/** The guide's `<svg>…</svg>`, which is where both invariants live. */
function guideSvg(): string {
  const m = html.match(/<svg id="captureGuideSvg"[\s\S]*?<\/svg>/);
  if (!m) throw new Error('#captureGuideSvg not found in index.html');
  return m[0];
}

describe('capture guide markup', () => {
  it('reveals one cue at a time by hiding every group', () => {
    // The premise of the test below. If this rule ever goes, revisit both.
    expect(html).toMatch(/\.capture-guide g \{ display: none; \}/);
  });

  it('has NO wrapper group — every <g> is a cue group', () => {
    // `.capture-guide g { display: none }` hides EVERY group, and `data-guide`
    // re-shows one. A wrapper <g> (added once to translate the art for portrait
    // feeds) is caught by that same rule, and a descendant cannot un-hide a
    // hidden ancestor — so the entire guide disappears, with no error anywhere.
    // Anything needing to move the art must move the viewBox instead.
    const groups = [...guideSvg().matchAll(/<g\b[^>]*>/g)].map(m => m[0]);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g, `${g} is not a cue group — a wrapper <g> hides the whole guide`)
        .toMatch(/class="cg-(turn|blink|smile|mouth|depth|brow)"/);
    }
  });

  it('scales the depth ring about its own box, not a view-box point', () => {
    // fitCaptureGuide() moves the viewBox's min-y negative to match a portrait
    // stream, and a `transform-box: view-box` origin is measured FROM min-y — so
    // a hard-coded origin slides off the ring's centre by half the added height
    // and the depth readout drifts as it scales. fill-box is min-y-invariant.
    const rule = html.match(/\.cg-depth-oval \{[\s\S]*?\}/)?.[0] ?? '';
    expect(rule).toMatch(/transform-box:\s*fill-box/);
    expect(rule).not.toMatch(/transform-box:\s*view-box/);
  });
});
