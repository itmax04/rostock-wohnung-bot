// Все настройки поиска в одном месте.

// Главный критерий — официальный порог Hanse-Jobcenter Rostock для 1 человека
// (таблица города от 01.01.2024): Kaltmiete + Nebenkosten без отопления (Bruttokalt) ≤ 481,80 €.
// Отопление Jobcenter платит отдельно: для 45 м² с Fernwärme норма ≈ 79 € в месяц.
export const SEARCH = {
  bruttokaltLimit: 481.8,
  heatingAllowance: 79, // ≈ 45 м² × 21,00 €/м² в год (Fernwärme) / 12
  // Если сайт показывает только сумму с отоплением (WIRO): 481,80 + 79.
  maxWarm: 560.8,
  // Когда Nebenkosten не указаны: отбираем с оптимистичной оценкой, чтобы не потерять квартиру
  // с низкими NK, а в сообщении показываем обычную оценку и 🟡.
  optimisticNkPerSqm: 1.8,
  // Когда не указаны ни NK, ни площадь.
  fallbackMaxKalt: 400,
};

export const JOBCENTER = {
  bruttokaltLimit: SEARCH.bruttokaltLimit,
  nebenkostenPerSqm: 2.3, // обычная оценка Nebenkosten для сообщения
  // Норма отопления, € за м² в год (Bundesheizspiegel 2023, центральная горячая вода).
  heatingPerSqmYear: { Fernwärme: 21.0, Erdgas: 30.4, Gas: 30.4, Heizöl: 28.8, Öl: 28.8 },
  defaultHeatingPerSqmYear: 21.0,
};

// Приоритет — только для порядка и пометки ⭐ в сообщениях, на отбор не влияет.
export const PRIORITY_DISTRICTS = [
  'Reutershagen',
  'Evershagen',
  'Hansaviertel',
  'Südstadt',
  'Brinckmansdorf',
  'Gartenstadt',
  'Stadtweide',
  'Stadtmitte',
];
export const PRIORITY_ROOMS = 2;

// Почтовые индексы города Росток. Kleinanzeigen добавляет объявления из пригородов (Bützow и т.п.);
// ищем в городе Росток, где действуют нормативы Hanse-Jobcenter Rostock.
export const ROSTOCK_ZIPS = ['18055', '18057', '18059', '18069', '18106', '18107', '18109', '18119', '18146', '18147'];

// Не квартиры в аренду: жильё для монтажников, обмен квартир, комнаты в WG и т.п.
export const BLACKLIST = [
  'Monteur',
  'Tauschwohnung',
  'Tauschangebot',
  'Wohnungstausch',
  'WG-Zimmer',
  'WG Zimmer',
  'Zimmer in WG',
  'Wohngemeinschaft',
  'Mitbewohner',
  'Senioren',
  'Ferienwohnung',
  'Zwischenmiete',
  'vollmöbliert',
  'Studentenwohnheim',
  'nur für Studenten',
  'nur für Studierende',
  'ambulant betreut',
  'betreutes Wohnen',
  'Servicewohnen',
  'Pflegeheim',
  'Pflegeplatz',
  'Wohnen auf Zeit',
  'für einen Monat',
  'Eventraum',
];

// Признаки возможного мошенничества.
export const SCAM_WORDS = [
  'Vorkasse',
  'Western Union',
  'MoneyGram',
  'Kaution vorab',
  'Schlüssel per Post',
  'Schlüsselübergabe per Post',
  'Airbnb',
  'im Ausland',
  'WhatsApp',
];
export const SCAM_MIN_PRICE_PER_SQM = 5; // € Kaltmiete за м², ниже — подозрительно для Ростока

// Сколько часов источник может отдавать 0 объявлений, прежде чем считать это сбоем.
export const ZERO_RESULTS_ALERT_HOURS = 3;

// Ежедневный отчёт (время Берлина).
export const DAILY_REPORT_HOUR = 21;
