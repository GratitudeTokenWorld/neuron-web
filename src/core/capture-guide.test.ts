import { describe, it, expect } from 'vitest';
// Read through Vite's `?raw`, not node:fs — @types/node is scoped to
// tsconfig.storage.json, so a node import here would add app-layer type errors.
import html from '../../index.html?raw';
import { GUIDE_VIEWBOX, squareSide, squareOriginX, squareOriginY } from './capture-guide.js';

/**
 * The capture guide's markup has to satisfy contracts that nothing else checks —
 * `index.html` is not typechecked, not bundled through any test, and the failure
 * mode of breaking any of them is *silent*: either the guide is not there, or it
 * disagrees with the gate that judges the framing, on a screen the user only
 * reaches during enrollment. Each rule below was written as a comment first and
 * broken anyway.
 */

/** The guide's `<svg>…</svg>`. */
function guideSvg(): string {
  const m = html.match(/<svg id="captureGuideSvg"[\s\S]*?<\/svg>/);
  if (!m) throw new Error('#captureGuideSvg not found in index.html');
  return m[0];
}

describe('the square capture frame', () => {
  it('presents the same surface whatever orientation the camera hands back', () => {
    // The whole point: a 4:3 webcam and a portrait phone reduce to one frame.
    expect(squareSide(640, 480)).toBe(480);
    expect(squareSide(480, 640)).toBe(480);
    expect(squareSide(1280, 720)).toBe(720);
  });

  it('crops from the centre on both axes', () => {
    expect(squareOriginX(640, 480)).toBe(80);   // 80px trimmed each side
    expect(squareOriginY(640, 480)).toBe(0);
    expect(squareOriginX(480, 640)).toBe(0);
    expect(squareOriginY(480, 640)).toBe(80);   // 80px trimmed top and bottom
  });

  it('falls back sanely before the stream reports its size', () => {
    expect(squareSide(0, 0)).toBe(480);
    expect(squareOriginX(0, 0)).toBe(0);
  });

  it('demands the SAME physical framing on a phone as on a laptop', () => {
    // The bug this replaced: `frac` divided by frame WIDTH, the long side of a
    // 4:3 feed but the short side of a portrait one, so one band described two
    // framings and the phone user was pushed too far from the camera.
    const MIN = 0.15 * (4 / 3), MAX = 0.32 * (4 / 3);   // face-verify's band
    const px = (w: number, h: number, frac: number) => frac * squareSide(w, h);
    expect(px(640, 480, MIN)).toBeCloseTo(px(480, 640, MIN), 6);
    expect(px(640, 480, MAX)).toBeCloseTo(px(480, 640, MAX), 6);
    // ...and it is the band the traces were taken against: 0.15 and 0.32 of a
    // 640px-wide 4:3 frame, i.e. 96px and 205px of eye span. Re-expressed, not
    // retuned — desktop framing is unchanged to the pixel.
    expect(px(640, 480, MIN)).toBeCloseTo(0.15 * 640, 1);
    expect(px(640, 480, MAX)).toBeCloseTo(0.32 * 640, 1);
  });
});

describe('capture guide markup', () => {
  it('reveals one cue at a time by hiding every group', () => {
    // The premise of the wrapper test below. If this rule ever goes, revisit it.
    expect(html).toMatch(/\.capture-guide g \{ display: none; \}/);
  });

  it('has NO wrapper group — every <g> is a cue group', () => {
    // `.capture-guide g { display: none }` hides EVERY group, and `data-guide`
    // re-shows one. A wrapper <g> (added once to translate the art for portrait
    // feeds) is caught by that same rule, and a descendant cannot un-hide a
    // hidden ancestor — so the entire guide disappears, with no error anywhere.
    const groups = [...guideSvg().matchAll(/<g\b[^>]*>/g)].map(m => m[0]);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g, `${g} is not a cue group — a wrapper <g> hides the whole guide`)
        .toMatch(/class="cg-(turn|blink|smile|mouth|depth|brow)"/);
    }
  });

  it('draws on the square viewBox the code says it does', () => {
    // The markup carries the viewBox (no JS fitting step), so this is the only
    // thing keeping it and GUIDE_VIEWBOX from drifting apart.
    expect(guideSvg()).toContain(`viewBox="${GUIDE_VIEWBOX}"`);
  });

  it('keeps every cue inside that viewBox', () => {
    // The square window is narrower than the 200-unit art canvas, so zooming in
    // clips from the SIDES. The turn chevrons are the extreme: their vertices
    // sit at x=28, and mirror to x=172 for a right-turn prompt.
    const [minX, , w] = GUIDE_VIEWBOX.split(' ').map(Number) as [number, number, number, number];
    const maxX = minX + w;
    const chevronXs = [...guideSvg().matchAll(/d="M(\d+) 74 l9/g)].map(m => Number(m[1]));
    expect(chevronXs.length).toBeGreaterThan(0);
    for (const x of chevronXs) {
      expect(x, `chevron at x=${x} is clipped on the left`).toBeGreaterThanOrEqual(minX);
      const mirrored = 200 - x;                 // data-dir="right" flips about x=100
      expect(mirrored, `chevron mirrors to x=${mirrored}, clipped on the right`).toBeLessThanOrEqual(maxX);
    }
    // The oval, the one cue that is always drawn.
    const oval = guideSvg().match(/class="cg-oval" cx="(\d+)" cy="(\d+)" rx="(\d+)"/);
    expect(oval).toBeTruthy();
    const [cx, , rx] = [Number(oval![1]), Number(oval![2]), Number(oval![3])];
    expect(cx - rx).toBeGreaterThanOrEqual(minX);
    expect(cx + rx).toBeLessThanOrEqual(maxX);
  });

  it('shows the same square the metrics are measured against', () => {
    // display/metric agreement. `object-fit: cover` on a 1:1 box crops exactly
    // the centred square that squareSide()/squareOriginX() describe. Cropping
    // only ONE of the two is the "guide says you are in the circle while the
    // gate says move closer" failure.
    const rule = html.match(/\.camera-modal video \{[\s\S]*?\}/)?.[0] ?? '';
    expect(rule).toMatch(/aspect-ratio:\s*1\s*\/\s*1/);
    expect(rule).toMatch(/object-fit:\s*cover/);
    // A max-width clamp would win over aspect-ratio on a narrow window and crop
    // to a non-square box, silently reintroducing the mismatch. Match the
    // DECLARATIONS only — the comment beside them explains the trap by name.
    const desktop = html.match(/@media \(min-width: 641px\) \{[\s\S]*?\.camera-modal video \{([^}]*)\}/)?.[1] ?? '';
    expect(desktop).toBeTruthy();
    expect(desktop).not.toMatch(/max-width/);
  });

  it('scales the depth ring about its own box, not a view-box point', () => {
    // A `transform-box: view-box` origin is measured from the viewBox's min-x,
    // which the square window moves to 25 — so a hard-coded `100px 74px` origin
    // slides off the ring's centre and the depth readout drifts as it scales.
    const rule = html.match(/\.cg-depth-oval \{[\s\S]*?\}/)?.[0] ?? '';
    expect(rule).toMatch(/transform-box:\s*fill-box/);
    expect(rule).not.toMatch(/transform-box:\s*view-box/);
  });
});
