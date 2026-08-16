/**
 * An illustration slot.
 *
 * Renders the image at its intended dimensions, over a hatched placeholder
 * showing the file name and size. When the artwork is missing, the browser
 * fails to paint the image and the placeholder shows through — so the layout
 * is right while the art is being produced, and a missing file is visible
 * rather than a silent gap.
 *
 * No onError handler, deliberately: that is a client function, and passing one
 * from a server component makes the build hang trying to serialise it.
 *
 * The name matches a prompt in docs/ILLUSTRATION-PROMPTS.md.
 */
export function Illustration({
  name,
  alt,
  width,
  height,
  priority = false,
  className,
}: {
  name: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`illus ${className ?? ''}`}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <span className="illus-ph" aria-hidden="true">
        <b>{name}</b>
        <i>
          {width} × {height}
        </i>
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/illustrations/${name}.png`}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? 'eager' : 'lazy'}
      />
    </div>
  );
}
