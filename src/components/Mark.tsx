/**
 * The Nothing Missing mark: a lowercase n and m, with an open crate between
 * them whose lid reads as a tick.
 *
 * SVG rather than a PNG so it stays crisp at 26px in a sidebar and at 200px on
 * a waybill, and so it can carry a tenant's own colour where that is wanted.
 * The raster versions in /public/brand are for email, which cannot be trusted
 * with inline SVG.
 */
export function Mark({
  size = 32,
  navy = '#061F3E',
  blue = '#0551BD',
  face = '#085ED5',
  onDark = false,
  title,
}: {
  size?: number;
  navy?: string;
  blue?: string;
  face?: string;
  onDark?: boolean;
  title?: string;
}) {
  // On a dark surface the n has to lift off the background, and the tick's
  // knockout has to match what is behind it rather than being white.
  const stem = onDark ? '#FFFFFF' : navy;
  const crate = onDark ? '#FFFFFF' : navy;
  const knockout = onDark ? 'var(--ink, #101223)' : '#FFFFFF';

  return (
    <svg
      width={(size * 72) / 56}
      height={size}
      viewBox="0 0 72 56"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      style={{ display: 'block', flex: 'none', overflow: 'visible' }}
    >
      {title && <title>{title}</title>}

      {/* n */}
      <path d="M3 52V16h7v36H3Z" fill={stem} />
      <path d="M10 15.6c8.6 0 14.6 6 14.6 14.4V52h-7V30c0-4.6-3.2-7.6-7.6-7.6v-6.8Z" fill={stem} />

      {/* m */}
      <path
        d="M47.4 52V30c0-4.6 3.2-7.6 7.6-7.6s7.6 3 7.6 7.6v22h7V30c0-8.4-6-14.4-14.6-14.4S40.4 21.6 40.4 30v22h7Z"
        fill={blue}
      />
      <path d="M40.4 52V16h-7v36h7Z" fill={blue} />

      {/* the crate, two faces meeting at the centre line */}
      <path d="M33.5 40 24 34.5V45l9.5 5.5V40Z" fill={crate} />
      <path d="M33.5 40 43 34.5V45l-9.5 5.5V40Z" fill={face} />

      {/* the lid, opening upward as a tick */}
      <path
        d="M24 33.2 33.5 38.6 43 27"
        stroke={knockout}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M24 32.6 33.5 38 43 26.4"
        stroke={blue}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/** Mark plus wordmark, for sign-in, marketing and documents. */
export function Wordmark({
  size = 26,
  navy = '#061F3E',
  blue = '#0551BD',
  onDark = false,
  tagline = false,
}: {
  size?: number;
  navy?: string;
  blue?: string;
  onDark?: boolean;
  tagline?: boolean;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.4 }}>
      <Mark size={size * 1.5} navy={navy} blue={blue} onDark={onDark} title="Nothing Missing" />
      <span style={{ display: 'grid', gap: 3 }}>
        <span
          style={{
            fontFamily: 'var(--display)',
            fontWeight: 800,
            fontSize: size,
            letterSpacing: '-.04em',
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: onDark ? '#fff' : navy }}>nothing</span>{' '}
          <span style={{ color: onDark ? '#5B9BF0' : blue }}>missing</span>
        </span>
        {tagline && (
          <span
            style={{
              fontSize: size * 0.32,
              letterSpacing: '.15em',
              textTransform: 'uppercase',
              color: onDark ? '#7A7F9E' : 'var(--text-3)',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            Asset &amp; inventory management
          </span>
        )}
      </span>
    </span>
  );
}
