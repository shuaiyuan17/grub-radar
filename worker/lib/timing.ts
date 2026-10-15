/**
 * Per-request timing: what each phase of a request spent waiting on, for the
 * `Server-Timing` response header (visible in Safari/Chrome devtools) and one
 * structured log line per request (Workers Logs indexes the fields).
 *
 * Workers clocks only move across I/O, which is exactly what we want to see
 * here: CPU time is a few ms, everything else is Apple and D1.
 */

export interface Phase {
  name: string;
  ms: number;
  desc?: string;
}

/** What D1 did for this request, from each result's `meta`. */
export interface D1Stats {
  /** Network round trips to D1: one per statement run, one per batch. */
  roundTrips: number;
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  /** Time D1 spent executing SQL (excludes network), summed. */
  sqlMs: number;
  /** Wall time of all D1 calls, summed (they can overlap). */
  wallMs: number;
  /** `served_by_region` / `served_by_colo` / `served_by_primary` as seen. */
  servedBy: string[];
}

const now = () => performance.now();

/** Server-Timing metric names are HTTP tokens. */
const token = (s: string) => s.replace(/[^\w.-]/g, '_');
const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`;

export class Timing {
  readonly #start = now();
  readonly #phases: Phase[] = [];
  readonly #fields: Record<string, string | number | boolean> = {};
  readonly d1: D1Stats = {
    roundTrips: 0,
    statements: 0,
    rowsRead: 0,
    rowsWritten: 0,
    sqlMs: 0,
    wallMs: 0,
    servedBy: [],
  };

  /** Times `work` as phase `name` (also when it throws). */
  async measure<T>(name: string, work: () => Promise<T>, desc?: string): Promise<T> {
    const t0 = now();
    try {
      return await work();
    } finally {
      this.add(name, now() - t0, desc);
    }
  }

  add(name: string, ms: number, desc?: string) {
    this.#phases.push(desc === undefined ? { name, ms } : { name, ms, desc });
  }

  /** An extra structured field for the log line (e.g. where the JWKS came from). */
  note(key: string, value: string | number | boolean) {
    this.#fields[key] = value;
  }

  /** Records one D1 round trip (a statement or a batch). */
  recordD1(label: string, ms: number, metas: readonly Partial<D1Meta>[]) {
    const d = this.d1;
    d.roundTrips += 1;
    d.statements += Math.max(metas.length, 1);
    d.wallMs += ms;
    for (const m of metas) {
      d.rowsRead += m.rows_read ?? 0;
      d.rowsWritten += m.rows_written ?? 0;
      d.sqlMs += m.timings?.sql_duration_ms ?? m.duration ?? 0;
      const where = [
        m.served_by_region,
        m.served_by_colo,
        m.served_by_primary === undefined ? undefined : m.served_by_primary ? 'primary' : 'replica',
      ]
        .filter(Boolean)
        .join('/');
      if (where && !d.servedBy.includes(where)) d.servedBy.push(where);
    }
    this.add(`d1_${String(d.roundTrips)}`, ms, label);
  }

  get phases(): readonly Phase[] {
    return this.#phases;
  }

  elapsed(): number {
    return now() - this.#start;
  }

  /** `name;dur=12.3;desc="…", …, total;dur=…` */
  header(): string {
    const parts = this.#phases.map(
      (p) =>
        `${token(p.name)};dur=${p.ms.toFixed(1)}${p.desc === undefined ? '' : `;desc=${quote(p.desc)}`}`,
    );
    parts.push(`d1;desc=${quote(`${String(this.d1.roundTrips)} round trips`)}`);
    parts.push(`total;dur=${this.elapsed().toFixed(1)}`);
    return parts.join(', ');
  }

  /** The structured log record for this request. Never carries secrets: names and numbers only. */
  record(req: { method: string; path: string; status: number }) {
    const phases: Record<string, number> = {};
    for (const p of this.#phases) phases[p.name] = Math.round(p.ms);
    return {
      message: 'request timing',
      method: req.method,
      path: req.path,
      status: req.status,
      total_ms: Math.round(this.elapsed()),
      d1_round_trips: this.d1.roundTrips,
      d1_statements: this.d1.statements,
      d1_wall_ms: Math.round(this.d1.wallMs),
      d1_sql_ms: Math.round(this.d1.sqlMs * 10) / 10,
      d1_rows_read: this.d1.rowsRead,
      d1_rows_written: this.d1.rowsWritten,
      d1_served_by: this.d1.servedBy.join(','),
      phases,
      // the D1 labels, so a slow d1_N can be matched to its SQL
      d1_calls: this.#phases.filter((p) => p.name.startsWith('d1_')).map((p) => p.desc ?? ''),
      ...this.#fields,
    };
  }
}
