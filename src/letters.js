// Письмо арендодателю на немецком (с переводом) по данным квартиры и профиля пользователя.
// Профиль (имя, возраст, телефон) пользователь задаёт сам командой /profile; хранится в KV: profile.

export async function loadProfile(env) {
  return (await env.STATE.get('profile', 'json')) || null;
}

export function saveProfile(env, profile) {
  return env.STATE.put('profile', JSON.stringify(profile));
}

/** «/profile Имя Фамилия; 25; +49 151 ...; Nichtraucher, keine Haustiere» → профиль или null. */
export function parseProfile(text) {
  const body = text.replace(/^\/profile(@\w+)?/i, '').trim();
  const [name, age, phone, extra] = body.split(';').map((s) => (s || '').trim());
  if (!name) return null;
  return { name, age: /^\d{2}$/.test(age) ? age : null, phone: phone || null, extra: extra || null };
}

function num(value) {
  return String(value).replace('.', ',');
}

function flatDescription(m) {
  const parts = [];
  if (m.rooms) parts.push(`${num(m.rooms)}-Zimmer-Wohnung`);
  else parts.push('Wohnung');
  if (m.size) parts.push(`(${num(m.size)} m²)`);
  return parts.join(' ');
}

function flatDescriptionRu(m) {
  const parts = [m.rooms ? `${num(m.rooms)}-комнатная квартира` : 'квартира'];
  if (m.size) parts.push(`(${num(m.size)} м²)`);
  return parts.join(' ');
}

/** «in Rostock-Schmarl (Hundsburgallee 8)»: район и улица, если они известны. */
function where(m) {
  const street = (m.address || '').split(',')[0].trim();
  const hasStreet = street && !/^\d{5}/.test(street) && !/Rostock/.test(street);
  const place = m.district ? `in Rostock-${m.district}` : 'in Rostock';
  return hasStreet ? `${place} (${street})` : place;
}

/**
 * Короткое нейтральное письмо с просьбой о просмотре, адаптированное под объявление:
 * комнаты, площадь, район и улица; вопрос о Nebenkosten — только если они не указаны.
 * @returns {{ subject: string, de: string, ru: string, missingProfile: boolean }}
 */
export function buildLetter(m, profile) {
  const p = profile || { name: '[Ihr Name]', age: null, phone: null, extra: null };
  const askNk = m.nk == null && m.warm == null;

  const de = [
    'Guten Tag,',
    '',
    `ich interessiere mich sehr für Ihre ${flatDescription(m)} ${where(m)} und würde sie mir gerne persönlich anschauen. ` +
      'Wäre eine Besichtigung möglich? Ich würde mich über einen Terminvorschlag freuen.',
    askNk ? '\nKönnten Sie mir außerdem kurz mitteilen, wie hoch die Nebenkosten und die Heizkosten sind?' : null,
    p.extra ? `\n${p.extra.replace(/\.+$/, '')}.` : null,
    '',
    'Vielen Dank im Voraus!',
    '',
    'Mit freundlichen Grüßen',
    p.name,
    p.phone || null,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const ru = [
    'Добрый день,',
    `меня очень заинтересовала ваша ${flatDescriptionRu(m)}, и я хотел бы посмотреть её лично. ` +
      'Возможен ли просмотр? Буду рад, если вы предложите время.',
    askNk ? 'Не могли бы вы также сообщить, сколько составляют Nebenkosten и отопление?' : null,
    'Заранее спасибо!',
    `С уважением, ${p.name}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject: `Anfrage zur Wohnung ${where(m)}`, de, ru, missingProfile: !profile };
}
