/**
 * The SVG turbulence filters every .sk element references. Rendered once at
 * the app root. Three seeds: wob (border), wob2 (shadow), wob3 (boil frame).
 */
export function SketchFilters({ wobble = 3 }: { wobble?: number }) {
  const seeds = [
    ['wob', 2],
    ['wob2', 9],
    ['wob3', 17],
  ] as const;
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        {seeds.map(([id, seed]) => (
          <filter key={id} id={id} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves={2} seed={seed} />
            <feDisplacementMap in="SourceGraphic" scale={wobble} />
          </filter>
        ))}
      </defs>
    </svg>
  );
}
