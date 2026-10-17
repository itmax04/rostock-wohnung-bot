// Источники объявлений. Каждый возвращает массив объявлений в общем формате:
// { id, source, title, description, kalt, warm, size, rooms, address, lat, lon, url, image }

import { SEARCH } from './config.js';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export class SourceError extends Error {}

// Kaltmiete сама по себе не может быть больше порога Bruttokalt — так порталы сразу отсекают лишнее.
const MAX_KALT = Math.ceil(SEARCH.bruttokaltLimit);

function parseNumber(text) {
  if (text == null) return null;
  const m = String(text).replace(/\./g, '').match(/\d+(,\d+)?/);
  return m ? parseFloat(m[0].replace(',', '.')) : null;
}

// --- ImmoScout24: мобильный API (тот же, что использует Fredy) ---

const IS24_URL =
  'https://api.mobile.immobilienscout24.de/search/list?searchType=region&realestatetype=apartmentrent' +
  '&geocodes=%2Fde%2Fmecklenburg-vorpommern%2Frostock' +
  `&price=-${MAX_KALT}.0&pricetype=rentpermonth&sorting=-firstactivation&pagenumber=1`;

export async function fetchImmoscout() {
  const r = await fetch(IS24_URL, {
    method: 'POST',
    headers: { 'User-Agent': 'ImmoScout_28.1_26.5.2_._', Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ supportedResultListType: [], userData: {} }),
  });
  if (!r.ok) throw new SourceError(`HTTP ${r.status}`);
  const data = await r.json().catch(() => null);
  if (!data || !Array.isArray(data.resultListItems)) throw new SourceError('неожиданный ответ API');

  return data.resultListItems
    .filter((entry) => entry.type === 'EXPOSE_RESULT' && entry.item?.id)
    .map(({ item }) => {
      const values = (item.attributes || []).map((a) => a.value || '');
      return {
        id: `is24:${item.id}`,
        source: 'ImmoScout24',
        title: item.title || '',
        description: '',
        kalt: parseNumber(values.find((v) => v.includes('€'))),
        warm: null,
        size: parseNumber(values.find((v) => v.includes('m²'))),
        rooms: parseNumber(values.find((v) => v.includes('Zi'))),
        address: item.address?.line || '',
        lat: item.address?.lat ?? null,
        lon: item.address?.lon ?? null,
        url: `https://www.immobilienscout24.de/expose/${item.id}`,
        image: item.titlePicture?.full || null,
      };
    });
}

/**
 * Подробности из карточки ImmoScout24: Nebenkosten, Heizkosten, Gesamtmiete, залог, отопление, год постройки.
 * Вызывается только для новых объявлений, прошедших предварительный отбор.
 */
export async function enrichImmoscout(listing) {
  const id = listing.id.replace('is24:', '');
  const r = await fetch(`https://api.mobile.immobilienscout24.de/expose/${id}`, {
    headers: { 'User-Agent': 'ImmoScout_28.1_26.5.2_._', Accept: 'application/json' },
  });
  if (!r.ok) return listing; // нет подробностей — отбираем по оценке
  const data = await r.json().catch(() => null);
  const fields = {};
  for (const section of data?.sections || []) {
    for (const a of section.attributes || []) {
      if (a.label && (a.text || a.value)) fields[a.label.replace(/:$/, '').trim()] = String(a.text || a.value);
    }
  }
  const nkIncludesHeating = /^ja/i.test(fields['Heizkosten in Nebenkosten enthalten'] || '');
  const heatingText = fields['Heizkosten'] || '';
  return {
    ...listing,
    nk: parseNumber(fields['Nebenkosten']),
    nkIncludesHeating,
    // «in Nebenkosten enthalten» и т.п. — суммы нет.
    heating: /\d/.test(heatingText) ? parseNumber(heatingText) : null,
    warm: parseNumber(fields['Gesamtmiete']) ?? listing.warm,
    deposit: fields['Kaution oder Genossenschaftsanteile'] || fields['Kaution'] || null,
    heatingType: fields['Wesentliche Energieträger'] || fields['Heizungsart'] || null,
    yearBuilt: fields['Baujahr'] || null,
    description: [fields['Objektbeschreibung'], fields['Ausstattung'], fields['Sonstiges']].filter(Boolean).join(' ').slice(0, 2000),
  };
}

