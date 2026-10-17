// Команды и кнопки Telegram (webhook).

import { SOURCES } from './sources.js';
import { STATUSES, loadMatches, saveMatches, loadAllMatches, sourceKeyOf, applyStatus, listingKeyboard } from './store.js';
import { loadProfile, saveProfile, parseProfile, buildLetter } from './letters.js';
import { call, sendText, answerCallback, editButtons, escapeHtml } from './telegram.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NO_REPLY_DAYS = 3;
const MESSAGE_LIMIT = 3800; // у Telegram лимит 4096 символов

const COMMANDS = [
  { command: 'all', description: 'Все актуальные подходящие квартиры' },
  { command: 'stats', description: 'Статистика: отклики, ответы, просмотры' },
  { command: 'profile', description: 'Подпись для писем: имя, возраст, телефон' },
  { command: 'help', description: 'Что умеет бот' },
];

const ALIASES = {
  all: ['/all', 'все', '/все', 'всё', 'список'],
  stats: ['/stats', 'стат', '/стат', 'статистика'],
  profile: ['/profile', 'профиль', '/профиль'],
  help: ['/help', '/start', 'помощь', 'help'],
};

function commandOf(text) {
  const t = (text || '').trim().toLowerCase().split(/[\s@;]/)[0];
  return Object.keys(ALIASES).find((cmd) => ALIASES[cmd].includes(t)) || null;
}

function berlinTime(ts) {
  return ts
    ? new Date(ts).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })
    : '—';
}

async function loadStates(env) {
  const states = {};
  for (const key of Object.keys(SOURCES)) states[key] = (await env.STATE.get(`state:${key}`, 'json')) || {};
  return states;
}

/** Объявление ещё на сайте? Если источник давно не отвечал, считаем, что да (не знаем). */
function isActive(match, states) {
  const state = states[match.sourceKey] || {};
  const sourceFresh = state.lastOkAt && Date.now() - state.lastOkAt < 2 * HOUR;
  return !sourceFresh || Boolean(state.active?.[match.id]);
}

function stars(score) {
  return score === 2 ? '⭐⭐' : score === 1 ? '⭐' : '▫️';
}

