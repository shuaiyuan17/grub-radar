/**
 * A D1Database that reports every round trip to a Timing: one per statement
 * run, one per batch. Wraps the binding per request (never the shared env),
 * so concurrent requests can't mix their numbers.
 */
import type { Timing } from './timing';

/** "SELECT sessions", "INSERT user_places": enough to tell calls apart, no values. */
export function describeSql(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  const verb = (/^\w+/.exec(s)?.[0] ?? '?').toUpperCase();
  const table = (verb === 'UPDATE' ? /^UPDATE\s+(\w+)/i : /\b(?:FROM|INTO)\s+(\w+)/i).exec(s)?.[1];
  return table ? `${verb} ${table}` : verb;
}

class TimedStatement implements D1PreparedStatement {
  readonly inner: D1PreparedStatement;
  readonly label: string;
  readonly #timing: Timing;

  constructor(inner: D1PreparedStatement, label: string, timing: Timing) {
    this.inner = inner;
    this.label = label;
    this.#timing = timing;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new TimedStatement(this.inner.bind(...values), this.label, this.#timing);
  }

  async #run<R>(work: () => Promise<R>, meta: (r: R) => Partial<D1Meta>[]): Promise<R> {
    const t0 = performance.now();
    const r = await work();
    this.#timing.recordD1(this.label, performance.now() - t0, meta(r));
    return r;
  }

  async first<T>(colName?: string): Promise<T | null> {
    // .first() is .all() keeping row 0 (D1 doesn't add a LIMIT either); via run() we get meta
    const res = await this.#run(
      () => this.inner.run(),
      (r) => [r.meta],
    );
    const row = res.results[0];
    if (row === undefined) return null;
    if (colName === undefined) return row as T;
    if (!(colName in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${colName}`);
    return row[colName] as T;
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#run(
      () => this.inner.run<T>(),
      (r) => [r.meta],
    );
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#run(
      () => this.inner.all<T>(),
      (r) => [r.meta],
    );
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const work: () => Promise<T[] | [string[], ...T[]]> = () =>
      options?.columnNames
        ? this.inner.raw<T>({ columnNames: true })
        : this.inner.raw<T>({ columnNames: false });
    return this.#run(work, () => []);
  }
}

const unwrap = (s: D1PreparedStatement) => (s instanceof TimedStatement ? s.inner : s);
const labelOf = (s: D1PreparedStatement) => (s instanceof TimedStatement ? s.label : '?');

class TimedD1 implements D1Database {
  readonly #db: D1Database;
  readonly #timing: Timing;

  constructor(db: D1Database, timing: Timing) {
    this.#db = db;
    this.#timing = timing;
  }

  prepare(query: string): D1PreparedStatement {
    return new TimedStatement(this.#db.prepare(query), describeSql(query), this.#timing);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const t0 = performance.now();
    const results = await this.#db.batch<T>(statements.map(unwrap));
    this.#timing.recordD1(
      `batch[${statements.map(labelOf).join('; ')}]`,
      performance.now() - t0,
      results.map((r) => r.meta),
    );
    return results;
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.#db.exec(query);
  }

  withSession(constraintOrBookmark?: string): D1DatabaseSession {
    return this.#db.withSession(constraintOrBookmark);
  }

  dump(): Promise<ArrayBuffer> {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return this.#db.dump();
  }
}

export function timedD1(db: D1Database, timing: Timing): D1Database {
  return new TimedD1(db, timing);
}