// --- Kleinanzeigen: страница результатов поиска ---

const KA_URL =
  'https://www.kleinanzeigen.de/s-wohnung-mieten/rostock/anzeige:angebote/sortierung:neuste/' +
  `preis::${MAX_KALT}/c203l137`;

// Текст первого элемента внутри фрагмента HTML, который подходит под шаблон (например, «37 m² · 2 Zi.»).
// Ищем только между тегами: так дешевле, чем очищать весь HTML (на бесплатном тарифе 10 мс CPU).
function textMatching(fragment, pattern) {
  const m = fragment.match(new RegExp(`>\\s*(${pattern}[^<]*?)\\s*<`));
  return m ? m[1].replace(/&nbsp;|\s+/g, ' ').trim() : '';
}

/** Режет страницу на блоки <article data-adid=...> без регулярного выражения по всей странице. */
function splitArticles(html) {
  const articles = [];
  let pos = html.indexOf('data-adid="');
  while (pos !== -1) {
    const begin = html.lastIndexOf('<article', pos);
    const end = html.indexOf('</article>', pos);
    if (begin === -1 || end === -1) break;
    articles.push(html.slice(begin, end));
    pos = html.indexOf('data-adid="', end);
  }
  return articles;
}

export async function fetchKleinanzeigen() {
  const request = () => fetch(KA_URL, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'de-DE,de;q=0.9' } });
  let r = await request();
  // Kleinanzeigen иногда разово отвечает 403/429 — одна повторная попытка через 5 секунд.
  if (r.status === 403 || r.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    r = await request();
  }
  if (!r.ok) throw new SourceError(`HTTP ${r.status}`);
  const html = await r.text();

  const articles = splitArticles(html);
  if (articles.length === 0) {
    // Страница пришла, но без объявлений: либо их правда нет, либо сменилась разметка.
    if (!html.includes('srchrslt')) throw new SourceError('страница без списка результатов (возможно, блокировка)');
    return [];
  }

  return articles.map((a) => {
    const adId = a.match(/data-adid="(\d+)"/)[1];
    const href = (a.match(/data-href="([^"]+)"/) || [])[1] || '';
    let ld = {};
    const ldStart = a.indexOf('application/ld+json">');
    if (ldStart !== -1) {
      const from = ldStart + 'application/ld+json">'.length;
      try {
        ld = JSON.parse(a.slice(from, a.indexOf('</script>', from)));
      } catch {}
    }
    const location = textMatching(a, '\\d{5}\\s');
    // Строка вида «37 m² · 2 Zi.» — начинается с числа (в отличие от заголовка).
    const sizeRooms = textMatching(a, '[\\d.,]+\\s*m²');
    const price = textMatching(a, '[\\d.,]+\\s*€');
    return {
      id: `ka:${adId}`,
      source: 'Kleinanzeigen',
      title: ld.title || '',
      description: ld.description || '',
      kalt: parseNumber(price),
      nk: parseNumber(((ld.description || '').match(/Nebenkosten[^0-9]{0,25}(\d{2,3}(?:,\d{2})?)\s*(?:€|EUR|Euro)/i) || [])[1]),
      warm: null,
      size: parseNumber(sizeRooms.split('·')[0]),
      rooms: parseNumber((sizeRooms.split('·')[1] || '').replace('Zi.', '')),
      address: location,
      lat: null,
      lon: null,
      url: `https://www.kleinanzeigen.de${href}`,
      image: ld.contentUrl || null,
    };
  });
}

// --- WIRO: внутренний запрос сайта wohnungssuche.wiro.de ---

