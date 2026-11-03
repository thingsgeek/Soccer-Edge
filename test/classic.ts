/**
 * The engine with every rule on and the stricter values used before v0.35, so tests of each
 * filter don't depend on what new installs start with (new installs follow PredyGo's flexible
 * setup: see DEFAULT_RULES_OFF).
 */
import { DEFAULT_CONFIG, type AppConfig } from '../src/config';

export const CLASSIC_CONFIG: AppConfig = structuredClone(DEFAULT_CONFIG);
Object.assign(CLASSIC_CONFIG.risk, {
  maxPrice: 0.94, minMinutesBeforeKickoff: 15, requireStatedAboveCost: true, blockOver25: true, blockBtts: true,
  restOrders: true, maxOpenExposurePct: 0.6, rulesOff: [],
});
Object.assign(CLASSIC_CONFIG.live, { maxPickAgeSec: 45, maxMinutesSinceKickoff: 100 });
