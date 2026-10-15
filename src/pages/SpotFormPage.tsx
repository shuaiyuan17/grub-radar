import { useState, type SyntheticEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Headline } from '../components/bits';
import { Choice, Field, InkBox, InkButton, RatingPicker } from '../components/fields';
import { formErrorClass, inputClass, rowClass } from '../components/fieldClasses';
import { Icon } from '../components/Icon';
import { FOOD_ICONS } from '../components/icons';
import type { AddSpot, SpotPatch } from '../domain/edits';
import { defaultIcon } from '../domain/edits';
import { parseLatLng, type LatLng } from '../domain/geo';
import { parseHeadline } from '../domain/headlines';
import {
  ICONS,
  KINDS,
  LIMITS,
  PRICES,
  type IconName,
  type Kind,
  type Price,
  type Spot,
  type Status,
} from '../domain/spot';
import { useT } from '../i18n/context';
import { saveErrorMessage } from '../lib/errors';
import { parseTags } from '../lib/tags';
import { locate } from '../lib/geolocate';
import { useSpots } from '../lib/spots';
import styles from './SpotFormPage.module.css';

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const formatLatLng = (p: LatLng) => `${fmt(p.lat)}, ${fmt(p.lng)}`;

interface Values {
  name: string;
  kind: Kind;
  where: string;
  cuisine: string;
  price: Price;
  tags: string;
  status: Status;
  rating: number | null;
  note: string;
  /** null: follow the kind's default doodle. */
  icon: IconName | null;
}

function initialValues(spot: Spot | undefined): Values {
  return {
    name: spot?.name ?? '',
    kind: spot?.kind ?? 'food',
    where: spot ? formatLatLng(spot.location) : '',
    cuisine: spot?.cuisine ?? '',
    price: spot?.price ?? '$$',
    tags: spot?.tags.join(', ') ?? '',
    status: spot?.status ?? 'want',
    rating: spot?.rating ?? null,
    note: spot?.note ?? '',
    icon: spot?.icon ?? null,
  };
}

type Errors = Partial<Record<'name' | 'where' | 'save', string>>;