export async function fetchWiro() {
  const page = await fetch('https://wohnungssuche.wiro.de/wohnungsangebote/', { headers: { 'User-Agent': BROWSER_UA } });
  if (!page.ok) throw new SourceError(`HTTP ${page.status} (страница)`);
  const nonce = ((await page.text()).match(/"nonce":"([a-f0-9]+)"/) || [])[1];
  if (!nonce) throw new SourceError('не найден ключ nonce (сайт изменился?)');

  const r = await fetch('https://wohnungssuche.wiro.de/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: { 'User-Agent': BROWSER_UA },
    body: new URLSearchParams({ action: 'res_filter_properties', nonce }),
  });
  if (!r.ok) throw new SourceError(`HTTP ${r.status}`);
  const data = await r.json().catch(() => null);
  if (!data?.success || !Array.isArray(data.data)) throw new SourceError('неожиданный ответ');

  return data.data.map((w) => ({
    id: `wiro:${w.id}`,
    source: 'WIRO',
    title: w.title || '',
    description: '',
    kalt: null,
    warm: parseNumber(w.pauschalmiete || w.rent),
    size: w.area ? parseFloat(w.area) : null, // формат «46.19» с точкой
    rooms: w.rooms ? parseFloat(w.rooms) : null,
    address: [w.street, w.stadtteil].filter(Boolean).join(', '),
    lat: w.lat ? parseFloat(w.lat) : null,
    lon: w.lng ? parseFloat(w.lng) : null,
    url: w.permalink,
    image: w.thumbnail || null,
    availableFrom: w.available_date || null,
  }));
}

// --- Neue Rostocker Wohnungsgenossenschaft: список квартир на странице wohnungsangebote ---

const NR_BASE = 'https://www.neue-rostocker.de';

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Пары «заголовок ячейки → значение» из таблиц карточки: <th>Zimmer</th><td>1</td>. */
function tableFields(fragment) {
  const fields = {};
  for (const m of fragment.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const key = m[1].replace(/<[^>]+>/g, '').trim();
    fields[key] = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  }
  return fields;
}

