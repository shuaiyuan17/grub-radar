import { fireEvent } from '@testing-library/react';

/**
 * How browsers deliver pinyin "bao zi" → 包子. Chrome: every keystroke is an
 * input event marked isComposing, the pick too, then compositionend. Safari:
 * compositionend comes first, then a final input event no longer composing.
 */
export const PINYIN = ['b', 'ba', 'bao', 'bao z', 'bao zi'];

export function composeStep(el: HTMLElement, s: string) {
  fireEvent.compositionUpdate(el, { data: s });
  fireEvent.input(el, {
    target: { value: s },
    isComposing: true,
    inputType: 'insertCompositionText',
  });
}

function nativeSetValue(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, value);
}

export const ENDS = {
  Chrome(el: HTMLElement, pick: string) {
    fireEvent.input(el, { target: { value: pick }, isComposing: true });
    fireEvent.compositionEnd(el, { data: pick });
  },
  Safari(el: HTMLElement, pick: string) {
    // the DOM holds the pick when compositionend fires (put there by the IME,
    // not by a script: so past React's own value tracking, as in Safari)
    nativeSetValue(el, pick);
    fireEvent.compositionEnd(el, { data: pick });
    fireEvent.input(el, { target: { value: pick }, isComposing: false });
  },
};
export const ORDERS = Object.keys(ENDS) as (keyof typeof ENDS)[];

/** Types `pick` through the IME the way `browser` delivers it. */
export function compose(browser: keyof typeof ENDS, el: HTMLElement, pick = '包子') {
  fireEvent.compositionStart(el, { data: '' });
  for (const s of PINYIN) composeStep(el, s);
  ENDS[browser](el, pick);
}
