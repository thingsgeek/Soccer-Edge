/**
 * The disclaimer every user must accept before the app does anything (first run, and again
 * whenever DISCLAIMER_VERSION goes up). Shown in the app, in README.md and DISCLAIMER.md.
 * Bump DISCLAIMER_VERSION when the wording changes in substance.
 */
export const DISCLAIMER_VERSION = 1;

export const DISCLAIMER_TITLE = 'Read this before you use Soccer Edge';

export const DISCLAIMER_POINTS: string[] = [
  'Soccer Edge is a free, open-source engine for people to test and build on. It is provided "AS IS", without warranty of any kind (MIT License). Its authors, contributors and PredyGo are not liable for any loss, however it happens.',
  'You must optimize the code and every setting for your own needs before you trade. The defaults are a starting point, not advice, and are not tuned for you, your money or your goals. Test with small amounts, or with Kalshi’s demo account, first.',
  'You make every trading decision. By default the engine only shows picks: nothing is bought unless you click Place or Buy, or you turn automation on yourself. If you turn on automation (Auto-trade, Live trading or background mode), it places real orders by the rules you set. Nobody else sees, controls, approves or reviews your trades — not PredyGo, not the authors.',
  'Nothing here is financial, investment, legal or betting advice. Picks, win chances and “edge” figures are model outputs and can be wrong. Past results say nothing certain about the future.',
  'Trading on prediction markets uses real money and you can lose all of it. Only use money you can afford to lose.',
  'You are responsible for following Kalshi’s terms (including its Developer Agreement) and the laws where you live, and for being old enough to trade. Kalshi is only available in some places.',
  'Software has bugs. Check your orders and positions on Kalshi itself. Your API keys stay encrypted on your own computer; never share them.',
  'Soccer Edge is not affiliated with, endorsed by or sponsored by Kalshi. Using PredyGo picks is optional; PredyGo provides this engine as a free foundation and does not place, control or review your trades.',
];

export const DISCLAIMER_ACKS: string[] = [
  'I have read this. I accept that Soccer Edge is provided as is, and that I alone am responsible for my settings, my code changes and my trades.',
  'I understand that nothing is bought unless I click to buy it or I turn on automation myself.',
];

export const DISCLAIMER_SHORT = 'Open-source engine, provided as is with no warranty. You choose your picks, settings and trades; optimize them for your own needs. Not financial advice.';

/** Plain-text version (README.md / DISCLAIMER.md). */
export function disclaimerText(): string {
  return [`# ${DISCLAIMER_TITLE}`, '', ...DISCLAIMER_POINTS.map((p) => `- ${p}`), ''].join('\n');
}
