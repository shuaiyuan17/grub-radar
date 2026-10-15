import { SpotOpError } from '../domain/edits';
import type { Messages } from '../i18n/messages';
import { ApiRequestError } from './api';

/** A failed save, in the reader's language (the server's code picks the copy). */
export function saveErrorMessage(e: unknown, t: Messages): string {
  const code = e instanceof ApiRequestError || e instanceof SpotOpError ? e.code : 'unknown';
  return code in t.apiErrors
    ? t.apiErrors[code as keyof Messages['apiErrors']]
    : t.apiErrors.unknown;
}
