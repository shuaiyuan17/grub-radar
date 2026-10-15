/**
 * What an agent reads to use grub: /openapi.json (generated from the same zod
 * contracts the routes validate with), /llms.txt (a short orientation) and
 * /agent-setup.md (how to connect, for an agent asked to "connect yourself").
 * All three are public and say nothing about anyone's data.
 */
import { z } from 'zod/mini';
import { ApiErrorSchema } from '../../src/contracts/errors';
import {
  AddApplePlaceSchema,
  AddByQueryResponseSchema,
  AddByQuerySchema,
  AmbiguousResponseSchema,
  ApplePlaceSchema,
  PlaceSearchResponseSchema,
} from '../../src/contracts/places';
import {
  NearbyResponseSchema,
  RollBodySchema,
  RollResponseSchema,
  SpotListSchema,
} from '../../src/contracts/spots';
import {
  AddNoteSchema,
  AddSpotSchema,
  MarkBeenSchema,
  SpotPatchSchema,
} from '../../src/domain/edits';
import { SpotSchema } from '../../src/domain/spot';
import { VERSION } from '../version';

type Schema = z.core.$ZodType;

/** JSON Schema for a zod contract; request bodies as accepted, responses as sent. */
function jsonSchema(schema: Schema, io: 'input' | 'output'): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-2020-12' });
  delete out.$schema;
  return out;
}

const SCHEMAS: Record<string, [Schema, 'input' | 'output']> = {
  Spot: [SpotSchema, 'output'],
  SpotList: [SpotListSchema, 'output'],
  AddSpotManual: [AddSpotSchema, 'input'],
  AddSpotApple: [AddApplePlaceSchema, 'input'],
  AddSpotQuery: [AddByQuerySchema, 'input'],
  AddByQueryResponse: [AddByQueryResponseSchema, 'output'],
  Ambiguous: [AmbiguousResponseSchema, 'output'],
  SpotPatch: [SpotPatchSchema, 'input'],
  MarkBeen: [MarkBeenSchema, 'input'],
  AddNote: [AddNoteSchema, 'input'],
  RollBody: [RollBodySchema, 'input'],
  NearbyResponse: [NearbyResponseSchema, 'output'],
  RollResponse: [RollResponseSchema, 'output'],
  ApplePlace: [ApplePlaceSchema, 'output'],
  PlaceSearchResponse: [PlaceSearchResponseSchema, 'output'],
  Error: [ApiErrorSchema, 'output'],
};

const ref = (name: keyof typeof SCHEMAS) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const ok = (description: string, schema?: object) =>
  schema ? { description, ...json(schema) } : { description };
