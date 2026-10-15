import { hashSeed, parseCorner, wobblyPath, type Radii } from './inkPath';

/**
 * One shared ResizeObserver redraws every <Ink> outline when its element
 * changes size. Drawing is a few path strings: no filters, no per-frame
 * work when nothing changes.
 */
const seeds = new WeakMap<SVGSVGElement, number>();
let observer: ResizeObserver | null = null;

function draw(svg: SVGSVGElement, w: number, h: number) {
  const host = svg.parentElement;
  if (!host) return;
  const cs = getComputedStyle(host);
  const radii: Radii = [
    parseCorner(cs.borderTopLeftRadius, w, h),
    parseCorner(cs.borderTopRightRadius, w, h),
    parseCorner(cs.borderBottomRightRadius, w, h),
    parseCorner(cs.borderBottomLeftRadius, w, h),
  ];
  const bw = parseFloat(cs.getPropertyValue('--bw')) || 2.5;
  const seed = seeds.get(svg) ?? 1;
  const body = wobblyPath(w, h, radii, seed, bw / 2);
  const flat = host.classList.contains('flat');
  for (const path of svg.querySelectorAll<SVGPathElement>('[data-ink]')) {
    const kind = path.dataset.ink;
    if (kind === 'shadow' && flat) continue; // hidden anyway
    // shadow + boil frames get their own seeds, like the mockup's wob2/wob3
    const d =
      kind === 'shadow'
        ? wobblyPath(w, h, radii, seed + 7)
        : kind === 'b'
          ? wobblyPath(w, h, radii, seed + 13, bw / 2)
          : kind === 'c'
            ? wobblyPath(w, h, radii, seed + 29, bw / 2)
            : body;
    path.setAttribute('d', d);
  }
}

function getObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null;
  observer ??= new ResizeObserver((entries) => {
    for (const e of entries) {
      const box = e.borderBoxSize[0];
      const w = box ? box.inlineSize : e.contentRect.width;
      const h = box ? box.blockSize : e.contentRect.height;
      draw(e.target as SVGSVGElement, w, h);
    }
  });
  return observer;
}

export function watchInk(svg: SVGSVGElement, id: string): () => void {
  seeds.set(svg, hashSeed(id));
  const ro = getObserver();
  ro?.observe(svg, { box: 'border-box' });
  return () => {
    ro?.unobserve(svg);
  };
}
