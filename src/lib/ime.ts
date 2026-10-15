import {
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
} from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router';

/**
 * IME composition (Chinese pinyin, Japanese, Korean...): while you type
 * "bao zi", the box holds marked text the IME hasn't committed yet. Anything
 * that disturbs the input mid-composition (a router navigation, a value reset,
 * a moved caret) makes Safari commit the marked text as it stands, so each
 * keystroke lands as Latin letters: "bbabaobao zbao zi".
 *
 * Event order differs. Chrome: input events (isComposing), then compositionend.
 * Safari: compositionend, then the final input event (isComposing false). Both
 * are handled: the box always shows what you type, and `onCommit` gets the text
 * only when it's settled (no composition), once per distinct value.
 */

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Navigation state that marks a URL write as the box's own (see useExternalNavKey). */
export const TYPED_NAV_STATE = { typedInBox: true } as const;

const isTyped = (state: unknown) =>
  typeof state === 'object' && state !== null && 'typedInBox' in state;

/**
 * A key that changes only on navigations a text box didn't make itself:
 * back/forward, links, other controls. Writes made with TYPED_NAV_STATE
 * (the box's own ?q=) don't count, so a late one can't reset what's typed.
 */
export function useExternalNavKey(): string {
  const location = useLocation();
  const type = useNavigationType();
  const [key, setKey] = useState(location.key);
  const [seen, setSeen] = useState(location.key);
  if (location.key !== seen) {
    setSeen(location.key);
    if (type === NavigationType.Pop || !isTyped(location.state)) setKey(location.key);
  }
  return key;
}

/** keyCode 229: "the IME is handling this key" (Safari sends it for the confirming Enter). */
const IME_KEY_CODE = 229;

/** Is this keydown part of an IME composition (picking a candidate, not a real Enter)? */
export function isImeKeyDown(e: KeyboardEvent): boolean {
  // keyCode is deprecated but it is the only signal Safari gives: it ends the
  // composition before the confirming Enter's keydown, so isComposing is false
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return e.nativeEvent.isComposing || e.keyCode === IME_KEY_CODE;
}

/**
 * onKeyDown for a form (or an input in one): Enter that picks an IME
 * candidate must not submit. preventDefault on that keydown stops the
 * browser's implicit submission; textareas are left alone (Enter there is a
 * new line, never a submit).
 */
export function preventImeEnter(e: KeyboardEvent): void {
  if (e.key !== 'Enter' && e.key !== 'Process') return;
  if (e.target instanceof HTMLTextAreaElement) return;
  if (isImeKeyDown(e)) e.preventDefault();
}

export interface ImeSafeInput {
  /** What the box shows, composing text included. */
  draft: string;
  /** True between compositionstart and compositionend. */
  composing: boolean;
  /** Spread onto the <input>/<textarea>. */
  inputProps: {
    value: string;
    onChange: (e: ChangeEvent<TextField>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (e: CompositionEvent<TextField>) => void;
    onKeyDown: (e: KeyboardEvent<TextField>) => void;
  };
}

/**
 * A text box whose changes have side effects (a URL param, a search): the
 * box owns what's typed; `onCommit` hears only settled text.
 *
 * The box is the single source of truth while it's mounted. `value` is read
 * on mount, and again only when `resetKey` changes: the owner bumps it when
 * something other than this box changed the value (back/forward, a "clear"
 * link). Echoes of the box's own writes, however late or out of order, never
 * touch what's typed: there is nothing to match them against.
 */
export function useImeSafeInput({
  value,
  resetKey,
  onCommit,
}: {
  value: string;
  resetKey?: unknown;
  onCommit: (text: string) => void;
}): ImeSafeInput {
  const [draft, setDraft] = useState(value);
  const [composing, setComposing] = useState(false);
  const [seenKey, setSeenKey] = useState(resetKey);
  // handlers read these synchronously: Safari's compositionend and its final
  // input event arrive back to back, before React re-renders
  const composingRef = useRef(false);
  const endedWith = useRef<string | null>(null);

  // an outside change: follow it (not mid-composition: you're typing)
  if (resetKey !== seenKey) {
    setSeenKey(resetKey);
    if (!composing) setDraft(value);
  }

  return {
    draft,
    composing,
    inputProps: {
      value: draft,
      onChange: (e) => {
        const text = e.target.value;
        setDraft(text);
        // Chrome: still composing (compositionend comes next and commits)
        if (composingRef.current || (e.nativeEvent as InputEvent).isComposing) return;
        // Safari: the input event right after compositionend, already committed
        const ended = endedWith.current;
        endedWith.current = null;
        if (ended === text) return;
        onCommit(text);
      },
      onCompositionStart: () => {
        composingRef.current = true;
        setComposing(true);
      },
      onCompositionEnd: (e) => {
        composingRef.current = false;
        setComposing(false);
        // the DOM already holds the final text in both orders; Safari's input
        // event that follows sees it committed and does nothing more
        const text = e.currentTarget.value;
        endedWith.current = text;
        setDraft(text);
        onCommit(text);
      },
      onKeyDown: preventImeEnter,
    },
  };
}