const errors = {
  '400': ok('invalid input', ref('Error')),
  '401': ok('no valid token', ref('Error')),
  '403': ok('the token lacks the scope', ref('Error')),
  '429': ok('rate limited', ref('Error')),
};
const read = [{ bearer: ['spots:read'] }];
const write = [{ bearer: ['spots:write'] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const originParam = {
  name: 'origin',
  in: 'query',
  description: '"home" (default; your saved home, never revealed) or "lat,lng"',
  schema: { type: 'string', default: 'home' },
};

/** Every path an agent may call: exactly the spot and place routes. */
export const AGENT_PATHS = {
  '/api/spots': {
    get: {
      operationId: 'listSpots',
      summary: 'Your whole list',
      security: read,
      responses: { '200': ok('your spots', ref('SpotList')), ...errors },
    },
    post: {
      operationId: 'addSpot',
      summary:
        'Add a spot: by applePlaceId (from search), by query (+near: the clear Apple Maps match, else 409 ambiguous with candidates), or by hand (name, kind, location)',
      security: write,
      requestBody: json({
        oneOf: [ref('AddSpotApple'), ref('AddSpotQuery'), ref('AddSpotManual')],
      }),
      responses: {
        '201': ok('added', { oneOf: [ref('Spot'), ref('AddByQueryResponse')] }),
        '200': ok('already on your list (unchanged)', {
          oneOf: [ref('Spot'), ref('AddByQueryResponse')],
        }),
        '409': ok('ambiguous: pick one of the candidates', ref('Ambiguous')),
        ...errors,
      },
    },
  },
  '/api/spots/nearby': {
    get: {
      operationId: 'findNearby',
      summary: 'Spots within reach, closest first (distances from home are approximate)',
      security: read,
      parameters: [
        originParam,
        { name: 'maxMinutes', in: 'query', schema: { type: 'number' } },
        { name: 'kinds', in: 'query', description: 'e.g. food,coffee', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } },
      ],
      responses: { '200': ok('nearby spots', ref('NearbyResponse')), ...errors },
    },
  },
  '/api/spots/{id}': {
    parameters: [idParam],
    get: {
      operationId: 'getSpot',
      summary: 'One spot',
      security: read,
      responses: { '200': ok('the spot', ref('Spot')), ...errors },
    },
    patch: {
      operationId: 'editSpot',
      summary:
        "Edit a spot (null clears a field). Not visibility or myNote: those are the person's (403); add notes with POST …/notes",
      security: write,
      requestBody: json(ref('SpotPatch')),
      responses: { '200': ok('the spot', ref('Spot')), ...errors },
    },
  },
  '/api/spots/{id}/been': {
    parameters: [idParam],
    post: {
      operationId: 'markBeen',
      summary: 'Mark as been, with an optional verdict (good/meh/bad) and note',
      security: write,
      requestBody: json(ref('MarkBeen')),
      responses: { '200': ok('the spot', ref('Spot')), ...errors },
    },
  },
  '/api/spots/{id}/notes': {
    parameters: [idParam],
    post: {
      operationId: 'addNote',
      summary: 'Append a dated line to the notes',
      security: write,
      requestBody: json(ref('AddNote')),
      responses: { '200': ok('the spot', ref('Spot')), ...errors },
    },
  },
  '/api/roll': {
    post: {
      operationId: 'roll',
      summary: 'One random spot within reach',
      security: read,
      requestBody: json(ref('RollBody')),
      responses: { '200': ok('a pick, or null', ref('RollResponse')), ...errors },
    },
  },
  '/api/places/search': {
    get: {
      operationId: 'searchPlaces',
      summary: 'Restaurants, cafés and bakeries on Apple Maps (adds nothing)',
      security: read,
      parameters: [
        { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2 } },
        { ...originParam, name: 'near', description: '"home" or "lat,lng" (default: home)' },
      ],
      responses: { '200': ok('places', ref('PlaceSearchResponse')), ...errors },
    },
  },
  '/api/places/{applePlaceId}': {
    parameters: [{ ...idParam, name: 'applePlaceId' }],
    get: {
      operationId: 'getPlace',
      summary: 'One Apple Maps place',
      security: read,
      responses: { '200': ok('the place', ref('ApplePlace')), ...errors },
    },
  },
} as const;

export function openApi(origin: string): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'grub radar',
      version: VERSION,
      description:
        "One person's list of places to eat, for their agents. Authenticate with a personal API token (Settings → personal tokens; `Authorization: Bearer grub_pat_…`) or an OAuth access token issued for this API. Errors are `{ error: { code, message } }`.",
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'grub_pat_… personal token, or an OAuth access token for <origin>/api',
        },
      },
      schemas: Object.fromEntries(
        Object.entries(SCHEMAS).map(([name, [schema, io]]) => [name, jsonSchema(schema, io)]),
      ),
    },
    paths: AGENT_PATHS,
  };
}

export function llmsTxt(origin: string): string {
  return `# grub radar

> One person's list of places to eat (restaurants, coffee, bakeries): been or want to try, a one-line note, a good/meh/bad verdict. Their agents can read it, add spots and record visits.

How to connect (and the rules for doing it): ${origin}/agent-setup.md

## MCP

- Remote MCP server (streamable HTTP): ${origin}/mcp
- OAuth 2.1 (discovery from the 401; dynamic client registration and client ID metadata documents). The person approves in a browser.
- Tools: list_spots, find_nearby, roll, search_places, add_spot, mark_been, add_note

## REST

- OpenAPI: ${origin}/openapi.json
- Auth: \`Authorization: Bearer grub_pat_…\` (a personal token the person makes in Settings) or an OAuth token for ${origin}/api
- Scopes: spots:read (read), spots:write (add, edit, mark been, notes)
- Main calls: GET /api/spots, GET /api/spots/nearby?origin=home, POST /api/spots, POST /api/spots/{id}/been, POST /api/spots/{id}/notes, POST /api/roll, GET /api/places/search?q=

## Privacy

Home's coordinates are never sent to an agent. For an agent, "home" is the centre of the ~1 km grid cell home lies in, and every distance from home is measured from that point: that is the guarantee (home is anywhere in that cell, up to ~700 m from its centre). km and miles from home are also rounded to the nearest 0.5, but that rounding is cosmetic; the grid is what protects home.

## What an agent may change

With spots:write: add spots, mark them been, append notes, edit a spot's fields (PATCH). Not its visibility (private vs friends) or the person's notes as a whole (PATCH myNote); those, and removing spots, are the person's alone (403).
`;
}

