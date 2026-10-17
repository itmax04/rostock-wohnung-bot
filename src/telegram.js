// Отправка сообщений в Telegram.

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Вызов Bot API. chat_id и HTML-разметка подставляются, если метод их принимает. */
export async function call(env, method, payload, { withChat = true } = {}) {
  const body = withChat ? { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: 'HTML', ...payload } : payload;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data;
}

export function sendText(env, text, extra = {}) {
  return call(env, 'sendMessage', { text, link_preview_options: { is_disabled: true }, ...extra });
}

/** Объявление с фото и кнопками. Если фото не загрузилось, отправляем просто текст. */
export async function sendListing(env, text, image, replyMarkup) {
  const markup = replyMarkup ? { reply_markup: replyMarkup } : {};
  if (image) {
    try {
      return await call(env, 'sendPhoto', { photo: image, caption: text, ...markup });
    } catch {
      // Telegram не смог скачать картинку — не страшно.
    }
  }
  return call(env, 'sendMessage', { text, link_preview_options: { is_disabled: false }, ...markup });
}

export function answerCallback(env, callbackQueryId, text) {
  return call(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text }, { withChat: false });
}

export function editButtons(env, chatId, messageId, replyMarkup) {
  return call(
    env,
    'editMessageReplyMarkup',
    { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup },
    { withChat: false },
  );
}
