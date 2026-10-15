import { useId, useState, type SyntheticEvent } from 'react';
import { parseLatLng } from '../domain/geo';
import { useT } from '../i18n/context';
import { useOrigin } from '../lib/origin';
import styles from './HomeControls.module.css';
import { inputClass } from './fieldClasses';
import { InkBox } from './fields';
import { Icon } from './Icon';
import { Ink } from './Ink';
import { preventImeEnter } from '../lib/ime';

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
  const t = useT();
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
        <h2 id={`${id}-title`}>{t.homeTitle}</h2>
        <button
          type="button"
          className={`tap ${styles.dismiss}`}
          aria-label={t.close}
          onClick={closeHomeEditor}
        >
          <Icon name="close" size={16} strokeWidth={2.4} />
        </button>
      </div>
      <p className={styles.small}>
        {t.homePrivacy}
        {!homeIsDemo && t.homeNow(home.lat.toFixed(4), home.lng.toFixed(4))}
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
          {status === 'locating' ? t.findingYou : t.useWhereIAmNow}
        </button>
      </div>
      <form className={styles.form} onSubmit={submit} onKeyDown={preventImeEnter} noValidate>
        <label htmlFor={`${id}-coords`} className={styles.small}>
          {t.typeLatLng}
        </label>
        <div className={styles.row}>
          <InkBox>
            <input
              id={`${id}-coords`}
              className={inputClass}
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
          </InkBox>
          <button type="submit" className={`sk press ${styles.btn}`}>
            <Ink />
            {t.save}
          </button>
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className={styles.error}>
            {t.latLngError}
          </p>
        )}
      </form>
      {!homeIsDemo && (
        <div>
          <button type="button" className={`tap ${styles.linkBtn}`} onClick={forgetHome}>
            {t.forgetHome}
          </button>
        </div>
      )}
    </section>
  );
}

/** The one-time question: save this device's old home to your account? */
export function HomeConsent() {
  const { homeConsent, acceptHomeConsent, declineHomeConsent } = useOrigin();
  const t = useT();
  const id = useId();
  if (!homeConsent) return null;
  return (
    <section className={`sk ${styles.panel}`} aria-labelledby={`${id}-title`}>
      <Ink />
      <h2 id={`${id}-title`} className={styles.consentTitle}>
        {t.homeConsentTitle}
      </h2>
      <p className={styles.small}>{t.homeConsentBody}</p>
      <div className={styles.row}>
        <button
          type="button"
          className={`sk press ${styles.btn} ${styles.primary}`}
          onClick={acceptHomeConsent}
        >
          <Ink />
          {t.homeConsentYes}
        </button>
        <button type="button" className={`tap ${styles.linkBtn}`} onClick={declineHomeConsent}>
          {t.homeConsentNo}
        </button>
      </div>
    </section>
  );
}
