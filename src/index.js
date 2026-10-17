// Rostock Wohnung Bot: каждые 10 минут проверяет порталы и присылает новые подходящие квартиры в Telegram.
//
// Источники разбиты по cron-расписаниям (см. wrangler.toml), чтобы у каждого запуска хватало
// лимита процессорного времени и сбой одного источника не мешал остальным.
// KV: state:<источник> — здоровье и статистика; matches:<источник> — присланные квартиры и их статусы.
// «Уже присылали» определяется по matches: если поменять фильтры, подходящие теперь объявления придут.

import { SOURCES } from './sources.js';
import { districtOf, rejectReason, jobcenterCheck, heatingCheck, scamSignals, priority } from './filters.js';
import { sendText, sendListing, escapeHtml } from './telegram.js';
import { loadMatches, saveMatches, toMatch, listingKeyboard } from './store.js';
import { handleUpdate, setupTelegram, activitySummary } from './commands.js';
import { ZERO_RESULTS_ALERT_HOURS, DAILY_REPORT_HOUR } from './config.js';

// Лёгкие сайты (WIRO, Neue Rostocker, FIDES) проверяются в одном запуске друг за другом.
const CRON_TO_SOURCES = {
  '*/10 * * * *': ['immoscout'],
  '3-59/10 * * * *': ['kleinanzeigen'],
  '6-59/10 * * * *': ['wiro', 'neuerostocker', 'fides'],
};
// Neue Rostocker сейчас отвечает 403 на запросы с серверов Cloudflare. Пробуем раз в час (в :06),
// а не каждые 10 минут: если блокировку снимут, бот сам начнёт присылать их квартиры.
const HOURLY_SOURCES = new Set(['neuerostocker']);
const MATCH_TTL_DAYS = 90;
// Сколько новых объявлений за запуск можно дополнительно проверить по карточке (exposé).
const MAX_ENRICH_PER_RUN = 6;
const REJECTED_TTL = 24 * 3600 * 1000;
const MAX_MESSAGES_PER_RUN = 5;
const HOUR = 3600 * 1000;

function emptyState() {
  return {
    initialized: false,
    failCount: 0,
    errorAlerted: false,
    lastError: null,
    lastOkAt: null,
    zeroSince: null,
    zeroAlerted: false,
    active: {}, // подходящие объявления, которые источник показывает прямо сейчас
    rejected: {}, // отклонённые после проверки карточки: id -> время (не проверяем повторно сутки)
    stats: { runs: 0, errors: 0, sent: 0, since: Date.now() },
  };
}

async function loadState(env, key) {
  const raw = await env.STATE.get(`state:${key}`, 'json');
  const state = { ...emptyState(), ...(raw || {}) };
  delete state.seen; // устаревшее поле прошлой версии
  return state;
}

function saveState(env, key, state) {
  return env.STATE.put(`state:${key}`, JSON.stringify(state));
}

function berlinHourMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  return { hour: get('hour'), minute: get('minute') };
}

function berlinTime(ts) {
  return ts
    ? new Date(ts).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })
    : '—';
}

function formatListing(listing, district) {
  const jc = jobcenterCheck(listing);
  const scam = scamSignals(listing);
  const facts = [
    listing.rooms != null ? `${String(listing.rooms).replace('.', ',')} Zi.` : null,
    listing.size != null ? `${String(listing.size).replace('.', ',')} m²` : null,
    listing.kalt != null ? `${listing.kalt} € kalt` : listing.warm != null ? `${listing.warm} € gesamt` : null,
  ].filter(Boolean);

  const lines = [
    priority(listing, district).label,
    `${jc.icon} <b>${escapeHtml(facts.join(' · ') || listing.title)}</b>`,
    escapeHtml(listing.title),
    `📍 ${escapeHtml(listing.address || 'адрес не указан')}`,
    `💶 ${escapeHtml(jc.text)}`,
  ];
  const heat = heatingCheck(listing);
  if (heat) lines.push(`${heat.icon} ${escapeHtml(heat.text)}`);
  if (listing.warm != null && listing.kalt != null) lines.push(`🧾 всего в месяц (Gesamtmiete): ${listing.warm} €`);
  const building = [listing.yearBuilt ? `Baujahr ${listing.yearBuilt}` : null, listing.heatingType].filter(Boolean);
  if (building.length) lines.push(`🏗 ${escapeHtml(building.join(' · '))}`);
  if (listing.deposit) lines.push(`🔑 Kaution/Anteile: ${escapeHtml(listing.deposit)} (Jobcenter может дать заём)`);
  if (listing.availableFrom) lines.push(`📅 свободна с ${escapeHtml(listing.availableFrom)}`);
  if (listing.extra) lines.push(`ℹ️ ${escapeHtml(listing.extra)}`);
  for (const s of scam) lines.push(`⚠️ <b>Осторожно:</b> ${escapeHtml(s)}`);
  lines.push(`🔗 <a href="${escapeHtml(listing.url)}">Открыть на ${escapeHtml(listing.source)}</a>`);
  return lines.join('\n');
}

