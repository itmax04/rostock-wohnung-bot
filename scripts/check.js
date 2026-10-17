// Локальная проверка: скачивает объявления и показывает, что бот отправил бы (без Telegram).
import { SOURCES } from '../src/sources.js';
import { districtOf, rejectReason, jobcenterCheck, heatingCheck, scamSignals, priority } from '../src/filters.js';

const only = process.argv[2];
for (const [key, source] of Object.entries(SOURCES)) {
  if (only && key !== only) continue;
  const t = performance.now();
  try {
    const listings = await source.fetch();
    let ok = 0;
    console.log(`\n=== ${source.name}: ${listings.length} объявлений (${Math.round(performance.now() - t)} мс)`);
    for (let l of listings) {
      if (source.enrich && !rejectReason(l, { lenient: true })) l = await source.enrich(l);
      const reject = rejectReason(l);
      const district = districtOf(l);
      const p = priority(l, district);
      if (!reject) ok += 1;
      const verdict = reject ? `✗ ${reject}` : `✓ ${['  ', '⭐ ', '⭐⭐'][p.score]} ${jobcenterCheck(l).icon} ${district ?? 'район?'}`;
      const scam = scamSignals(l);
      const h = heatingCheck(l);
      console.log(`${verdict.padEnd(38)} | ${l.kalt ?? l.warm}€+NK${l.nk ?? '?'} ${l.size ?? '?'}m² ${l.rooms ?? '?'}Zi${h ? ' ' + h.icon + 'H' + l.heating : ''} | ${l.address.slice(0, 38)} | ${l.title.slice(0, 40)}${scam.length ? ' ⚠️ ' + scam.join('; ') : ''}`);
    }
    console.log(`→ подходит: ${ok}`);
  } catch (e) {
    console.log(`\n=== ${source.name}: ОШИБКА ${e.message}`);
  }
}
