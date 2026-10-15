/**
 * The grub-radar domain: plain TypeScript, no React, no DOM. Everything the
 * UI (and later an API / MCP server) needs to reason about spots.
 *
 * Operation map (v0 implements the read side):
 *   find_nearby -> findNearby(spots, { origin, maxMinutes, kinds })
 *   roll        -> roll(candidates, previousId)
 *   add_spot    -> WritableSpotRepository.add      (planned)
 *   mark_been   -> WritableSpotRepository.markBeen (planned)
 *   add_note    -> WritableSpotRepository.addNote  (planned)
 */
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
