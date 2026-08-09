/**
 * Charts, drawn as SVG by hand.
 *
 * No charting library on purpose. The three shapes this dashboard needs are a
 * smoothed sparkline, a segmented donut and a stacked bar, and each is a few
 * lines of path maths. A library would add 40kb to every page load, impose its
 * own visual language, and still need overriding to match the design.
 *
 * These are pure functions returning strings, so they render on the server
 * with no client JavaScript at all.
 */

/** Catmull-Rom-ish smoothing: control points at the horizontal midpoint. */
export function sparkline(
  values: number[],
  w = 460,
  h = 54,
  colour = '#8B7BF5',
  id = 's'
): string {
  if (values.length < 2) return '';
  const pad = 4;
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const range = mx - mn || 1;
  const x = (i: number) => pad + i * ((w - pad * 2) / (values.length - 1));
  const y = (n: number) => h - pad - ((n - mn) / range) * (h - pad * 2);

  let d = `M${x(0).toFixed(1)} ${y(values[0]).toFixed(1)}`;
  for (let i = 1; i < values.length; i++) {
    const px = x(i - 1);
    const py = y(values[i - 1]);
    const cx = x(i);
    const cy = y(values[i]);
    const mid = (px + cx) / 2;
    d += ` C${mid.toFixed(1)} ${py.toFixed(1)} ${mid.toFixed(1)} ${cy.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)}`;
  }

  const lastX = x(values.length - 1).toFixed(1);
  const lastY = y(values[values.length - 1]).toFixed(1);

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;height:${h}px">
    <defs><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${colour}" stop-opacity=".34"/>
      <stop offset="100%" stop-color="${colour}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${d} L${w - pad} ${h} L${pad} ${h} Z" fill="url(#g${id})"/>
    <path d="${d}" fill="none" stroke="${colour}" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"
      stroke-dasharray="1400" stroke-dashoffset="1400"
      style="animation:draw 1.4s cubic-bezier(.3,.8,.4,1) .25s forwards"/>
    <circle cx="${lastX}" cy="${lastY}" r="3.4" fill="${colour}" opacity="0"
      style="animation:pop .3s ease 1.5s forwards"/>
  </svg>`;
}

/**
 * Segmented ring. Segments fade in one after another rather than all at once,
 * so the eye follows the breakdown instead of being handed a finished picture.
 */
export function donut(
  segments: { value: number; colour: string }[],
  size = 178
): string {
  const r = size / 2 - 11;
  const C = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let offset = 0;

  const arcs = segments
    .map((s, i) => {
      const len = (s.value / total) * C;
      // A 2.5px gap between segments, so adjacent colours stay distinguishable.
      const dash = `${Math.max(0, len - 2.5)} ${C - Math.max(0, len - 2.5)}`;
      const el = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
        stroke="${s.colour}" stroke-width="13" stroke-linecap="round"
        stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 ${size / 2} ${size / 2})" opacity="0"
        style="animation:fadeIn .5s ease ${(0.35 + i * 0.11).toFixed(2)}s forwards"/>`;
      offset += len;
      return el;
    })
    .join('');

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
      stroke="rgba(255,255,255,.07)" stroke-width="13"/>${arcs}</svg>`;
}
