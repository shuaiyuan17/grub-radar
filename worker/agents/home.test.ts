/**
 * Home privacy for agents (memo S2). An agent may measure from "home", but
 * what it gets back must not let it work out where home is: home is snapped
 * to a ~1 km grid before any distance is measured, distances come back
 * coarse, and home's coordinates never appear.
 */
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { CreatedTokenSchema } from '../../src/contracts/agents';
import { NearbyResponseSchema } from '../../src/contracts/spots';
import { distanceKm, type LatLng } from '../../src/domain/geo';
import { coarseDistance, snapToGrid } from '../services/spots';
import { call, send, userSession } from '../test/helpers';
import { connectAgent, mcpClient, toolJson } from '../test/agents';

/** Three fictional spots a few km apart, in different directions. */
const SPOTS: (LatLng & { name: string })[] = [
  { name: 'North Noodle', lat: 47.645, lng: -122.335 },
  { name: 'East Espresso', lat: 47.61, lng: -122.28 },
  { name: 'South Smoke', lat: 47.585, lng: -122.36 },
];

const CENTRE = snapToGrid({ lat: 47.612, lng: -122.331 });
/** A home ~445 m north and ~435 m east of its cell's centre: still in the cell. */
const HOME: LatLng = { lat: CENTRE.lat + 0.004, lng: CENTRE.lng + 0.0058 };

async function setHome(userId: string, p: LatLng) {
  await env.DB.prepare(
    `INSERT INTO user_private (user_id, home_lat, home_lng, updated_at) VALUES (?, ?, ?, 'x')
     ON CONFLICT (user_id) DO UPDATE SET home_lat = excluded.home_lat, home_lng = excluded.home_lng`,
  )
    .bind(userId, p.lat, p.lng)
    .run();
}

async function personWithSpots(id: string, home: LatLng) {
  const cookie = await userSession(id, id);
  await setHome(id, home);
  for (const s of SPOTS)
    await send('POST', '/api/spots', cookie, {
      name: s.name,
      kind: 'food',
      location: { lat: s.lat, lng: s.lng },
    });
  const res = await send('POST', '/api/me/tokens', cookie, {
    name: 'snoop',
    scopes: ['spots:read'],
  });
  const { secret } = CreatedTokenSchema.parse(await res.json());
  return { cookie, token: secret };
}

const nearbyAs = async (headers: Record<string, string>) =>
  NearbyResponseSchema.parse(
    await (await call('/api/spots/nearby?origin=home', { headers })).json(),
  ).spots;

/**
 * The attacker: the point whose distances to the known spots best match the
 * reported ones (least squares over a 25 m grid, ±3 km around the spots).
 */
function trilaterate(reported: { name: string; km: number }[]): LatLng {
  let best: LatLng = { lat: 0, lng: 0 };
  let bestErr = Infinity;
  const step = 0.000225; // ~25 m of latitude
  for (let lat = 47.58; lat <= 47.65; lat += step)
    for (let lng = -122.38; lng <= -122.27; lng += step * 1.5) {
      let err = 0;
      for (const r of reported) {
        const s = SPOTS.find((x) => x.name === r.name);
        if (!s) continue;
        err += (distanceKm({ lat, lng }, s) - r.km) ** 2;
      }
      if (err < bestErr) [bestErr, best] = [err, { lat, lng }];
    }
  return best;
}

/** Spot ids differ per person; everything else must match. */
const withoutId = (s: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'id'));

let snooped: { cookie: string; token: string };

beforeAll(async () => {
  snooped = await personWithSpots('u_home', HOME);
});

describe('snapToGrid', () => {
  it('maps every point of a cell to its centre, never more than ~710 m away', () => {
    for (let i = 0; i < 200; i++) {
      const p = { lat: 47.6 + Math.random() * 0.05, lng: -122.4 + Math.random() * 0.1 };
      const c = snapToGrid(p);
      expect(distanceKm(p, c)).toBeLessThan(0.71);
      expect(snapToGrid(c)).toEqual(c);
    }
  });
});

describe('coarse distances', () => {
  it('rounds to the nearest 0.5 and never shows 0', () => {
    expect(coarseDistance(0.3)).toBe(0.5);
    expect(coarseDistance(0.19)).toBe(0.5); // 0.3 km in miles: used to come out as 0 next to 0.5 km
    expect(coarseDistance(0)).toBe(0.5);
    expect(coarseDistance(1.2)).toBe(1);
    expect(coarseDistance(1.3)).toBe(1.5);
  });
});

