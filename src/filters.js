// Фильтры и оценки. Отбор: официальный порог Jobcenter (Bruttokalt ≤ 481,80 €), стоп-слова и город Росток.
// Район, комнаты и площадь на отбор не влияют — только на пометку приоритета.

import {
  SEARCH,
  JOBCENTER,
  PRIORITY_DISTRICTS,
  PRIORITY_ROOMS,
  ROSTOCK_ZIPS,
  BLACKLIST,
  SCAM_WORDS,
  SCAM_MIN_PRICE_PER_SQM,
} from './config.js';
import { DISTRICTS } from './districts.js';

function containsAny(text, words) {
  const lower = (text || '').toLowerCase();
  return words.find((w) => lower.includes(w.toLowerCase())) || null;
}

// Ray casting: точка [lon, lat] внутри многоугольника.
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Цена, по которой отбираем: Kaltmiete, а если её нет — общая сумма. */
export function rentOf(listing) {
  return listing.kalt ?? listing.warm ?? null;
}

/**
 * Район для подписи: по координатам (границы OSM) или по адресу. Не используется для отбора.
 * @returns {string|null}
 */
export function districtOf(listing) {
  if (listing.lat != null && listing.lon != null) {
    const hit = DISTRICTS.find((d) => inRing([listing.lon, listing.lat], d.ring));
    if (hit) return hit.name;
  }
  // «18106 Rostock, Schmarl» → «Schmarl»; «18057 Kröpeliner-Tor-Vorstadt» → «Kröpeliner-Tor-Vorstadt»
  const parts = (listing.address || '').split(',').map((s) => s.replace(/\(.*?\)/g, '').trim());
  const last = parts[parts.length - 1] || '';
  const name = last.replace(/^\d{5}\s*/, '').replace(/^Rostock\s*-?\s*/, '').trim();
  return name && name !== 'Rostock' ? name : null;
}

/** Bruttokalt по данным объявления (Kaltmiete + Nebenkosten без отопления) или null, если NK неизвестны. */
export function bruttokaltOf(listing) {
  if (listing.kalt == null || listing.nk == null || listing.nkIncludesHeating) return null;
  return Math.round((listing.kalt + listing.nk) * 100) / 100;
}

/**
 * Проходит ли объявление порог Jobcenter. Возвращает причину отказа или null.
 * lenient: настоящие NK ещё будут загружены из карточки — пока проверяем только Kaltmiete.
 */
function priceRejectReason(listing, lenient = false) {
  const limit = SEARCH.bruttokaltLimit;
  if (lenient && listing.kalt != null && listing.nk == null) {
    return listing.kalt > limit ? `Kalt ${listing.kalt} € > ${limit} €` : null;
  }
  const brutto = bruttokaltOf(listing);
  if (brutto != null) return brutto > limit ? `Bruttokalt ${brutto} € > ${limit} €` : null;

  // Известна только сумма с отоплением (WIRO, или NK включают отопление).
  if (listing.warm != null && (listing.kalt == null || listing.nkIncludesHeating)) {
    return listing.warm > SEARCH.maxWarm ? `общая аренда ${listing.warm} € > ${SEARCH.maxWarm} €` : null;
  }

  if (listing.kalt != null) {
    if (listing.size) {
      const optimistic = listing.kalt + listing.size * SEARCH.optimisticNkPerSqm;
      return optimistic > limit ? `Kalt ${listing.kalt} € + NK (оценка) > ${limit} €` : null;
    }
    return listing.kalt > SEARCH.fallbackMaxKalt ? `Kalt ${listing.kalt} € без площади и NK` : null;
  }

  // «Auf Anfrage» и т.п.: проверить нельзя. Исключение — FIDES, где цену не всегда удаётся разобрать.
  return listing.allowNoPrice ? null : 'цена не указана';
}

/**
 * Причина отказа или null, если объявление подходит.
 * @param {{ lenient?: boolean }} [options] lenient — до загрузки подробностей из карточки.
 */
export function rejectReason(listing, { lenient = false } = {}) {
  const bad = containsAny(`${listing.title} ${listing.description}`, BLACKLIST);
  if (bad) return `стоп-слово «${bad}»`;

  const rent = rentOf(listing);
  // Меньше 100 € — почти всегда жильё «за ночь» для монтажников или ошибка в объявлении.
  if (rent != null && rent < 100) return `цена ${rent} € (посуточно?)`;

  const price = priceRejectReason(listing, lenient);
  if (price) return price;

  const zip = ((listing.address || '').match(/\b\d{5}\b/) || [])[0];
  if (zip && !ROSTOCK_ZIPS.includes(zip)) return `не город Росток (${zip})`;
  return null;
}

