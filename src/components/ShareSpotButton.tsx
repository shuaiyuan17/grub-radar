import { useEffect, useState } from 'react';
import type { Spot } from '../domain/spot';
import { useT } from '../i18n/context';
import { shareOrCopy, type ShareResult } from '../lib/share';
import { SpotLabel } from './bits';
import { Icon } from './Icon';
import { Ink } from './Ink';
import styles from './ShareSpotButton.module.css';

const NOTE_MS = 6000;

/**
 * "share" on your own spot's page: the share sheet where there is one, else
 * the link copied. The link is just /place/:id: a friend who opens it sees
 * the place and your take (if you share it with friends); anyone else, the
 * place only; nobody signed out sees anything.
 */
export function ShareSpotButton({ spot }: { spot: Pick<Spot, 'id' | 'name' | 'lang'> }) {
  const t = useT();
  const [result, setResult] = useState<ShareResult>(null);
  // the note floats over the page: it goes away on its own
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => {
      setResult(null);
    }, NOTE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [result]);
  const share = async () => {
    setResult(null);
    const url = `${window.location.origin}/place/${encodeURIComponent(spot.id)}`;
    setResult(await shareOrCopy(url, t.shareSpot.title, t.shareSpot.text(spot.name)));
  };
  return (
    <>
      <button
        type="button"
        className={`sk press ${styles.share}`}
        onClick={() => void share()}
        aria-labelledby="share-label"
      >
        <SpotLabel id="share-label" parts={t.shareSpot.aria} spot={spot} />
        <Ink />
        <Icon name="share" size={20} strokeWidth={2.4} />
        <span className={styles.label}>{t.shareSpot.button}</span>
      </button>
      <p role="status" className={`note ${styles.result}`}>
        {result && t.shareSpot[result]}
      </p>
    </>
  );
}
