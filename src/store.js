// Хранилище присланных квартир и их статусов (KV: matches:<источник>).
// Отдельный ключ на источник, чтобы запуски разных источников не перезаписывали друг друга.

export const STATUSES = {
  new: { icon: '🆕', label: 'Новая' },
  contacted: { icon: '✉️', label: 'Написал' },
  replied: { icon: '💬', label: 'Ответил' },
  viewing: { icon: '📅', label: 'Просмотр' },
  rejected: { icon: '❌', label: 'Не подходит' },
};

// Порядок воронки: «Ответил» означает, что вы уже написали, и т.д.
const FUNNEL = ['contacted', 'replied', 'viewing'];

export function sourceKeyOf(listingId) {
  const prefix = listingId.split(':')[0];
  return { is24: 'immoscout', ka: 'kleinanzeigen', wiro: 'wiro', nr: 'neuerostocker', fides: 'fides' }[prefix] || null;
}

export async function loadMatches(env, sourceKey) {
  return (await env.STATE.get(`matches:${sourceKey}`, 'json')) || {};
}

export function saveMatches(env, sourceKey, matches) {
  return env.STATE.put(`matches:${sourceKey}`, JSON.stringify(matches));
}

/** Все присланные квартиры из всех источников. */
export async function loadAllMatches(env, sourceKeys) {
  const all = [];
  for (const key of sourceKeys) {
    for (const m of Object.values(await loadMatches(env, key))) all.push({ ...m, sourceKey: key });
  }
  return all;
}

/** Краткая запись о квартире: для /all, писем и статистики. */
export function toMatch(listing, district, prio, jc, now) {
  return {
    id: listing.id,
    source: listing.source,
    title: listing.title.slice(0, 120),
    rooms: listing.rooms,
    size: listing.size,
    kalt: listing.kalt,
    nk: listing.nk ?? null,
    nkIncludesHeating: Boolean(listing.nkIncludesHeating),
    warm: listing.warm,
    deposit: listing.deposit || listing.extra || null,
    district,
    address: listing.address,
    url: listing.url,
    score: prio.score,
    jcIcon: jc.icon,
    foundAt: now,
    status: 'new',
    events: {}, // статус -> время; seen — когда вы впервые открыли письмо или нажали кнопку
    msgId: null,
  };
}

/** Новый статус по нажатию кнопки. Повторное нажатие того же статуса отменяет его. */
export function applyStatus(match, status, now) {
  match.events = match.events || {};
  match.events.seen = match.events.seen || now;
  if (match.status === status) {
    // Отмена: возвращаемся на шаг назад по воронке.
    const i = FUNNEL.indexOf(status);
    match.status = i > 0 ? FUNNEL[i - 1] : 'new';
    delete match.events[status];
    return match.status;
  }
  match.status = status;
  match.events[status] = now;
  // Пропущенные шаги воронки отмечаем тем же временем.
  const i = FUNNEL.indexOf(status);
  for (const prev of FUNNEL.slice(0, Math.max(i, 0))) match.events[prev] = match.events[prev] || now;
  return match.status;
}

/** Кнопки под сообщением о квартире; текущий статус отмечен галочкой. */
export function listingKeyboard(listingId, url, current = 'new') {
  const button = (status) => ({
    text: `${current === status ? '✅ ' : ''}${STATUSES[status].icon} ${STATUSES[status].label}`,
    callback_data: `st:${status}:${listingId}`,
  });
  return {
    inline_keyboard: [
      [{ text: '✍️ Письмо', callback_data: `lt:${listingId}` }, { text: '🔗 Открыть', url }],
      [button('contacted'), button('replied')],
      [button('viewing'), button('rejected')],
    ],
  };
}
