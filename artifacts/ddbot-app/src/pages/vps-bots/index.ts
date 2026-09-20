/**
 * `/vps-bots` route entry.
 *
 * Kept as a directory index so the route can be lazily imported exactly like the
 * existing pages (`lazy(() => import('../pages/vps-bots'))`).
 */
export { default } from './VpsBotManager';
export { default as VpsBotManager, deriveStatus } from './VpsBotManager';
