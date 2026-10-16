/**
 * What rides along in navigation state to /place/:id. Only ever used to
 * choose where "back" goes and in which order to show things; never to
 * decide what anyone may see (the server does that).
 */

/** Just added (`state.added`): say so once, on arrival. */
export function justAdded(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && 'added' in state && state.added === true);
}

/** Where "back" goes: `state.back`, else the list. Same-app paths only. */
export function backTarget(state: unknown): string {
  if (
    state &&
    typeof state === 'object' &&
    'back' in state &&
    typeof state.back === 'string' &&
    state.back.startsWith('/') &&
    !state.back.startsWith('//')
  ) {
    return state.back;
  }
  return '/';
}

/** The friend whose list you came from (`state.friend`), to show their take first. */
export function fromFriend(state: unknown): string | undefined {
  if (state && typeof state === 'object' && 'friend' in state && typeof state.friend === 'string')
    return state.friend;
  return undefined;
}

/** Highlight the last word (or last two, for long names): "Lucky Thread [Noodle Bar]". */
export function splitName(name: string): [string, string] {
  const words = name.split(' ');
  const n = words.length >= 3 ? 2 : 1;
  return [words.slice(0, -n).join(' '), words.slice(-n).join(' ')];
}