async function runSource(env, key) {
  const source = SOURCES[key];
  const state = await loadState(env, key);
  const now = Date.now();
  state.stats.runs += 1;

  let listings;
  try {
    listings = await source.fetch();
  } catch (e) {
    state.failCount += 1;
    state.stats.errors += 1;
    state.lastError = String(e.message || e);
    // Одна ошибка бывает случайно, сообщаем со второй подряд.
    if (state.failCount >= 2 && !state.errorAlerted) {
      await sendText(
        env,
        `⚠️ <b>${source.name}: сбой проверки</b>\n${escapeHtml(state.lastError)}\n` +
          'Остальные источники работают. Бот продолжает пробовать каждые 10 минут.',
      ).catch(() => {});
      state.errorAlerted = true;
    }
    await saveState(env, key, state);
    return { key, error: state.lastError };
  }

  if (state.errorAlerted) {
    await sendText(env, `✅ <b>${source.name} снова работает.</b>`).catch(() => {});
  }
  state.failCount = 0;
  state.errorAlerted = false;
  state.lastError = null;
  state.lastOkAt = now;

  // Подозрительная тишина: источник отвечает, но долго без единого объявления.
  if (listings.length === 0 && source.alertOnZero) {
    state.zeroSince = state.zeroSince || now;
    if (!state.zeroAlerted && now - state.zeroSince > ZERO_RESULTS_ALERT_HOURS * HOUR) {
      await sendText(
        env,
        `⚠️ <b>${source.name}: уже ${ZERO_RESULTS_ALERT_HOURS} ч ни одного объявления.</b>\n` +
          'Возможно, сайт изменился или блокирует запросы. Стоит проверить.',
      ).catch(() => {});
      state.zeroAlerted = true;
    }
  } else if (listings.length > 0) {
    if (state.zeroAlerted) await sendText(env, `✅ <b>${source.name}: объявления снова приходят.</b>`).catch(() => {});
    state.zeroSince = null;
    state.zeroAlerted = false;
  }

  // Подходящие объявления; новые — те, которых ещё нет в matches (то есть ещё не присылали).
  const matches = await loadMatches(env, key);
  let matchesChanged = false;
  state.active = {};
  state.rejected = Object.fromEntries(Object.entries(state.rejected || {}).filter(([, ts]) => now - ts < REJECTED_TTL));
  const fresh = [];
  let enriched = 0;
  for (let listing of listings) {
    if (state.rejected[listing.id]) continue;
    // Для уже присланных берём сохранённые Nebenkosten из карточки, чтобы не проверять по оценке.
    const known = matches[listing.id];
    if (known?.nk != null) {
      listing = { ...listing, nk: known.nk, nkIncludesHeating: known.nkIncludesHeating, warm: known.warm ?? listing.warm };
    }
    // Для источников с карточкой (ImmoScout24) до загрузки NK проверяем только Kaltmiete.
    if (rejectReason(listing, { lenient: Boolean(source.enrich) && !matches[listing.id] })) continue;
    if (matches[listing.id]) {
      state.active[listing.id] = now;
      continue;
    }
    // Новое объявление: уточняем Nebenkosten и отопление по карточке, затем проверяем порог ещё раз.
    if (source.enrich) {
      if (enriched >= MAX_ENRICH_PER_RUN) continue; // проверим в следующий запуск
      enriched += 1;
      try {
        listing = await source.enrich(listing);
      } catch (e) {
        console.error('enrich failed', listing.id, e);
      }
      if (rejectReason(listing)) {
        state.rejected[listing.id] = now;
        continue;
      }
    }
    state.active[listing.id] = now;
    fresh.push({ listing, district: districtOf(listing) });
  }

  if (!state.initialized) {
    state.initialized = true;
    await sendText(
      env,
      `🤖 <b>${source.name} подключён к облачному боту.</b>\n` +
        `Сейчас подходящих объявлений: ${fresh.length}${fresh.length ? ' — присылаю ниже.' : '.'}`,
    ).catch(() => {});
  }

  // Сначала приоритетные: 2 комнаты в основном районе.
  fresh.sort((a, b) => priority(b.listing, b.district).score - priority(a.listing, a.district).score);

  // Не больше 5 сообщений за запуск; остальные придут через 10 минут.
  let sent = 0;
  for (const { listing, district } of fresh.slice(0, MAX_MESSAGES_PER_RUN)) {
    try {
      const res = await sendListing(env, formatListing(listing, district), listing.image, listingKeyboard(listing.id, listing.url));
      matches[listing.id] = toMatch(listing, district, priority(listing, district), jobcenterCheck(listing), now);
      matches[listing.id].msgId = res?.result?.message_id ?? null;
      matchesChanged = true;
      sent += 1;
    } catch (e) {
      // Не удалось отправить — попробуем в следующий раз.
      console.error('send failed', listing.id, e);
    }
  }
  state.stats.sent += sent;

  // Чистим память от очень старых квартир.
  const cutoff = now - MATCH_TTL_DAYS * 24 * HOUR;
  for (const [id, m] of Object.entries(matches)) {
    if (m.foundAt < cutoff) {
      delete matches[id];
      matchesChanged = true;
    }
  }

  if (matchesChanged) await saveMatches(env, key, matches);
  await saveState(env, key, state);
  return { key, total: listings.length, fresh: fresh.length, sent };
}

