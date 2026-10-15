import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { PHOTOS_PER_SPOT, type Photo } from '../contracts/photos';
import type { Spot } from '../domain/spot';
import { useT } from '../i18n/context';
import { saveErrorMessage } from '../lib/errors';
import { PhotoProcessError } from '../lib/photoProcess';
import { usePhotosClient } from '../lib/photos';
import type { PlacePhotosState } from '../lib/usePlacePhotos';
import { inputClass } from './fieldClasses';
import { InkBox, InkButton } from './fields';
import { Icon } from './Icon';
import { FOOD_ICONS } from './icons';
import { Ink } from './Ink';
import styles from './PlacePhotos.module.css';
import { preventImeEnter } from '../lib/ime';

/** A photo on its way up: a local preview (blob: URL) and how far along it is. */
interface Pending {
  key: string;
  preview: string | null;
  phase: 'preparing' | 'uploading';
  progress: number;
}

/**
 * The place page's photo frame: the first photo taped in (the mockup's
 * frame), a strip of all of them, and "add photo". Tap any photo for the big
 * view. Without photos (or before they load) it's the hand-drawn placeholder.
 */
export function PhotoFrame({
  spot,
  photos,
  canAdd,
}: {
  spot: Spot;
  photos: PlacePhotosState;
  canAdd: boolean;
}) {
  const t = useT();
  const client = usePhotosClient();
  const [pending, setPending] = useState<Pending[]>([]);
  const [status, setStatus] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const mine = photos.data?.mine ?? [];
  const busy = pending.length > 0;
  const room = PHOTOS_PER_SPOT - mine.length - pending.length;

  useEffect(
    () => () => {
      for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
    },
    // revoke whatever is still pending when the page goes away
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) return;
    const take = files.slice(0, Math.max(0, room));
    const problems: string[] = [];
    if (take.length < files.length) problems.push(t.photos.spotFull(PHOTOS_PER_SPOT));
    setErrors(problems);
    const queue: Pending[] = take.map((_, i) => ({
      key: `${String(Date.now())}-${String(i)}`,
      preview: null,
      phase: 'preparing',
      progress: 0,
    }));
    setPending(queue);
    const update = (key: string, patch: Partial<Pending>) => {
      setPending((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));
    };

    for (const [i, file] of take.entries()) {
      const item = queue[i];
      if (!item) continue;
      const n = i + 1;
      setStatus(t.photos.preparing(n, take.length));
      let preview: string | null = null;
      try {
        const prepared = await client.prepare(file);
        preview = URL.createObjectURL(prepared.blob);
        update(item.key, { preview, phase: 'uploading' });
        setStatus(t.photos.uploading(n, take.length, 0));
        const photo = await client.upload(spot.id, prepared, (fraction) => {
          const percent = Math.round(fraction * 100);
          update(item.key, { progress: fraction });
          setStatus(t.photos.uploading(n, take.length, percent));
        });
        photos.added(photo);
      } catch (err) {
        problems.push(
          err instanceof PhotoProcessError
            ? err.kind === 'too_big'
              ? t.photos.tooBig(file.name)
              : t.photos.unreadable(file.name)
            : saveErrorMessage(err, t),
        );
        setErrors([...problems]);
      } finally {
        if (preview) URL.revokeObjectURL(preview);
        setPending((list) => list.filter((p) => p.key !== item.key));
      }
    }
    setStatus('');
  };

  const hero = mine[0];
  return (
    <div className={styles.frameArea}>
      <div className={styles.photoWrap}>
        {hero ? (
          <button
            type="button"
            className={`sk ${styles.photo} ${styles.filled}`}
            onClick={() => {
              setViewing(0);
            }}
            aria-label={t.photos.open(1, mine.length)}
          >
            <Ink />
            <img
              className={styles.heroImg}
              src={hero.url}
              alt=""
              width={hero.width}
              height={hero.height}
              decoding="async"
            />
          </button>
        ) : (
          <div className={`sk ${styles.photo}`}>
            <Ink />
            <svg
              width="74"
              height="74"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ink)"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={FOOD_ICONS[spot.icon]} />
            </svg>
            <span className={styles.photoCaption}>{t.noPhoto}</span>
          </div>
        )}
        <span aria-hidden="true" className={`${styles.tape} ${styles.tapeL}`} />
        <span aria-hidden="true" className={`${styles.tape} ${styles.tapeR}`} />
      </div>

      {(mine.length > 0 || pending.length > 0 || canAdd) && (
        <div className={styles.strip} role="group" aria-label={t.photos.galleryLabel}>
          {mine.length > 1 && (
            // the first one is the big print in the frame; the rest, small prints
            <ul className={styles.thumbs}>
              {mine.slice(1).map((p, j) => (
                <li key={p.id} className={`enter ${styles.thumbItem}`} style={{ '--i': j }}>
                  <button
                    type="button"
                    className={`tap ${styles.thumb}`}
                    onClick={() => {
                      setViewing(j + 1);
                    }}
                    aria-label={t.photos.open(j + 2, mine.length)}
                  >
                    <img src={p.url} alt="" width={p.width} height={p.height} loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pending.map((p) => (
            <span key={p.key} className={styles.pending} aria-hidden="true">
              {p.preview && <img src={p.preview} alt="" />}
              <span className={styles.bar}>
                <span
                  className={styles.barFill}
                  style={{
                    transform: `scaleX(${String(p.phase === 'preparing' ? 0.04 : p.progress)})`,
                  }}
                />
              </span>
            </span>
          ))}
          {canAdd && room > 0 && (
            <label className={`sk press ${styles.add} ${busy ? styles.addBusy : ''}`}>
              <Ink />
              <Icon name="plus" size={18} strokeWidth={2.6} />
              <span aria-hidden="true">{mine.length ? t.photos.addMore : t.photos.add}</span>
              <input
                type="file"
                accept="image/*"
                multiple
                className="visually-hidden"
                aria-label={t.photos.pickerAria}
                disabled={busy}
                onChange={(e) => void onPick(e)}
              />
            </label>
          )}
        </div>
      )}
      <p className={styles.status} role="status" aria-live="polite">
        {status}
      </p>
      {errors.length > 0 && (
        <div role="alert" className={styles.errors}>
          {errors.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
      )}
      {canAdd && mine.length === 0 && !busy && <p className={styles.privacy}>{t.photos.privacy}</p>}

      {viewing !== null && mine.length > 0 && (
        <PhotoViewer
          photos={mine}
          start={Math.min(viewing, mine.length - 1)}
          onClose={() => {
            setViewing(null);
          }}
          owner={{
            removed: (id) => {
              photos.removed(id);
            },
            replaced: photos.replaced,
          }}
        />
      )}
    </div>
  );
}

/** A friend's photos under their take: small prints, tap for the big view. */
export function FriendPhotos({ name, photos }: { name: string; photos: readonly Photo[] }) {
  const t = useT();
  const [viewing, setViewing] = useState<number | null>(null);
  if (photos.length === 0) return null;
  return (
    <>
      <ul className={`${styles.thumbs} ${styles.friendThumbs}`}>
        {photos.map((p, i) => (
          <li key={p.id} className={`enter ${styles.thumbItem}`} style={{ '--i': i }}>
            <button
              type="button"
              className={`tap ${styles.thumb}`}
              onClick={() => {
                setViewing(i);
              }}
              aria-label={t.photos.friendOpen(name, i + 1, photos.length)}
            >
              <img src={p.url} alt="" width={p.width} height={p.height} loading="lazy" />
            </button>
          </li>
        ))}
      </ul>
      {viewing !== null && (
        <PhotoViewer
          photos={photos}
          start={viewing}
          who={name}
          onClose={() => {
            setViewing(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The big view, in a modal <dialog> (focus trapped, Esc closes). Owners can
 * caption or delete; a friend's photos are view-only.
 */
export function PhotoViewer({
  photos,
  start,
  who,
  onClose,
  owner,
}: {
  photos: readonly Photo[];
  start: number;
  who?: string;
  onClose: () => void;
  owner?: { removed: (id: string) => void; replaced: (p: Photo) => void };
}) {
  const t = useT();
  const client = usePhotosClient();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const captionId = useId();
  const [index, setIndex] = useState(start);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = photos[Math.min(index, photos.length - 1)];
  const [caption, setCaption] = useState(photo?.caption ?? '');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    return () => {
      if (typeof d.close === 'function' && d.open) d.close();
    };
  }, []);

  if (!photo) return null;
  const n = photos.length;
  const go = (step: number) => {
    const next = (index + step + n) % n;
    setIndex(next);
    setCaption(photos[next]?.caption ?? '');
    setConfirming(false);
    setError(null);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(saveErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode = null;
  if (owner) {
    body = confirming ? (
      <div className={styles.confirm}>
        <p>{t.photos.removeConfirm}</p>
        <div className={styles.row}>
          <InkButton
            primary
            busy={busy}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await client.remove(photo.id);
                owner.removed(photo.id);
                if (n === 1) onClose();
                else {
                  setIndex((i) => Math.min(i, n - 2));
                  setConfirming(false);
                }
              })
            }
          >
            {t.photos.removeYes}
          </InkButton>
          <InkButton
            onClick={() => {
              setConfirming(false);
            }}
          >
            {t.photos.keep}
          </InkButton>
        </div>
      </div>
    ) : (
      <form
        className={styles.captionForm}
        onKeyDown={preventImeEnter}
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            owner.replaced(await client.caption(photo.id, caption));
          });
        }}
      >
        <label htmlFor={captionId} className="visually-hidden">
          {t.photos.captionLabel}
        </label>
        <InkBox>
          <input
            id={captionId}
            className={inputClass}
            value={caption}
            maxLength={140}
            placeholder={t.photos.captionPlaceholder}
            onChange={(e) => {
              setCaption(e.currentTarget.value);
            }}
          />
        </InkBox>
        <div className={styles.row}>
          <InkButton type="submit" busy={busy} disabled={busy}>
            {t.photos.saveCaption}
          </InkButton>
          <button
            type="button"
            className={`tap ${styles.danger}`}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t.photos.remove}
          </button>
        </div>
      </form>
    );
  }

  return (
    // the dialog closes itself on Esc; onClose keeps React in step
    <dialog ref={ref} className={styles.viewer} aria-labelledby={titleId} onClose={onClose}>
      <div className={`sk ${styles.sheet}`}>
        <Ink />
        <div className={styles.viewerTop}>
          <h2 id={titleId} className={styles.viewerTitle}>
            {who ?? t.photos.viewerLabel} · {t.photos.counter(index + 1, n)}
          </h2>
          <button
            type="button"
            className={`tap ${styles.iconBtn}`}
            aria-label={t.photos.close}
            onClick={() => {
              ref.current?.close();
              onClose();
            }}
          >
            <Icon name="close" size={22} strokeWidth={2.4} />
          </button>
        </div>
        <figure className={styles.figure}>
          <img
            key={photo.id}
            className={styles.big}
            src={photo.url}
            alt={photo.caption ?? ''}
            width={photo.width}
            height={photo.height}
          />
          {photo.caption && !owner && <figcaption className="note">{photo.caption}</figcaption>}
        </figure>
        {n > 1 && (
          <div className={styles.nav}>
            <button
              type="button"
              className={`tap ${styles.iconBtn}`}
              aria-label={t.photos.prev}
              onClick={() => {
                go(-1);
              }}
            >
              <Icon name="back" size={22} strokeWidth={2.4} />
            </button>
            <button
              type="button"
              className={`tap ${styles.iconBtn} ${styles.flip}`}
              aria-label={t.photos.next}
              onClick={() => {
                go(1);
              }}
            >
              <Icon name="back" size={22} strokeWidth={2.4} />
            </button>
          </div>
        )}
        {body}
        {error && (
          <p role="alert" className={styles.errors}>
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
