// ============================================================
// КОНФИГУРАЦИЯ — редактируйте только этот файл
// ============================================================
window.CONFIG = {
  // ID Google Таблицы (из URL: /spreadsheets/d/{ID}/edit)
  SHEET_ID: "1GxLJLYc5cToei0XRwlXvpcAxwycXcCMNnWgcRypen78",

  // ID папки Google Drive (из URL: /drive/folders/{ID})
  DRIVE_FOLDER_ID: "1vduBNHsuhBdIzc2qFDtSwlNsawWTn-fC",

  // Ваш API ключ Google Cloud (нужен для Drive API)
  // Инструкция: см. README.md → Шаг 3
  GOOGLE_API_KEY: "AIzaSyCO2HhyYJTsm94dGOETxHchRdqIr2_Z0o8",

  // Интервал автообновления данных (миллисекунды). 5 мин = 300 000
  REFRESH_INTERVAL_MS: 5 * 60 * 1000,

  // Дата доступности по умолчанию (если не указана в таблице)
  DEFAULT_AVAILABLE_DATE: "25 апреля 2026",

  // Символ валюты
  CURRENCY_SYMBOL: "฿",

  // Локация и дата мероприятия (отображается в шапке)
  EVENT_DATE: "25 апреля 2026",
  EVENT_LOCATION: "Хуахин, Таиланд",

  // Минимальный интервал между обновлениями при переключении вкладки (сек)
  MIN_REFRESH_GAP_MS: 30 * 1000,
};
