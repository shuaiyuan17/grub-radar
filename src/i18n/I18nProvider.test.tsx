import { screen, within } from '@testing-library/react';
import { renderAt } from '../test/render';
import { LANG_KEY } from './storage';

vi.mock('./fonts', () => ({ loadZhFonts: vi.fn(() => Promise.resolve()) }));
const { loadZhFonts } = await import('./fonts');

function setBrowserLanguages(langs: string[]) {
  Object.defineProperty(navigator, 'languages', { configurable: true, value: langs });
  Object.defineProperty(navigator, 'language', { configurable: true, value: langs[0] ?? '' });
}

describe('language', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(loadZhFonts).mockClear();
    setBrowserLanguages(['en-US']);
  });

  it('defaults from navigator.language and sets <html lang>', async () => {
    setBrowserLanguages(['zh-CN', 'en']);
    renderAt('/');
    expect(await screen.findByRole('button', { name: '附近' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('zh-Hans');
    expect(loadZhFonts).toHaveBeenCalled();
  });

  it('english browsers get english, and no zh fonts', async () => {
    renderAt('/');
    expect(await screen.findByRole('button', { name: 'near me' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    expect(loadZhFonts).not.toHaveBeenCalled();
  });

  it('the toggle switches everything and the choice persists', async () => {
    const { user, unmount } = renderAt('/');
    const group = (await screen.findAllByRole('group', { name: 'Language' }))[0]!;
    await user.click(within(group).getByRole('button', { name: '中文' }));

    expect(localStorage.getItem(LANG_KEY)).toBe('zh-Hans');
    expect(document.documentElement.lang).toBe('zh-Hans');
    expect(loadZhFonts).toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('今晚吃点啥？');
    expect(screen.getByRole('button', { name: '附近' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('group', { name: '想吃' })).toHaveTextContent('辣');
    expect(screen.getByText('5 家 · 由近到远')).toBeInTheDocument();
    // units + spot data: names stay as data
    const card = screen.getAllByRole('article')[0]!;
    expect(card).toHaveTextContent('Lucky Thread Noodle Bar');
    expect(within(card).getByText('8 分钟')).toBeInTheDocument();
    expect(within(card).getByText('步行')).toBeInTheDocument();
    expect(
      within(card).getByRole('link', { name: /带我去 Lucky Thread Noodle Bar.*步行/ }),
    ).toBeInTheDocument();

    unmount();
    renderAt('/'); // a new visit
    expect(await screen.findByRole('button', { name: '附近' })).toBeInTheDocument();

    const group2 = screen.getAllByRole('group', { name: '语言' })[0]!;
    await user.click(within(group2).getByRole('button', { name: 'en' }));
    expect(localStorage.getItem(LANG_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('button', { name: 'near me' })).toBeInTheDocument();
  });

  it('a saved choice beats the browser language', async () => {
    localStorage.setItem(LANG_KEY, 'en');
    setBrowserLanguages(['zh-CN']);
    renderAt('/');
    expect(await screen.findByRole('button', { name: 'near me' })).toBeInTheDocument();
  });

  it('translates the radar, including dot names', async () => {
    localStorage.setItem(LANG_KEY, 'zh-Hans');
    renderAt('/radar?reach=0');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('这次跑多远？');
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '10 分钟');
    expect(screen.getByText('范围内 6 家')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Ondo Soup House，吃的，开车 8 分钟' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Hilltop Smokehouse.*超出范围/ }),
    ).toBeInTheDocument();
  });

  it('translates the place page', async () => {
    localStorage.setItem(LANG_KEY, 'zh-Hans');
    renderAt('/place/lucky-thread');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Lucky Thread Noodle Bar',
    );
    expect(screen.getByText('0.5 公里')).toBeInTheDocument();
    expect(screen.getByText('离家近')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '点这些' })).toHaveTextContent('下次');
    expect(screen.getByRole('link', { name: '回到列表' })).toBeInTheDocument();
    expect(screen.getByText(/由你的 agent 发现 · 2026年9月12日/)).toBeInTheDocument();
    expect(screen.getByText('22:00')).toBeInTheDocument(); // structured hours, zh format
  });

  it('marks english spot data with lang="en" inside the zh page', async () => {
    localStorage.setItem(LANG_KEY, 'zh-Hans');
    renderAt('/place/lucky-thread');
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).toHaveAttribute('lang', 'en');
    expect(screen.getByText('hand-pulled noodles')).toHaveAttribute('lang', 'en');
    expect(screen.getByText(/noodles pulled to order/)).toHaveAttribute('lang', 'en');
    expect(screen.getByText('cumin lamb biang biang')).toHaveAttribute('lang', 'en');
    // translated chrome stays in the page language
    expect(screen.getByText('离家近')).not.toHaveAttribute('lang');
    expect(screen.getByText('辣')).not.toHaveAttribute('lang');
  });

  it('marks data on list cards and the radar card too', async () => {
    localStorage.setItem(LANG_KEY, 'zh-Hans');
    const { unmount } = renderAt('/');
    const card = (await screen.findAllByRole('article'))[0]!;
    expect(within(card).getByRole('link', { name: 'Lucky Thread Noodle Bar' })).toHaveAttribute(
      'lang',
      'en',
    );
    expect(within(card).getByText('cumin lamb, extra chili. trust.')).toHaveAttribute('lang', 'en');
    unmount();
    renderAt('/radar?sel=hilltop-smokehouse');
    const radarCard = await screen.findByRole('article', { name: 'Hilltop Smokehouse' });
    expect(within(radarCard).getByText('saturday brisket sells out early')).toHaveAttribute(
      'lang',
      'en',
    );
  });

  it('shows english hours in english', async () => {
    renderAt('/place/two-fires');
    expect(await screen.findByText('midnight')).toBeInTheDocument();
  });
});
