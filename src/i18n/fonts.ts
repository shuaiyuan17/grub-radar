/**
 * Chinese display fonts, self-hosted via Fontsource. Their CSS splits each
 * font into ~90 unicode-range slices, so the browser downloads only the
 * slices that contain characters actually on screen. Loaded on demand the
 * first time zh is active, so English visitors never fetch them.
 */
let loading: Promise<unknown> | null = null;

export function loadZhFonts(): Promise<unknown> {
  loading ??= Promise.all([
    import('@fontsource/zcool-kuaile/400.css'), // headlines (站酷快乐体)
    import('@fontsource/long-cang/400.css'), // handwritten notes (龙藏体)
  ]);
  return loading;
}
