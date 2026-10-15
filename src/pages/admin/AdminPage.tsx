import { useEffect, useState } from 'react';
import { Headline } from '../../components/bits';
import { Ink } from '../../components/Ink';
import { AdminStatsSchema, type AdminStats } from '../../contracts/admin';
import { parseHeadline } from '../../domain/headlines';
import { ADMIN_MESSAGES } from '../../i18n/adminMessages';
import { useI18n } from '../../i18n/context';
import { api } from '../../lib/api';
import { NotFoundPage } from '../NotFoundPage';
import styles from './AdminPage.module.css';

type Load = { state: 'loading' } | { state: 'ready'; stats: AdminStats } | { state: 'nope' };

/**
 * /admin, for the owner. Loaded lazily (its own chunk and strings). The API
 * decides: anything but a 200 (a 404 for everyone who isn't an admin) shows
 * the ordinary not-found page, the same as any other unknown URL.
 */
export function AdminPage() {
  const { t, locale } = useI18n();
  const a = ADMIN_MESSAGES[locale];
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    api('/api/admin/stats')
      .then(async (res) => AdminStatsSchema.parse(await res.json()))
      .then(
        (stats) => {
          if (live) setLoad({ state: 'ready', stats });
        },
        () => {
          if (live) setLoad({ state: 'nope' });
        },
      );
    return () => {
      live = false;
    };
  }, []);

  // say nothing while asking: a non-admin must not see a flash of anything admin-shaped
  if (load.state === 'loading') return <main id="main" aria-busy="true" />;
  if (load.state === 'nope') return <NotFoundPage />;
  const { stats } = load;
  const total30 = stats.signupsByDay.reduce((n, d) => n + d.count, 0);
  const peak = Math.max(1, ...stats.signupsByDay.map((d) => d.count));
  const day = (iso: string) => {
    try {
      return t.formatDate(iso);
    } catch {
      return iso; // not a date: show it as stored
    }
  };

  return (
    <main id="main" className={styles.main}>
      <Headline className={styles.title} parts={parseHeadline(a.title)} />
      <div className={styles.tiles}>
        <div className={`sk ${styles.tile}`}>
          <Ink />
          <span className={styles.big}>{stats.totalUsers}</span>
          <span className={styles.tileLabel}>{a.totalUsers}</span>
        </div>
        <div className={`sk ${styles.tile} ${styles.tileAlt}`}>
          <Ink />
          <span className={styles.big}>{total30}</span>
          <span className={styles.tileLabel}>{a.signupsTitle}</span>
        </div>
      </div>

      <section className={`sk ${styles.panel}`} aria-labelledby="signups">
        <Ink />
        <h2 id="signups" className={styles.h2}>
          {a.signupsTitle}
        </h2>
        <div className={styles.chart} role="img" aria-label={a.signupsChart(total30)}>
          {stats.signupsByDay.map((d, i) => (
            <span key={d.day} className={styles.barSlot} title={a.signupsDay(day(d.day), d.count)}>
              {d.count > 0 && <span className={styles.barValue}>{d.count}</span>}
              <span
                className={`${styles.bar} ${d.count === 0 ? styles.zero : ''}`}
                style={{ '--h': d.count / peak, '--i': i }}
              />
            </span>
          ))}
        </div>
        <div className={styles.axis} aria-hidden="true">
          <span>{day(stats.signupsByDay[0]?.day ?? '')}</span>
          <span>{day(stats.signupsByDay.at(-1)?.day ?? '')}</span>
        </div>
      </section>

      <section className={`sk ${styles.panel}`} aria-labelledby="everyone">
        <Ink />
        <h2 id="everyone" className={styles.h2}>
          {a.usersTitle}
        </h2>
        {/* scrolls sideways on phones: focusable so keyboards can scroll it too */}
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-labelledby="everyone">
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{a.name}</th>
                <th scope="col">{a.joined}</th>
                <th scope="col">{a.lastSeen}</th>
                <th scope="col" className={styles.num}>
                  {a.spots}
                </th>
                <th scope="col" className={styles.num}>
                  {a.friends}
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.users.map((u, i) => (
                <tr key={`${u.createdAt}-${String(i)}`}>
                  <th scope="row" className={styles.who}>
                    <span aria-hidden="true">{u.avatarEmoji} </span>
                    {u.displayName ?? a.unnamed}
                  </th>
                  <td>{day(u.createdAt)}</td>
                  <td>{day(u.lastSeenAt)}</td>
                  <td className={styles.num}>{u.spots}</td>
                  <td className={styles.num}>{u.friends}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