export function agentSetup(origin: string): string {
  const mcp = `${origin}/mcp`;
  return `# Connect to grub radar

You were asked to connect yourself to someone's **grub radar**: their list of places to eat (restaurants, coffee, bakeries), each one "been" or "want to try", with their own one-line note and a good/meh/bad verdict. Once connected you can read the list, find spots near them, roll the dice, look places up on Apple Maps, add spots, and record visits and notes for them.

## Ground rules

- **Ask before you run anything.** Show the person the command or config change below and run it only after they say yes.
- Don't install anything globally, and don't edit files other than your own MCP configuration.
- No secret is needed to start: the first time you connect, a browser page opens on ${origin} where **the person signs in and approves** what you may do (read, or read and add/edit). They can disconnect you any time in grub's settings.
- You will never see where their home is: "home" is the centre of its ~1 km grid cell for you, so distances from it are approximate on purpose (up to ~700 m off).

## Connect over MCP (preferred)

MCP server URL: \`${mcp}\` (streamable HTTP, OAuth). Pick your client:

### Claude Code

\`\`\`sh
claude mcp add --transport http grub ${mcp}
\`\`\`

Then run \`/mcp\` inside Claude Code (or \`claude mcp login grub\` in a shell) and approve in the browser. Add \`--scope user\` to make it available in every project.

### Codex

\`\`\`sh
codex mcp add grub --url ${mcp}
codex mcp login grub
\`\`\`

Or in \`~/.codex/config.toml\`:

\`\`\`toml
[mcp_servers.grub]
url = "${mcp}"
\`\`\`

### Cursor

In \`~/.cursor/mcp.json\` (or \`.cursor/mcp.json\` in a project):

\`\`\`json
{
  "mcpServers": {
    "grub": { "url": "${mcp}" }
  }
}
\`\`\`

Cursor asks to log in the first time it uses the server.

### Claude desktop (and claude.ai)

Settings → Connectors → **Add custom connector**, paste \`${mcp}\`, then **Connect** and approve. (Remote servers are added here, not in claude_desktop_config.json.)

## No MCP? Use REST with a personal token

1. Ask the person to open ${origin}, go to **settings → personal tokens**, make a token (give it your name; tick "add and edit" if you should add spots) and give it to you. It starts with \`grub_pat_\` and is shown once. Keep it secret; don't write it into files they didn't ask for.
2. Send it as \`Authorization: Bearer grub_pat_…\`. Write requests are JSON (\`Content-Type: application/json\`).
3. The API is described at ${origin}/openapi.json; a short summary is at ${origin}/llms.txt.

\`\`\`sh
curl -H "Authorization: Bearer $GRUB_TOKEN" "${origin}/api/spots/nearby?origin=home&maxMinutes=30"
\`\`\`

## Tools, and when to use them

| tool | use it to |
| --- | --- |
| \`list_spots\` | answer questions about their list; find a spot's id |
| \`find_nearby\` | "where should we eat near home / near here": closest first, with minutes and ring |
| \`roll\` | "can't decide": one random spot within reach |
| \`search_places\` | look a place up on Apple Maps before adding it (adds nothing) |
| \`add_spot\` | add a place, by \`applePlaceId\` from search_places (best) or by \`query\` + \`near\`; it's labelled "found by" you |
| \`mark_been\` | they went: optional verdict good / meh / bad and a note |
| \`add_note\` | add a dated line to a spot's notes, in their words |

Only mark visits, give verdicts or write notes when the person told you to. Never invent places, verdicts or opening hours.
`;
}
