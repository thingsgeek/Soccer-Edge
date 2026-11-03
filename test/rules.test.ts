import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RULES, ruleFor } from '../src/trade/rules';
import { renderPage } from '../src/gui/page';
import { TIPS } from '../src/gui/tips';

/** Every message the trading code can skip a pick with, as a sample (template parts filled in). */
function skipMessages(): { file: string; msg: string }[] {
  const out: { file: string; msg: string }[] = [];
  const files = ['src/trade/edge.ts', 'src/trade/executor.ts', 'src/live.ts', 'src/predictions/calibration.ts', 'src/match/matcher.ts'];
  const pats = [
    /skip: (`[^`]*`|'[^']*')/g, /skip\((`[^`]*`|'[^']*')\)/g, /reason = (`[^`]*`|'[^']*')/g, /stoppedReason = (`[^`]*`|'[^']*')/g,
    /action: 'skip', reason: (`[^`]*`|'[^']*')/g, /reason: ('[a-z_]+')/g, /reason: (`no track record[^`]*`|`only [^`]*`)/g,
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of pats) for (const m of src.matchAll(re)) {
      // Fill ${...} with a number, as the app would.
      let s = m[1]!.slice(1, -1), prev = '';
      while (s !== prev) { prev = s; s = s.replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '5'); }
      if (!s.trim() || s === '5') continue;
      out.push({ file: f, msg: s });
    }
  }
  return out;
}

test('every skip reason in the code is explained by a rule in "Rules in force"', () => {
  const msgs = skipMessages();
  expect(msgs.length).toBeGreaterThan(40);
  // Messages built only from other messages (all placeholders) are covered by their parts.
  const unexplained = msgs.filter((x) => !ruleFor(x.msg) && !/^[5\s]*$|^bought |\(checked on Kalshi|^5 \(5\)$/.test(x.msg));
  expect(unexplained.map((x) => `${x.file}: ${x.msg}`)).toEqual([]);
});

test('every Kalshi matching failure label is explained by a rule', () => {
  const src = readFileSync('src/format.ts', 'utf8');
  const fn = src.slice(src.indexOf('export function failureLabel'));
  const labels = [...fn.slice(0, fn.indexOf('\n}\n')).matchAll(/return (`[^`]*`|'[^']*')/g)].map((m) => m[1]!.slice(1, -1).replace(/\$\{[^}]*\}(\})?/g, 'X'));
  expect(labels.length).toBeGreaterThan(6);
  expect(labels.filter((l) => !ruleFor(l))).toEqual([]);
});

test('every rule has a plain description and a stage', () => {
  for (const r of RULES) { expect(r.what.length).toBeGreaterThan(20); expect(r.name.length).toBeGreaterThan(3); }
  expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
});

test('every button, switch and field in the app window has a tooltip', () => {
  const html = renderPage('t');
  const body = html.slice(0, html.indexOf('<script>'));
  const missing: string[] = [];
  for (const m of body.matchAll(/<(input|select|button|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]!;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (!id || /\btitle="/.test(attrs) || /type="hidden"/.test(attrs) || TIPS[id]) continue;
    if (new RegExp(`<label[^>]*for="${id}"[^>]*title="`).test(body)) continue;
    const before = body.slice(0, m.index);
    const lo = before.lastIndexOf('<label'), lc = before.lastIndexOf('</label>');
    if (lo > lc && /title="/.test(before.slice(lo, before.indexOf('>', lo)))) continue;
    missing.push(id);
  }
  expect(missing).toEqual([]);
});

test('early trades without a saved league get one from the ticker', async () => {
  const { leagueForTicker } = await import('../src/kalshi/markets');
  expect(leagueForTicker('KXUELTEAMTOTAL-26OCT15BOUSTU-STU1')).toBe('UEFA Europa League');
  expect(leagueForTicker('KXUECLTEAMTOTAL-26OCT15ATAPAF-PAF1')).toBe('UEFA Conference League');
  expect(leagueForTicker('KXMLSTOTAL-26OCT14RSLSJ-2')).toBe('USA MLS');
  expect(leagueForTicker('KXNOPE-1')).toBeNull();
});