export async function fetchNeueRostocker() {
  const r = await fetch(`${NR_BASE}/wohnungsangebote.html`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!r.ok) throw new SourceError(`HTTP ${r.status}`);
  const html = await r.text();
  if (!html.includes('tx_nrivmapi_apartmentlist')) throw new SourceError('нет списка квартир (сайт изменился?)');

  // Каждая квартира начинается с <h2><a href="...action%5D=show...object%5D=ID...">Район - Улица</a></h2>
  const heads = [...html.matchAll(/<h2>\s*<a href="([^"]*action%5D=show[^"]*object%5D=(\d+)[^"]*)">([\s\S]*?)<\/a>\s*<\/h2>/g)];
  return heads.map((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : html.indexOf('<!-- /row -->', m.index);
    const card = html.slice(m.index, end === -1 ? m.index + 6000 : end);
    const f = tableFields(card);
    const title = decodeEntities(m[3]).replace(/\s+/g, ' ').trim(); // «Dierkow - Kurt-Schumacher-Ring 69»
    const [district, street] = title.split(' - ').map((s) => s.trim());
    const image = (card.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null;
    return {
      id: `nr:${m[2]}`,
      source: 'Neue Rostocker',
      title: `Wohnung ${title}`,
      description: '',
      kalt: parseNumber(f['Grundnutzungsgebühr']),
      nk: parseNumber(f['Nebenkosten']),
      warm: parseNumber(f['Gesamtnutzungsgebühr']),
      size: parseNumber(f['Größe']),
      rooms: parseNumber(f['Zimmer']),
      address: street ? `${street}, Rostock, ${district}` : title,
      lat: null,
      lon: null,
      url: NR_BASE + decodeEntities(m[1]),
      image,
      availableFrom: f['Bezug'] || null,
      extra: f['Genossenschafts-Anteile'] ? `Genossenschaftsanteile: ${f['Genossenschafts-Anteile']}` : null,
    };
  });
}

// --- FIDES (Dierkow, Groß Klein, Schmarl): страница wohnungssuche ---
// Свободных квартир у FIDES почти никогда нет («Derzeit sind 0 freie Wohnungen verfügbar»), поэтому
// разметку карточки проверить не на чем. Если квартиры появятся, а разобрать их не удастся,
// бот всё равно пришлёт сообщение «у FIDES N свободных квартир» со ссылкой.

const FIDES_BASE = 'https://www.fides-wohnen.de';
// Только районы Ростока (без Lankow в Шверине): district[] 2 Dierkow, 3 Groß Klein, 4 Schmarl.
const FIDES_URL = `${FIDES_BASE}/wohnungen/wohnungssuche?square=0&room=0&price=0&district%5B%5D=2&district%5B%5D=3&district%5B%5D=4`;
const FIDES_NAV = /^\/wohnungen\/(wohnungssuche|wohnungsanfrage|wohnung-in-schwerin|wohnungen-in-rostock(\/wohnung-in-rostock-[a-z-]+)?)?$/;

export async function fetchFides() {
  const r = await fetch(FIDES_URL, { headers: { 'User-Agent': BROWSER_UA } });
  if (!r.ok) throw new SourceError(`HTTP ${r.status}`);
  const html = await r.text();
  const countMatch = html.match(/Derzeit sind (\d+) freie Wohnung/);
  if (!countMatch) throw new SourceError('не найден счётчик свободных квартир (сайт изменился?)');
  const count = parseInt(countMatch[1], 10);
  if (count === 0) return [];

  // Пробуем найти карточки: ссылки на страницы квартир внутри результатов поиска.
  const results = html.slice(html.indexOf('Derzeit sind'));
  const links = [...new Set([...results.matchAll(/href="(\/wohnungen\/[^"?#]+)"/g)].map((m) => m[1]))].filter(
    (href) => !FIDES_NAV.test(href),
  );
  const listings = links.map((href) => {
    const at = results.indexOf(`href="${href}"`);
    const around = results.slice(Math.max(0, at - 1500), at + 1500).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return {
      id: `fides:${href}`,
      source: 'FIDES',
      allowNoPrice: true,
      title: decodeEntities((around.match(/(\d[\d,]*\s*-?\s*Zimmer[^.€]{0,60})/) || [])[1] || 'Wohnung FIDES'),
      description: '',
      kalt: parseNumber((around.match(/(\d[\d.]*,\d{2}|\d+)\s*(€|EUR)/) || [])[1]),
      warm: null,
      size: parseNumber((around.match(/(\d[\d,]*)\s*(m²|qm|m2)/) || [])[1]),
      rooms: parseNumber((around.match(/(\d)\s*-?\s*Zimmer/) || [])[1]),
      address: 'Rostock (FIDES)',
      lat: null,
      lon: null,
      url: FIDES_BASE + href,
      image: null,
    };
  });
  if (listings.length > 0) return listings;

  // Квартиры есть, но разобрать карточки не удалось — сообщаем о самом факте.
  return [
    {
      id: `fides:count:${count}`,
      source: 'FIDES',
      allowNoPrice: true,
      title: `У FIDES ${count} ${count === 1 ? 'свободная квартира' : 'свободных квартир'} в Ростоке — посмотрите на сайте`,
      description: '',
      kalt: null,
      warm: null,
      size: null,
      rooms: null,
      address: 'Dierkow / Groß Klein / Schmarl',
      lat: null,
      lon: null,
      url: FIDES_URL,
      image: null,
    },
  ];
}

export const SOURCES = {
  immoscout: { name: 'ImmoScout24', fetch: fetchImmoscout, enrich: enrichImmoscout, alertOnZero: true },
  kleinanzeigen: { name: 'Kleinanzeigen', fetch: fetchKleinanzeigen, alertOnZero: true },
  wiro: { name: 'WIRO', fetch: fetchWiro, alertOnZero: false },
  neuerostocker: { name: 'Neue Rostocker', fetch: fetchNeueRostocker, alertOnZero: false },
  fides: { name: 'FIDES', fetch: fetchFides, alertOnZero: false },
};
