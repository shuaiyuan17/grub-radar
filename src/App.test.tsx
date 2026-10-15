import { render, screen } from '@testing-library/react';
import { SEED_SPOTS } from './data/seed';
import { App } from './App';
import { TEST_ME } from './test/render';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('page load', () => {
  it('asks "who am I" and "my spots" at the same time, not one after the other', async () => {
    const asked: string[] = [];
    let answerMe!: () => void;
    const meAnswered = new Promise<void>((resolve) => {
      answerMe = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        asked.push(path);
        if (path === '/api/me') {
          await meAnswered;
          return Response.json(TEST_ME);
        }
        if (path === '/api/spots') return Response.json(SEED_SPOTS);
        return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 });
      }),
    );
    render(<App />);
    // the shell's first line is there at once
    expect(screen.getByText('checking who you are…')).toBeInTheDocument();
    // /api/spots went out while /api/me is still unanswered
    await vi.waitFor(() => {
      expect(asked).toEqual(expect.arrayContaining(['/api/me', '/api/spots']));
    });
    answerMe();
    expect(await screen.findAllByRole('article')).not.toHaveLength(0);
    // and the list was not fetched a second time
    expect(asked.filter((p) => p === '/api/spots')).toHaveLength(1);
  });
});
