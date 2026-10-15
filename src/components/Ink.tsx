import { useId, useLayoutEffect, useRef } from 'react';
import { watchInk } from '../lib/ink';

/**
 * The hand-drawn border + ink shadow of a `.sk` element. Put it as the first
 * child of anything with className "sk". Colours and offsets come from the
 * same CSS knobs as before (--fill --bw --dash --sh --sx --sy); `.flat`
 * hides the shadow. Pass `boil` (with the `.boil` class on the host) to get
 * the two extra outlines it swaps between on hover/focus.
 */
export function Ink({ boil = false }: { boil?: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const svg = ref.current;
    return svg ? watchInk(svg, id) : undefined;
  }, [id]);
  return (
    <svg ref={ref} className="ink" aria-hidden="true" focusable="false">
      <path data-ink="shadow" className="ink-shadow" />
      <path data-ink="a" className="ink-body ink-a" />
      {boil && (
        <>
          <path data-ink="b" className="ink-body ink-b" />
          <path data-ink="c" className="ink-body ink-c" />
        </>
      )}
    </svg>
  );
}