describe('what an agent learns about home', () => {
  it('distances from home are coarse and come without coordinates', async () => {
    const spots = await nearbyAs({ authorization: `Bearer ${snooped.token}` });
    expect(spots).toHaveLength(3);
    for (const s of spots) {
      expect(s.location).toBeUndefined();
      expect(s.km * 2).toBe(Math.round(s.km * 2));
      expect(s.miles * 2).toBe(Math.round(s.miles * 2));
    }
  });

  it('every home in the same grid cell gives an agent exactly the same answers', async () => {
    // the cell's centre, and its four corners (±445 m, ±435 m)
    const answers = new Set<string>();
    const homes = [
      CENTRE,
      ...[1, -1].flatMap((a) =>
        [1, -1].map((b) => ({ lat: CENTRE.lat + 0.004 * a, lng: CENTRE.lng + 0.0058 * b })),
      ),
    ];
    for (const [i, home] of homes.entries()) {
      expect(snapToGrid(home)).toEqual(CENTRE);
      const { token } = await personWithSpots(`u_cell${String(i)}`, home);
      const headers = { authorization: `Bearer ${token}` };
      const nearby = (await nearbyAs(headers)).map(withoutId);
      const roll = await call('/api/roll', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ origin: 'home', previousId: 'none' }),
      });
      const { spot } = await roll.json<{ spot: Record<string, unknown> | null }>();
      expect(spot?.location).toBeUndefined();
      answers.add(JSON.stringify(nearby));
    }
    // one answer for five homes up to ~1.2 km apart: no estimate can be within
    // 600 m of all of them, so for some home in the cell any guess is off by more
    expect(answers.size).toBe(1);
  });

  it('trilaterating from three known spots gets no closer than ~500 m', async () => {
    const spots = await nearbyAs({ authorization: `Bearer ${snooped.token}` });
    const guess = trilaterate(spots);
    expect(distanceKm(guess, HOME)).toBeGreaterThan(0.5);
  });

  it('(the same attack on what the person sees works: the test has teeth)', async () => {
    const spots = await nearbyAs({ cookie: snooped.cookie });
    const guess = trilaterate(spots);
    expect(distanceKm(guess, HOME)).toBeLessThan(0.15);
  });

  it('MCP find_nearby and roll get the same coarse view', async () => {
    const owner = await userSession('u_home_mcp', 'Hm');
    await setHome('u_home_mcp', HOME);
    for (const s of SPOTS)
      await send('POST', '/api/spots', owner, {
        name: s.name,
        kind: 'food',
        location: { lat: s.lat, lng: s.lng },
      });
    const client = await mcpClient((await connectAgent(owner)).access_token);
    const near = toolJson(
      await client.callTool({ name: 'find_nearby', arguments: { origin: 'home' } }),
    );
    const viaMcp = NearbyResponseSchema.parse(near).spots;
    const viaRest = await nearbyAs({ authorization: `Bearer ${snooped.token}` });
    expect(viaMcp.map(withoutId)).toEqual(viaRest.map(withoutId));
    const rolled = toolJson(await client.callTool({ name: 'roll', arguments: {} }));
    expect(JSON.stringify(rolled)).not.toMatch(/"location"/);
    await client.close();
  });

  it("home's coordinates appear in nothing an agent can fetch", async () => {
    const auth = { authorization: `Bearer ${snooped.token}` };
    const digits = [HOME.lat, HOME.lng].map((n) => n.toFixed(4));
    for (const path of ['/api/spots', '/api/spots/nearby?origin=home', '/api/me']) {
      const body = await (await call(path, { headers: auth })).text();
      for (const d of digits) expect(body).not.toContain(d);
    }
  });

  it('explicit coordinates from the agent are used as given (nothing to hide)', async () => {
    const res = await call(
      `/api/spots/nearby?origin=${String(SPOTS[0]?.lat)},${String(SPOTS[0]?.lng)}`,
      {
        headers: { authorization: `Bearer ${snooped.token}` },
      },
    );
    const spots = NearbyResponseSchema.parse(await res.json()).spots;
    expect(spots[0]?.km).toBe(0);
    expect(spots[0]?.location).toBeDefined();
  });
});
