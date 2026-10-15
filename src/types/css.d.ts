import 'react';

declare module 'react' {
  // Allow the sketch-kit custom properties (--fill, --sx, ...) in style props.
  // eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style -- must be an interface to merge
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