function factsOf(m) {
  return [
    m.rooms != null ? `${String(m.rooms).replace('.', ',')} Zi` : null,
    m.size != null ? `${String(m.size).replace('.', ',')} m²` : null,
    m.kalt != null ? `${m.kalt} € kalt` : m.warm != null ? `${m.warm} € gesamt` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function matchLine(m) {
  return (
    `${stars(m.score)} ${STATUSES[m.status]?.icon || '🆕'} ${m.jcIcon || ''} <b>${escapeHtml(factsOf(m))}</b>` +
    ` — ${escapeHtml(m.district || m.address || 'район?')}\n` +
    `    <a href="${escapeHtml(m.url)}">${escapeHtml(m.source)}</a> · найдено ${berlinTime(m.foundAt)}`
  );
}

async function sendChunks(env, header, lines) {
  let chunk = header;
  for (const line of lines) {
    if (chunk.length + line.length + 2 > MESSAGE_LIMIT) {
      await sendText(env, chunk);
      chunk = '';
    }
    chunk += (chunk ? '\n\n' : '') + line;
  }
  if (chunk) await sendText(env, chunk);
}

async function commandAll(env) {
  const [all, states] = await Promise.all([loadAllMatches(env, Object.keys(SOURCES)), loadStates(env)]);
  const statusOrder = { viewing: 0, replied: 1, contacted: 2, new: 3 };
  const visible = all
    .filter((m) => m.status !== 'rejected' && isActive(m, states))
    .sort((a, b) => b.score - a.score || statusOrder[a.status] - statusOrder[b.status] || b.foundAt - a.foundAt);
  const rejected = all.filter((m) => m.status === 'rejected').length;
  const gone = all.filter((m) => m.status !== 'rejected' && !isActive(m, states)).length;

  if (visible.length === 0) {
    await sendText(env, '🏠 Сейчас подходящих актуальных квартир нет. Как только появятся — пришлю.');
    return;
  }
  const footer = [];
  if (gone) footer.push(`${gone} уже сняты с публикации или не проходят порог`);
  if (rejected) footer.push(`${rejected} отмечены ❌`);
  const header =
    `🏠 <b>Актуальные квартиры: ${visible.length}</b>\n` +
    '⭐⭐ 2 комнаты + основной район · ⭐ одно из двух · ▫️ остальные\n' +
    '🆕 новая · ✉️ написал · 💬 ответил · 📅 просмотр' +
    (footer.length ? `\n<i>Скрыто: ${footer.join(', ')}</i>` : '');
  await sendChunks(env, header, visible.map(matchLine));
}

/** Итоги за период: найдено, просмотрено вами, написано, ответы, просмотры, без ответа. */
export async function activitySummary(env, since) {
  const all = await loadAllMatches(env, Object.keys(SOURCES));
  const now = Date.now();
  const inPeriod = (ts) => ts != null && ts >= since;
  const count = (event) => all.filter((m) => inPeriod(m.events?.[event])).length;
  const total = (event) => all.filter((m) => m.events?.[event]).length;

  const found = all.filter((m) => inPeriod(m.foundAt));
  const byScore = [2, 1, 0].map((s) => found.filter((m) => m.score === s).length);
  const waiting = all
    .filter((m) => m.status === 'contacted' && m.events?.contacted && now - m.events.contacted > NO_REPLY_DAYS * DAY)
    .sort((a, b) => a.events.contacted - b.events.contacted);
  const contactedTotal = total('contacted');
  const repliedTotal = total('replied');

  const lines = [
    `🔎 Найдено новых: <b>${found.length}</b>` + (found.length ? ` (⭐⭐ ${byScore[0]} · ⭐ ${byScore[1]} · ▫️ ${byScore[2]})` : ''),
    `👀 Просмотрено вами: <b>${count('seen')}</b>`,
    `✉️ Отправлено откликов: <b>${count('contacted')}</b> (всего: ${contactedTotal})`,
    `💬 Ответили: <b>${count('replied')}</b> (всего: ${repliedTotal}` +
      (contactedTotal ? `, ${Math.round((100 * repliedTotal) / contactedTotal)}% откликов` : '') +
      ')',
    `📅 Просмотров согласовано: <b>${count('viewing')}</b> (всего: ${total('viewing')})`,
    `❌ Не подходит: ${count('rejected')}`,
    `⏳ Без ответа больше ${NO_REPLY_DAYS} дней: <b>${waiting.length}</b>` +
      (waiting.length ? ' — стоит написать повторно или позвонить:' : ''),
  ];
  for (const m of waiting.slice(0, 5)) {
    const days = Math.floor((now - m.events.contacted) / DAY);
    lines.push(`    • <a href="${escapeHtml(m.url)}">${escapeHtml(factsOf(m))} — ${escapeHtml(m.district || '')}</a>, ${days} дн.`);
  }
  if (waiting.length > 5) lines.push(`    … и ещё ${waiting.length - 5}`);
  return lines.join('\n');
}

async function commandStats(env) {
  const states = await loadStates(env);
  const lines = ['📊 <b>Статистика за последние 24 часа</b>', await activitySummary(env, Date.now() - DAY), '', '<b>Источники</b>'];
  for (const [key, source] of Object.entries(SOURCES)) {
    const s = states[key] || {};
    const ok = s.lastOkAt && Date.now() - s.lastOkAt < 2 * HOUR;
    lines.push(
      `${ok ? '✅' : '❌'} ${source.name}: последняя проверка ${berlinTime(s.lastOkAt)}` +
        (s.lastError ? `\n    ошибка: ${escapeHtml(s.lastError)}` : ''),
    );
  }
  await sendText(env, lines.join('\n'));
}

async function commandProfile(env, text) {
  const hasArgs = text.trim().split(/\s+/).length > 1 || text.includes(';');
  if (!hasArgs) {
    const p = await loadProfile(env);
    await sendText(
      env,
      (p
        ? `👤 <b>Подпись сейчас:</b> ${escapeHtml(p.name)}${p.age ? `, ${escapeHtml(p.age)} лет` : ''}${p.phone ? `, ${escapeHtml(p.phone)}` : ', без телефона'}` +
          (p.extra ? `\nДополнительно: ${escapeHtml(p.extra)}` : '') +
          '\n\nЧтобы изменить, отправьте заново:\n'
        : '👤 <b>Подпись для писем ещё не задана.</b> Отправьте одним сообщением:\n') +
        '<code>/profile Имя Фамилия; возраст; телефон; дополнительно</code>\n\n' +
        'Например: <code>/profile Max Mustermann; 25; +49 151 12345678; Ich bin Nichtraucher und habe keine Haustiere</code>\n' +
        '«Дополнительно» — по желанию, на немецком. Указывайте только правду.',
    );
    return;
  }
  const profile = parseProfile(text);
  if (!profile) {
    await sendText(env, '⚠️ Не понял. Формат: <code>/profile Имя Фамилия; возраст; телефон</code> (возраст и телефон — по желанию)');
    return;
  }
  await saveProfile(env, profile);
  await sendText(env, `✅ Подпись сохранена: ${escapeHtml(profile.name)}${profile.phone ? `, ${escapeHtml(profile.phone)}` : ''}. Теперь письма будут подписаны.`);
}

async function commandHelp(env) {
  await sendText(
    env,
    '🤖 <b>Rostock Wohnung Bot</b>\n' +
      `Каждые 10 минут, круглосуточно, проверяю ${Object.values(SOURCES).map((x) => x.name).join(', ')} ` +
      'и присылаю новые квартиры в Ростоке в пределах лимита Jobcenter (Bruttokalt ≤ 481,80 €).\n\n' +
      '<b>Команды</b>\n' +
      '/all — все актуальные квартиры («все»)\n' +
      '/stats — статистика за сутки и работа источников («стат»)\n' +
      '/profile — подпись для писем: имя, возраст, телефон\n' +
      '/help — эта подсказка\n\n' +
      '<b>Кнопки под квартирой</b>\n' +
      '✍️ Письмо — готовое письмо на немецком: нажмите на текст, чтобы скопировать, затем «🔗 Открыть» и вставьте в форму\n' +
      '✉️ Написал → 💬 Ответил → 📅 Просмотр, ❌ Не подходит — отмечайте прогресс. Повторное нажатие отменяет отметку.\n\n' +
      'Каждый вечер в 21:00 — итоги дня и напоминание, кто не ответил больше 3 дней.',
  );
}

async function sendLetter(env, match, sourceKey, matches) {
  const profile = await loadProfile(env);
  const letter = buildLetter(match, profile);
  const header = `✍️ <b>Письмо: ${escapeHtml(factsOf(match))} — ${escapeHtml(match.district || match.address || '')}</b>`;
  const warn = letter.missingProfile
    ? '\n⚠️ Подпись не задана — замените [Ihr Name] и [Telefon] или задайте один раз: /profile\n'
    : '';
  await sendText(
    env,
    `${header}${warn}\nНажмите на текст ниже — он скопируется:\n<pre>${escapeHtml(letter.de)}</pre>\n` +
      `<blockquote expandable>🇷🇺 Перевод:\n${escapeHtml(letter.ru)}</blockquote>`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔗 Открыть объявление', url: match.url }],
          [{ text: '✉️ Отправил', callback_data: `st:contacted:${match.id}` }],
        ],
      },
    },
  );
  match.events = match.events || {};
  if (!match.events.seen) {
    match.events.seen = Date.now();
    await saveMatches(env, sourceKey, matches);
  }
}

