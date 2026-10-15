import { useId, useState, type SyntheticEvent } from 'react';
import { parseLatLng } from '../domain/geo';
import { useOrigin } from '../lib/origin';
import styles from './HomeControls.module.css';
import { Icon } from './Icon';
import { Ink } from './Ink';

/** "set home": from where you are, or typed as lat, lng. Saved on this device only. */
export function HomeEditor() {
  const {
    homeEditorOpen,
    closeHomeEditor,
    setHome,
    setHomeFromHere,
    forgetHome,
    homeIsDemo,
    home,
    status,
  } = useOrigin();
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  if (!homeEditorOpen) return null;

  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = parseLatLng(text);
    if (!parsed) {
      setError(true);
      return;
    }
    setError(false);
    setText('');
    setHome(parsed);
  };

  return (
    <section className={`sk ${styles.panel}`} aria-labelledby={`${id}-title`}>
      <Ink />
      <div className={styles.head}>
        <h2 id={`${id}-title`}>where&apos;s home?</h2>
        <button
          type="button"
          className={`tap ${styles.dismiss}`}
          aria-label="Close"
          onClick={closeHomeEditor}
        >
          <Icon name="close" size={16} strokeWidth={2.4} />
        </button>
      </div>
      <p className={styles.small}>
        saved on this device only. it never leaves your browser and isn&apos;t part of the site.
        {!homeIsDemo && ` now: ${home.lat.toFixed(4)}, ${home.lng.toFixed(4)}.`}
      </p>
      <div className={styles.row}>
        <button
          type="button"
          className={`sk press ${styles.btn} ${styles.primary}`}
          onClick={setHomeFromHere}
          aria-busy={status === 'locating'}
        >
          <Ink />
          <Icon name="locate" size={18} strokeWidth={2} />
          {status === 'locating' ? 'finding you…' : 'use where i am now'}
        </button>
      </div>
      <form className={styles.form} onSubmit={submit} noValidate>
        <label htmlFor={`${id}-coords`} className={styles.small}>
          or type it as lat, lng
        </label>
        <div className={styles.row}>
          <span className={`sk flat ${styles.field}`}>
            <Ink />
            <input
              id={`${id}-coords`}
              className={styles.input}
              inputMode="decimal"
              autoComplete="off"
              placeholder="47.61, -122.33"
              value={text}
              aria-invalid={error}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setError(false);
              }}
            />
          </span>
          <button type="submit" className={`sk press ${styles.btn}`}>
            <Ink />
            save
          </button>
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className={styles.error}>
            that doesn&apos;t look like lat, lng (e.g. 47.61, -122.33).
          </p>
        )}
      </form>
      {!homeIsDemo && (
        <div>
          <button type="button" className={`tap ${styles.linkBtn}`} onClick={forgetHome}>
            forget my home (back to the demo)
          </button>
        </div>
      )}
    </section>
  );
}
