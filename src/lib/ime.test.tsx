import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useImperativeHandle, useState } from 'react';
import type { MeResponse } from '../contracts/me';
import { fakePhotosClient, renderAt, TEST_ME } from '../test/render';
import { compose, composeStep, ENDS, ORDERS, PINYIN } from '../test/ime';
import { useImeSafeInput } from './ime';

/**
 * The box backed by an outside value it commits to, like ?q= in the URL.
 * `echo(v)` delivers a value as if our own write came back (late, out of
 * order: whatever the test says); `reset(v)` is a change made elsewhere.
 */
interface Outside {
  echo: (v: string) => void;
  reset: (v: string) => void;
}
const outside = createRef<Outside>();
function Backed({ onCommit }: { onCommit: (q: string) => void }) {
  const [value, setValue] = useState('');
  const [resetKey, setResetKey] = useState(0);
  useImperativeHandle(outside, () => ({
    echo: setValue,
    reset: (v) => {
      setValue(v);
      setResetKey((k) => k + 1);
    },
  }));
  const box = useImeSafeInput({ value, resetKey, onCommit });
  return <input aria-label="box" {...box.inputProps} />;
}

const box = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'box' });

describe('useImeSafeInput', () => {
  it.each(ORDERS)(
    '%s order: shows the pinyin while composing, commits nothing until compositionend, then 包子 once',
    (browser) => {
      const onCommit = vi.fn();
      render(<Backed onCommit={onCommit} />);
      const el = box();
      fireEvent.compositionStart(el, { data: '' });
      for (const s of PINYIN) {
        composeStep(el, s);
        // the box shows exactly what the IME has: no Latin letters piling up
        expect(el).toHaveValue(s);
        expect(onCommit).not.toHaveBeenCalled();
      }
      ENDS[browser](el, '包子');
      expect(el).toHaveValue('包子');
      expect(onCommit.mock.calls).toEqual([['包子']]);
    },
  );

  it('typing after a pick goes on from the pick', () => {
    const onCommit = vi.fn();
    render(<Backed onCommit={onCommit} />);
    const el = box();
    compose('Safari', el);
    fireEvent.input(el, { target: { value: '包子铺' } });
    expect(el).toHaveValue('包子铺');
    expect(onCommit.mock.calls).toEqual([['包子'], ['包子铺']]);
  });

  it('Latin typing commits every change', () => {
    const onCommit = vi.fn();
    render(<Backed onCommit={onCommit} />);
    for (const v of ['p', 'ph', 'pho']) fireEvent.input(box(), { target: { value: v } });
    expect(onCommit.mock.calls).toEqual([['p'], ['ph'], ['pho']]);
  });

  it('echoes of its own writes never touch the box: repeated values, early and out of order', () => {
    const onCommit = vi.fn();
    render(<Backed onCommit={onCommit} />);
    // commits "a", "", "a": a pending sequence with a repeated value
    for (const v of ['a', '', 'a']) fireEvent.input(box(), { target: { value: v } });
    expect(onCommit.mock.calls).toEqual([['a'], [''], ['a']]);
    // the first "a" echoes early, then "", then the last "a"
    for (const v of ['a', '', 'a']) {
      act(() => {
        outside.current?.echo(v);
      });
      expect(box()).toHaveValue('a');
    }
    // and a stale one long after you typed on
    fireEvent.input(box(), { target: { value: 'ab' } });
    act(() => {
      outside.current?.echo('');
    });
    expect(box()).toHaveValue('ab');
  });

  it('follows a change made elsewhere (back, a clear), but not mid-composition', () => {
    render(<Backed onCommit={vi.fn()} />);
    fireEvent.input(box(), { target: { value: 'pho' } });
    act(() => {
      outside.current?.reset('');
    });
    expect(box()).toHaveValue('');
    fireEvent.compositionStart(box(), { data: '' });
    composeStep(box(), 'bao');
    act(() => {
      outside.current?.reset('noodle');
    });
    expect(box()).toHaveValue('bao');
  });
});

describe('Enter that picks an IME candidate never submits', () => {
  const UNNAMED: MeResponse = {
    ...TEST_ME,
    user: { id: 'u_new', displayName: 'you', avatarEmoji: '🍜', nameSet: false },
  };

  /** Every single-line text field inside a <form> on screen. */
  const formFields = () =>
    [...document.querySelectorAll('form input')].filter(
      (el): el is HTMLInputElement =>
        el instanceof HTMLInputElement && ['text', 'search'].includes(el.type) && !el.readOnly,
    );

  const cases: [string, () => Promise<void>][] = [
    [
      'add search',
      async () => {
        renderAt('/add');
        await screen.findByRole('searchbox', { name: /Apple Maps/ });
      },
    ],
    [
      'manual add',
      async () => {
        renderAt('/add/manual');
        await screen.findByLabelText('name');
      },
    ],
    [
      'edit form',
      async () => {
        renderAt('/place/lucky-thread/edit');
        await screen.findByLabelText('name');
      },
    ],
    [
      'dishes',
      async () => {
        renderAt('/place/lucky-thread');
        await screen.findByLabelText('add a dish');
      },
    ],
    [
      'name prompt',
      async () => {
        renderAt('/', { auth: { status: 'signed-in', me: UNNAMED } });
        await screen.findByRole('dialog', { name: 'what should we call you?' });
      },
    ],
    [
      'profile',
      async () => {
        renderAt('/friends');
        await screen.findByLabelText(/your name|name/);
      },
    ],
    [
      'token name',
      async () => {
        renderAt('/settings');
        await screen.findByLabelText('name it (it shows as “found by …”)');
      },
    ],
    [
      'home coords',
      async () => {
        const { user } = renderAt('/');
        await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
        await screen.findByLabelText('or type it as lat, lng');
      },
    ],
    [
      'photo caption',
      async () => {
        const photos = fakePhotosClient({
          'lucky-thread': {
            mine: [
              {
                id: `ph_${'1'.padStart(26, '0')}`,
                width: 1600,
                height: 1200,
                bytes: 1000,
                createdAt: '2026-10-15T12:00:00.000Z',
                url: `/api/photos/ph_${'1'.padStart(26, '0')}`,
              },
            ],
          },
        });
        const { user } = renderAt('/place/lucky-thread', { photos });
        await user.click(await screen.findByRole('button', { name: /view larger/ }));
        await within(screen.getByRole('dialog')).findByLabelText('caption');
      },
    ],
  ];

  it.each(cases)('%s', async (_, open) => {
    await open();
    const fields = formFields();
    expect(fields.length).toBeGreaterThan(0);
    for (const el of fields) {
      // fireEvent returns false when the keydown was cancelled (no implicit submit)
      expect(fireEvent.keyDown(el, { key: 'Enter', isComposing: true }), el.outerHTML).toBe(false);
      // Safari: compositionend already fired, the keydown says 229
      expect(fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 }), el.outerHTML).toBe(false);
      // a real Enter still submits
      expect(fireEvent.keyDown(el, { key: 'Enter', keyCode: 13 }), el.outerHTML).toBe(true);
    }
  });

  it('a new line in a note is still a new line', async () => {
    renderAt('/place/lucky-thread');
    const note = await screen.findByLabelText('New note');
    await waitFor(() => {
      expect(note).toBeInTheDocument();
    });
    act(() => {
      note.focus();
    });
    expect(fireEvent.keyDown(note, { key: 'Enter', keyCode: 229 })).toBe(true);
  });
});
