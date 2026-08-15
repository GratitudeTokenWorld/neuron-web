/**
 * The capture frame: one square, identical on every device.
 *
 * The problem this solves. Framing was measured as eye-span over the frame's
 * WIDTH — but width is the LONG side of a laptop's 4:3 feed and the SHORT side
 * of a phone's portrait one, so a single pair of thresholds described two
 * different framings. On landscape a face at the top of the band nearly filled
 * the frame's height; on portrait it filled about half of it, pushing the phone
 * user unnecessarily far from the camera. The guide, faithfully drawn to that
 * band, looked tiny on a phone. Compensating per-orientation would have meant
 * two sets of numbers to keep in step.
 *
 * Instead the frame itself is made constant: everything — the visible feed, the
 * guide, and every framing metric — is expressed against the **centred square
 * crop**, whose side is the shorter of the two stream dimensions. A 640x480
 * webcam and a 480x640 phone then present the same 480x480 capture surface, and
 * one set of thresholds means one thing everywhere.
 *
 * Crucially the crop is applied to the DISPLAY and the METRICS together, so
 * there is no display/detection mismatch — the failure this file's predecessor
 * warned about, where a cropped view reads as well-framed on screen while the
 * gate still says "move closer". Detection itself still runs on the full frame
 * (so a second face just outside the visible square is still caught and still
 * aborts the capture); only the framing REFERENCE is the square.
 */

/**
 * The guide art canvas. Authored as 200x150 for a 4:3 frame, where the 150-unit
 * height mapped to the 480px short side — which is exactly the square's side. So
 * the square view is the same art with the viewBox cropped to 150x150 about the
 * face axis (x=100): no artwork changes, and every cue stays inside it.
 */
export const GUIDE_ART_W = 200;
export const GUIDE_ART_H = 150;

/**
 * The constant `viewBox`: a 150x150 window centred on the art's face axis.
 *
 * Constant is the whole point — it does not depend on the stream, so there is no
 * per-stream fitting step to get wrong and nothing to recompute on rotate. The
 * extremes still fit: the oval spans x 56-144, and the turn chevrons reach x=28
 * (and x=172 mirrored) against bounds of 25 and 175.
 */
export const GUIDE_VIEWBOX = '25 0 150 150';

/** Side of the centred square crop: the shorter stream dimension. */
export function squareSide(videoW: number, videoH: number): number {
  if (!videoW || !videoH) return 480;      // sane default before metadata lands
  return Math.min(videoW, videoH);
}

/** Left edge of the centred square crop, in full-frame pixels. */
export function squareOriginX(videoW: number, videoH: number): number {
  if (!videoW || !videoH) return 0;
  return (videoW - squareSide(videoW, videoH)) / 2;
}

/** Top edge of the centred square crop, in full-frame pixels. */
export function squareOriginY(videoW: number, videoH: number): number {
  if (!videoW || !videoH) return 0;
  return (videoH - squareSide(videoW, videoH)) / 2;
}