/**
 * Разово: заново прислать актуальные квартиры (проходящие текущий порог) с новыми кнопками.
 * Нужно после обновления кнопок, чтобы у старых сообщений появилось «✍️ Письмо».
 */
async function resendActive(env) {
  let sent = 0;
  await sendText(env, '🔄 <b>Обновил кнопки.</b> Присылаю актуальные квартиры заново — теперь с кнопкой «✍️ Письмо».');
  for (const key of Object.keys(SOURCES)) {
    const state = await loadState(env, key);
    const matches = await loadMatches(env, key);
    const list = Object.values(matches)
      .filter((m) => m.status !== 'rejected' && state.active?.[m.id])
      .sort((a, b) => b.score - a.score);
    for (const m of list) {
      const listing = { ...m, title: m.title, description: '', image: null };
      const res = await sendListing(env, formatListing(listing, m.district), null, listingKeyboard(m.id, m.url, m.status));
      m.msgId = res?.result?.message_id ?? m.msgId;
      sent += 1;
    }
    if (list.length) await saveMatches(env, key, matches);
  }
  return { resent: sent };
}

async function dailyReport(env) {
  const lines = ['📊 <b>Итоги дня</b>', await activitySummary(env, Date.now() - 24 * HOUR), '', '<b>Работа бота</b>'];
  let allOk = true;
  for (const key of Object.keys(SOURCES)) {
    const state = await loadState(env, key);
    const ok = state.lastOkAt && Date.now() - state.lastOkAt < 2 * HOUR;
    // Известная блокировка с облака — не считаем это поломкой бота.
    const knownBlock = !ok && HOURLY_SOURCES.has(key) && String(state.lastError).includes('403');
    if (knownBlock) {
      lines.push(`⛔ <b>${SOURCES[key].name}</b>: сайт не пускает облачные серверы, пробую раз в час.`);
      state.stats = { runs: 0, errors: 0, sent: 0, since: Date.now() };
      await saveState(env, key, state);
      continue;
    }
    allOk = allOk && ok;
    lines.push(
      `${ok ? '✅' : '❌'} <b>${SOURCES[key].name}</b>: проверок ${state.stats.runs}, ` +
        `ошибок ${state.stats.errors}, прислано ${state.stats.sent}. ` +
        `Последняя успешная: ${berlinTime(state.lastOkAt)}`,
    );
    state.stats = { runs: 0, errors: 0, sent: 0, since: Date.now() };
    await saveState(env, key, state);
  }
  lines.push(allOk ? 'Всё работает, бот продолжает следить 24/7.' : '⚠️ Есть проблемы, см. выше.');
  await sendText(env, lines.join('\n'));
}

export default {
  async scheduled(event, env) {
    const keys = CRON_TO_SOURCES[event.cron] || [];
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    for (const key of keys) {
      if (HOURLY_SOURCES.has(key) && minute >= 10) continue;
      try {
        await runSource(env, key);
      } catch (e) {
        console.error('source run failed', key, e);
      }
    }

    // Отчёт отправляет запуск ImmoScout24 в первые 10 минут нужного часа.
    if (keys.includes('immoscout')) {
      const { hour, minute } = berlinHourMinute(new Date(event.scheduledTime));
      if (hour === DAILY_REPORT_HOUR && minute < 10) await dailyReport(env);
    }
  },

  // /telegram — webhook для команд и кнопок (проверяется секрет, который знает только Telegram).
  // /setup?key=<RUN_KEY> — один раз подключить webhook и меню команд.
  // /run?key=<RUN_KEY>&source=<источник>|report — ручной запуск для проверки.
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/telegram' && request.method === 'POST') {
      if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        await handleUpdate(env, await request.json());
      } catch (e) {
        console.error('telegram update failed', e);
      }
      // Всегда 200, иначе Telegram будет повторять то же обновление.
      return new Response('ok');
    }

    const authorized = env.RUN_KEY && url.searchParams.get('key') === env.RUN_KEY;
    if (url.pathname === '/setup' && authorized) {
      return Response.json(await setupTelegram(env, url.origin));
    }
    if (url.pathname !== '/run' || !authorized) {
      return new Response('Rostock Wohnung Bot', { status: 200 });
    }
    const which = url.searchParams.get('source');
    if (which === 'resend') return Response.json(await resendActive(env));
    if (which === 'report') {
      await dailyReport(env);
      return Response.json({ report: 'sent' });
    }
    const keys = which ? [which] : Object.keys(SOURCES);
    const results = [];
    for (const key of keys) {
      if (!SOURCES[key]) return Response.json({ error: `unknown source ${key}` }, { status: 400 });
      results.push(await runSource(env, key));
    }
    return Response.json(results);
  },
};