/**
 * Оценка по лимиту Jobcenter (Bruttokaltmiete = Kaltmiete + Nebenkosten без отопления).
 * @returns {{ icon: string, text: string }}
 */
export function jobcenterCheck(listing) {
  const limit = JOBCENTER.bruttokaltLimit;
  const limitText = `лимит ${limit.toFixed(2).replace('.', ',')} €`;

  const brutto = bruttokaltOf(listing);
  if (brutto != null) {
    const icon = brutto <= limit - 10 ? '🟢' : brutto <= limit ? '🟡' : '🔴';
    return { icon, text: `Bruttokalt ${brutto} € (Kalt ${listing.kalt} + NK ${listing.nk}, по объявлению) — ${limitText}` };
  }

  if (listing.warm != null && (listing.kalt == null || listing.nkIncludesHeating)) {
    const icon = listing.warm <= SEARCH.maxWarm - 10 ? '🟢' : '🟡';
    return { icon, text: `всего с отоплением ${listing.warm} € — лимит ≈${SEARCH.maxWarm} € (481,80 + отопление)` };
  }

  if (listing.kalt != null) {
    if (listing.size == null) return { icon: '🟡', text: `площадь и NK не указаны — ${limitText}, уточните NK` };
    const nk = Math.round(listing.size * JOBCENTER.nebenkostenPerSqm);
    const est = Math.round(listing.kalt + nk);
    const icon = est <= limit - 10 ? '🟢' : '🟡';
    return { icon, text: `≈${est} € Bruttokalt (NK ≈${nk} €, оценка — уточните) — ${limitText}` };
  }

  return { icon: '🟡', text: `цена не указана — ${limitText}` };
}

/** Отопление против нормы Jobcenter: площадь × норма по виду отопления / 12. Null, если данных нет. */
export function heatingCheck(listing) {
  if (listing.heating == null || listing.nkIncludesHeating) return null;
  const type = Object.keys(JOBCENTER.heatingPerSqmYear).find((t) => (listing.heatingType || '').includes(t));
  const rate = type ? JOBCENTER.heatingPerSqmYear[type] : JOBCENTER.defaultHeatingPerSqmYear;
  if (!listing.size) return { icon: '🔥', text: `отопление ${listing.heating} €` };
  const norm = Math.round((listing.size * rate) / 12);
  const icon = listing.heating <= norm ? '✅' : '⚠️';
  return {
    icon,
    text: `отопление ${listing.heating} € — норма ≈${norm} € (${listing.size} м², ${type || 'вид не указан'})`,
  };
}

/**
 * Приоритет по вашим критериям: 2 комнаты и основной район. Влияет только на порядок и пометку.
 * @returns {{ score: number, label: string }} score 2 — оба критерия, 1 — один, 0 — ни одного.
 */
export function priority(listing, district) {
  const rooms = listing.rooms;
  const twoRooms = rooms != null && rooms >= PRIORITY_ROOMS && rooms < PRIORITY_ROOMS + 1;
  const mainDistrict = district != null && containsAny(district, PRIORITY_DISTRICTS) != null;
  const score = (twoRooms ? 1 : 0) + (mainDistrict ? 1 : 0);

  const roomsText = rooms == null ? 'комнаты не указаны' : `${String(rooms).replace('.', ',')} комн.`;
  const where = district || 'район не определён';
  if (score === 2) return { score, label: `⭐⭐ <b>ПРИОРИТЕТ:</b> 2 комнаты, основной район (${where})` };
  if (twoRooms) return { score, label: `⭐ 2 комнаты · ${where}` };
  if (mainDistrict) return { score, label: `⭐ Основной район (${where}) · ${roomsText}` };
  return { score, label: `${roomsText} · ${where}` };
}

/** Список предупреждений о возможном мошенничестве. */
export function scamSignals(listing) {
  const signals = [];
  const word = containsAny(`${listing.title} ${listing.description}`, SCAM_WORDS);
  if (word) signals.push(`в тексте «${word}»`);
  if (listing.kalt != null && listing.size) {
    const perSqm = listing.kalt / listing.size;
    if (perSqm < SCAM_MIN_PRICE_PER_SQM) signals.push(`очень дёшево: ${perSqm.toFixed(2).replace('.', ',')} €/м²`);
  }
  return signals;
}