async function handleCallback(env, query) {
  const [prefix, ...rest] = (query.data || '').split(':');
  const status = prefix === 'st' ? rest.shift() : null;
  const listingId = rest.join(':');
  const sourceKey = sourceKeyOf(listingId);
  if (!['st', 'lt'].includes(prefix) || (prefix === 'st' && !STATUSES[status]) || !sourceKey) {
    await answerCallback(env, query.id, 'Неизвестная кнопка');
    return;
  }
  const matches = await loadMatches(env, sourceKey);
  const match = matches[listingId];
  if (!match) {
    await answerCallback(env, query.id, 'Эта квартира уже удалена из памяти бота');
    return;
  }

  if (prefix === 'lt') {
    await answerCallback(env, query.id, 'Готовлю письмо…').catch(() => {});
    await sendLetter(env, match, sourceKey, matches);
    return;
  }

  const newStatus = applyStatus(match, status, Date.now());
  await saveMatches(env, sourceKey, matches);
  await answerCallback(env, query.id, `Статус: ${STATUSES[newStatus].label}`).catch(() => {});

  // Обновляем кнопки под сообщением о квартире (даже если нажали «Отправил» под письмом).
  const keyboard = listingKeyboard(listingId, match.url, newStatus);
  const chatId = query.message?.chat?.id;
  const pressedOnListing = query.message && (!match.msgId || query.message.message_id === match.msgId);
  if (pressedOnListing) await editButtons(env, chatId, query.message.message_id, keyboard).catch(() => {});
  if (match.msgId && query.message?.message_id !== match.msgId) {
    await editButtons(env, env.TELEGRAM_CHAT_ID, match.msgId, keyboard).catch(() => {});
  }
}

/** Обработка одного обновления от Telegram. Отвечаем только владельцу бота. */
export async function handleUpdate(env, update) {
  const chatId = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? '');
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return;

  if (update.callback_query) return handleCallback(env, update.callback_query);

  const text = update.message?.text || '';
  const cmd = commandOf(text);
  if (cmd === 'all') return commandAll(env);
  if (cmd === 'stats') return commandStats(env);
  if (cmd === 'profile') return commandProfile(env, text);
  if (cmd === 'help') return commandHelp(env);
  if (text) return sendText(env, 'Не понял команду. Напишите /help');
}

/** Подключить webhook и меню команд. Вызывается через /setup. */
export async function setupTelegram(env, origin) {
  const webhook = await call(
    env,
    'setWebhook',
    {
      url: `${origin}/telegram`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    },
    { withChat: false },
  );
  const commands = await call(env, 'setMyCommands', { commands: COMMANDS }, { withChat: false });
  return { webhook: webhook.ok, commands: commands.ok };
}
