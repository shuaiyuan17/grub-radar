/**
 * The grub-radar domain: plain TypeScript, no React, no DOM. Everything the
 * UI (and later an API / MCP server) needs to reason about spots.
 *
 * Operation map (REST endpoint / future MCP tool):
 *   find_nearby -> findNearby(spots, { origin, maxMinutes, kinds })  GET  /api/spots/nearby
 *   roll        -> roll(candidates, previousId)                       POST /api/roll
 *   add_spot    -> WritableSpotRepository.add      (edits.ts)         POST /api/spots
 *   mark_been   -> WritableSpotRepository.markBeen (edits.ts)         POST /api/spots/:id/been
 *   add_note    -> WritableSpotRepository.addNote  (edits.ts)         POST /api/spots/:id/notes
 */
export * from './edits';
export * from './geo';
export * from './headlines';
export * from './maps';
export * from './modes';
export * from './nearby';
export * from './repository';
export * from './roll';
export * from './spot';
export * from './spotView';
export * from './travel';