/** Add a spot (`/add`) or edit one (`/place/:id/edit`): one form, two submits. */
function SpotForm({ spot }: { spot?: Spot }) {
  const t = useT();
  const navigate = useNavigate();
  const { actions } = useSpots();
  const [v, setV] = useState<Values>(() => initialValues(spot));
  const [errors, setErrors] = useState<Errors>({});
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const editing = spot !== undefined;

  const set = <K extends keyof Values>(k: K, value: Values[K]) => {
    setV((prev) => ({ ...prev, [k]: value }));
    if (k === 'name' || k === 'where') setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const pinHere = () => {
    setLocating(true);
    locate(
      (p) => {
        setLocating(false);
        set('where', formatLatLng(p));
      },
      (reason) => {
        setLocating(false);
        setErrors((e) => ({ ...e, where: t.formErrors[reason] }));
      },
    );
  };

  // unchanged text keeps the exact stored point (no float round trip)
  const location = (): LatLng | null =>
    spot && v.where === formatLatLng(spot.location) ? spot.location : parseLatLng(v.where);

  const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!actions || saving) return;
    const point = location();
    const next: Errors = {};
    if (!v.name.trim()) next.name = t.formErrors.name;
    if (!point) next.where = v.where.trim() ? t.latLngError : t.formErrors.location;
    setErrors(next);
    if (next.name || next.where || !point) return;

    setSaving(true);
    try {
      const icon = v.icon ?? defaultIcon(v.kind);
      const tags = parseTags(v.tags);
      let saved: Spot;
      if (spot) {
        const patch: SpotPatch = {
          name: v.name.trim(),
          kind: v.kind,
          location: point,
          cuisine: v.cuisine.trim() || null,
          price: v.price,
          icon,
          tags,
          note: v.note.trim() || null,
          // edited from this copy: if it changed elsewhere meanwhile, the server says 409
          version: spot.version,
        };
        saved = await actions.update(spot.id, patch);
      } else {
        const input: AddSpot = {
          name: v.name.trim(),
          kind: v.kind,
          location: point,
          cuisine: v.cuisine.trim(),
          price: v.price,
          icon,
          tags,
          status: v.status,
          note: v.note.trim(),
          ...(v.status === 'been' && v.rating !== null ? { rating: v.rating } : {}),
        };
        saved = await actions.add(input);
      }
      void navigate(`/place/${saved.id}`, { replace: true, viewTransition: true });
    } catch (err) {
      setSaving(false);
      setErrors({ save: saveErrorMessage(err, t) });
    }
  };

  const point = location();
  const noteLeft = LIMITS.note - v.note.trim().length;

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      <Field label={t.form.name} error={errors.name}>
        {({ id, describedBy, invalid }) => (
          <InkBox>
            <input
              id={id}
              className={inputClass}
              value={v.name}
              maxLength={LIMITS.name}
              autoComplete="off"
              placeholder={t.form.namePlaceholder}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => {
                set('name', e.target.value);
              }}
            />
          </InkBox>
        )}
      </Field>

      <Choice
        legend={t.form.kind}
        options={KINDS.map((k) => ({ value: k, label: t.kinds[k] }))}
        value={v.kind}
        onChange={(k) => {
          set('kind', k);
        }}
      />

      <div className={styles.where}>
        <Field
          label={t.form.where}
          hint={point ? t.form.pinned(fmt(point.lat), fmt(point.lng)) : t.form.orTypeLatLng}
          error={errors.where}
        >
          {({ id, describedBy, invalid }) => (
            <div className={rowClass}>
              <InkButton onClick={pinHere} busy={locating} disabled={locating}>
                <Icon name="locate" size={18} strokeWidth={2} />
                {locating ? t.findingYou : t.form.useWhereIAm}
              </InkButton>
              <span className={styles.coords}>
                <InkBox>
                  <input
                    id={id}
                    className={inputClass}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="47.61, -122.33"
                    value={v.where}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    onChange={(e) => {
                      set('where', e.target.value);
                    }}
                  />
                </InkBox>
              </span>
            </div>
          )}
        </Field>
      </div>

      <div className={styles.pair}>
        <Field label={t.form.cuisine} optional>
          {({ id }) => (
            <InkBox>
              <input
                id={id}
                className={inputClass}
                value={v.cuisine}
                maxLength={LIMITS.cuisine}
                autoComplete="off"
                placeholder={t.form.cuisinePlaceholder}
                onChange={(e) => {
                  set('cuisine', e.target.value);
                }}
              />
            </InkBox>
          )}
        </Field>
        <Choice
          legend={t.form.price}
          options={PRICES.map((p) => ({ value: p, label: p }))}
          value={v.price}
          onChange={(p) => {
            set('price', p);
          }}
        />
      </div>

      <Field label={t.form.tags} hint={t.form.tagsHint} optional>
        {({ id, describedBy }) => (
          <InkBox>
            <input
              id={id}
              className={inputClass}
              value={v.tags}
              autoComplete="off"
              autoCapitalize="none"
              aria-describedby={describedBy}
              onChange={(e) => {
                set('tags', e.target.value);
              }}
            />
          </InkBox>
        )}
      </Field>

      {!editing && (
        <div className={styles.status}>
          <Choice
            legend={t.form.status}
            options={[
              { value: 'want', label: t.wantToTry },
              { value: 'been', label: t.been },
            ]}
            value={v.status}
            onChange={(s) => {
              set('status', s);
            }}
          />
          {v.status === 'been' && (
            <RatingPicker
              value={v.rating}
              onChange={(r) => {
                set('rating', r);
              }}
            />
          )}
        </div>
      )}

      <Field label={t.form.note} hint={t.form.charsLeft(Math.max(0, noteLeft))} optional>
        {({ id, describedBy }) => (
          <InkBox>
            <input
              id={id}
              className={`${inputClass} ${styles.noteInput}`}
              value={v.note}
              maxLength={LIMITS.note}
              autoComplete="off"
              placeholder={t.form.notePlaceholder}
              aria-describedby={describedBy}
              onChange={(e) => {
                set('note', e.target.value);
              }}
            />
          </InkBox>
        )}
      </Field>

      <Choice
        legend={t.form.icon}
        options={ICONS.map((icon) => ({
          value: icon,
          aria: t.icons[icon],
          label: (
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ink)"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={FOOD_ICONS[icon]} />
            </svg>
          ),
        }))}
        value={v.icon ?? defaultIcon(v.kind)}
        onChange={(icon) => {
          set('icon', icon);
        }}
      />

      {errors.save && (
        <p role="alert" className={formErrorClass}>
          {errors.save}
        </p>
      )}
      <div className={`${rowClass} ${styles.actions}`}>
        <InkButton type="submit" primary busy={saving} disabled={saving}>
          {saving ? t.form.saving : editing ? t.form.save : t.form.add}
        </InkButton>
        <Link viewTransition to={spot ? `/place/${spot.id}` : '/'} className={styles.cancel}>
          {t.form.cancel}
        </Link>
      </div>
    </form>
  );
}

export function AddSpotPage() {
  const t = useT();
  return (
    <main id="main" className={styles.main}>
      <Headline className={styles.title} parts={parseHeadline(t.addTitle)} />
      <SpotForm />
    </main>
  );
}

export function EditSpotPage() {
  const t = useT();
  const { id } = useParams();
  const { spots } = useSpots();
  const spot = spots.find((s) => s.id === id);
  if (!spot) {
    return (
      <main id="main" className={styles.main}>
        <Headline className={styles.title} parts={parseHeadline(t.spotNotFound)} />
        <Link viewTransition to="/">
          {t.backToList}
        </Link>
      </main>
    );
  }
  return (
    <main id="main" className={styles.main}>
      <Headline className={styles.title} parts={parseHeadline(t.editTitle)} />
      {/* keyed: a different spot starts a fresh form */}
      <SpotForm key={spot.id} spot={spot} />
    </main>
  );
}
