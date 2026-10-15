export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** ISO-8601 UTC, the format every timestamp column uses. */
export const iso = (ms: number) => new Date(ms).toISOString();
