export type ShareResult = 'shared' | 'copied' | 'copyFailed' | null;

/**
 * Web Share where there is one (phones), else the clipboard. Never throws.
 * null: they closed the share sheet (nothing to say).
 */
export async function shareOrCopy(
  url: string,
  title: string,
  text: string,
  { share = true }: { share?: boolean } = {},
): Promise<ShareResult> {
  if (share && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (e) {
      // they closed the sheet: nothing to say
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      // NotAllowedError (the tap's activation ran out) etc.: copy instead
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'copyFailed';
  }
}
