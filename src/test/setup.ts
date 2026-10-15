import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { getPageHeadline, resetPageHeadline } from '../lib/pageHeadline';

/** Wednesday 14 Oct 2026, 19:00 local: a weekday dinner. */
export const WEEKDAY_DINNER = new Date(2026, 9, 14, 19, 0);

beforeEach(() => {
  // Pin the time-of-day headline so page tests are deterministic:
  // dinner, first variant = "what are we eating tonight?", mode near.
  resetPageHeadline();
  getPageHeadline(
    () => WEEKDAY_DINNER,
    () => 0,
  );
});

afterEach(() => {
  cleanup();
  resetPageHeadline();
});
