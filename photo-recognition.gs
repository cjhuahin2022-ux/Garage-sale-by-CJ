/**
 * photo-recognition.gs  v2
 * ========================
 * Полный автоматический pipeline:
 *   1. Находит новые фото в Google Диске
 *   2. Отправляет каждое в Gemini Vision → получает: название (RU), категория, рыночная цена, поисковый запрос
 *   3. Определяет, одно ли это фото с уже известным товаром (дедупликация по совпадению слов)
 *   4. Для новых товаров создаёт строку в Лист1: name, category, price (75%), available_at, link_on_web
 *   5. Переименовывает файл: 02-003-kholodilnik-samsung.jpg
 *   6. Несколько фото одного товара → одна строка в таблице, разные имена файлов
 *
 * УСТАНОВКА:
 *   1. Google Таблица → Расширения → Apps Script
 *   2. Вставить весь этот код
 *   3. Указать GEMINI_API_KEY ниже
 *   4. Сохранить (Ctrl+S)
 *   5. Запустить setupTrigger() один раз
 */

// ============================================================
// НАСТРОЙКИ
// ============================================================

var GEMINI_API_KEY  = "AIzaSyDN_wViAMFzBEkAzVnq4iE_xsjTWJqTHgc";
var DRIVE_FOLDER_ID = "1vduBNHsuhBdIzc2qFDtSwlNsawWTn-fC";
var ITEMS_SHEET_NAME = "Лист1";   // название листа с товарами (или Sheet1)
var LOG_SHEET_NAME   = "Photo Log";
var DEFAULT_DATE     = "25 апреля 2026";
var SALE_DISCOUNT    = 0.75;      // 75% от рыночной цены
var MAX_PHOTOS_PER_RUN = 10;      // лимит фото за один запуск (защита от превышения квоты)

// ============================================================
// МЕНЮ
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("📸 Фото")
    .addItem("Обработать новые фото", "autoRenamePhotos")
    .addSeparator()
    .addItem("Настроить автозапуск (раз в час)", "setupTrigger")
    .addItem("Удалить автозапуск", "removeTrigger")
    .addToUi();
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ
// ============================================================

function autoRenamePhotos() {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet  = getOrCreateLogSheet(ss);

  // Проверка ключа
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
    logSheet.appendRow([new Date(), "—", "❌ НЕТ КЛЮЧА",
      "Gemini API ключ не установлен. Укажите GEMINI_API_KEY."]);
    SpreadsheetApp.getUi().alert("⚠️ Укажите GEMINI_API_KEY в начале скрипта.");
    return;
  }

  // Получаем / создаём лист с товарами
  var itemsSheet = getOrCreateItemsSheet(ss);

  // Загружаем уже существующие товары (для дедупликации)
  var existingItems = loadItems(ss);
  var nextNo        = getNextItemNo(existingItems);

  // Открываем папку Drive
  var folder;
  try {
    folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  } catch (e) {
    logSheet.appendRow([new Date(), "—", "❌ DRIVE", e.message]);
    SpreadsheetApp.getUi().alert("❌ Не удалось открыть папку Drive:\n" + e.message);
    return;
  }

  // Собираем необработанные файлы (не совпадают с форматом NN-NNN-*)
  var unprocessed = [];
  var iter = folder.getFiles();
  while (iter.hasNext()) {
    var f = iter.next();
    if (!f.getMimeType().startsWith("image/")) continue;
    if (/^\d{2}-\d{3}-/.test(f.getName())) continue;
    unprocessed.push(f);
  }

  if (unprocessed.length === 0) {
    ss.toast("Новых фото не найдено", "📸 Готово", 5);
    logResult(logSheet, "—", "—", "—", true, "Запуск завершён — нет новых файлов");
    return;
  }

  // Ограничиваем количество фото за один запуск
  var batch = unprocessed.slice(0, MAX_PHOTOS_PER_RUN);
  var remaining = unprocessed.length - batch.length;

  logResult(logSheet, "—", "—", "—", true,
    "▶ Начало обработки. Найдено новых фото: " + unprocessed.length +
    (remaining > 0 ? ". Обрабатываем первые " + MAX_PHOTOS_PER_RUN + " (осталось ещё: " + remaining + ")" : ""));

  // -------------------------------------------------------
  // Фаза 1: Анализ каждого фото через Gemini
  // -------------------------------------------------------
  var entries = [];   // [{file, analysis}]

  for (var i = 0; i < batch.length; i++) {
    var file = batch[i];
    Logger.log("Анализирую (" + (i+1) + "/" + batch.length + "): " + file.getName());

    var analysis = null;
    try {
      analysis = analyzePhoto(file);
      logResult(logSheet, file.getName(), "—", "—", true,
        "Распознано: " + analysis.name + " | " + analysis.category +
        " | рынок: ฿" + analysis.market_price_thb);
    } catch (e) {
      logResult(logSheet, file.getName(), "—", "—", false,
        "Ошибка Gemini: " + e.message);
    }

    entries.push({ file: file, analysis: analysis, assigned: null, photoIndex: 1 });

    // Пауза: бесплатный Gemini — 10 запросов/мин (6с между запросами)
    if (i < batch.length - 1) Utilities.sleep(6000);
  }

  // -------------------------------------------------------
  // Фаза 2: Дедупликация и назначение номеров
  // -------------------------------------------------------
  var sessionItems   = [];   // новые товары, созданные в этом запуске
  var photoCountMap  = {};   // itemNo → кол-во фото назначено в этом запуске

  for (var j = 0; j < entries.length; j++) {
    var entry = entries[j];
    if (!entry.analysis) continue;

    var name = entry.analysis.name;

    // Ищем совпадение среди существующих и новых
    var match = findSimilarItem(name, existingItems) ||
                findSimilarItem(name, sessionItems);

    if (match) {
      entry.assigned = match;
      logResult(logSheet, entry.file.getName(), "—", "—", true,
        "Совпадает с существующим товаром #" + match.no + " \"" + match.name + "\"");
    } else {
      // Новый товар
      var salePrice = Math.round((entry.analysis.market_price_thb || 0) * SALE_DISCOUNT / 100) * 100;
      var link      = buildSearchLink(entry.analysis.search_query || name);
      var newItem   = {
        no:           String(nextNo++),
        name:         entry.analysis.name,
        category:     entry.analysis.category || "12 · Прочее",
        price:        salePrice,
        available_at: DEFAULT_DATE,
        link_on_web:  link,
        isNew:        true
      };
      sessionItems.push(newItem);
      entry.assigned = newItem;
    }

    // Счётчик фото для этого товара в текущем запуске
    var no = entry.assigned.no;
    photoCountMap[no] = (photoCountMap[no] || 0) + 1;
    entry.photoIndex = photoCountMap[no];
  }

  // -------------------------------------------------------
  // Фаза 3: Записываем новые товары в таблицу
  // -------------------------------------------------------
  for (var k = 0; k < sessionItems.length; k++) {
    var item = sessionItems[k];
    itemsSheet.appendRow([
      item.no,
      item.name,
      item.category,
      item.price,
      item.available_at,
      item.link_on_web
    ]);
    logResult(logSheet, "—", "—", "строка добавлена", true,
      "Товар #" + item.no + ": " + item.name + " | ฿" + item.price + " | " + item.category);
  }

  // -------------------------------------------------------
  // Фаза 4: Переименовываем файлы
  // -------------------------------------------------------
  var renamed = 0;
  var errors  = 0;

  for (var m = 0; m < entries.length; m++) {
    var entry = entries[m];
    if (!entry.assigned) { errors++; continue; }

    try {
      var oldName = entry.file.getName();
      var newName = buildFilename(entry.assigned, oldName, entry.photoIndex);
      entry.file.setName(newName);
      logResult(logSheet, oldName, oldName, newName, true,
        "Товар #" + entry.assigned.no + " | фото " + entry.photoIndex);
      renamed++;
    } catch (e) {
      logResult(logSheet, entry.file.getName(), "—", "—", false,
        "Ошибка переименования: " + e.message);
      errors++;
    }
  }

  var summary = "Новых товаров: " + sessionItems.length +
                " | Переименовано: " + renamed +
                " | Ошибок: " + errors;

  logResult(logSheet, "—", "—", "—", true, "✅ Завершено — " + summary);
  ss.toast(summary, "📸 Обработка завершена", 15);
  Logger.log("Завершено: " + summary);
}

// ============================================================
// АНАЛИЗ ФОТО ЧЕРЕЗ GEMINI VISION
// ============================================================

function analyzePhoto(file) {
  var blob       = file.getBlob();
  var base64Img  = Utilities.base64Encode(blob.getBytes());
  var mimeType   = blob.getContentType() || "image/jpeg";

  var prompt =
    "You are analyzing items for a garage sale in Hua Hin, Thailand.\n\n" +
    "Look at this photo carefully. Respond ONLY with a valid JSON object — no markdown, no extra text.\n\n" +
    "{\n" +
    "  \"name\": \"Название товара на русском языке (конкретное, с брендом/моделью если видно)\",\n" +
    "  \"category\": \"точный код из списка: 01 · Электроника, 02 · Бытовая техника, 03 · Мебель, " +
    "04 · Одежда и аксессуары, 05 · Детские товары, 06 · Спорт и активный отдых, " +
    "07 · Транспорт, 08 · Декор и интерьер, 09 · Кухня и посуда, " +
    "10 · Книги и медиа, 11 · Инструменты и стройка, 12 · Прочее\",\n" +
    "  \"market_price_thb\": цена нового аналогичного товара в тайских батах (только число, без текста),\n" +
    "  \"search_query\": \"English search query to find this item on Lazada Thailand\"\n" +
    "}";

  var payload = {
    contents: [{
      parts: [
        { inlineData: { mimeType: mimeType, data: base64Img } },
        { text: prompt }
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
  };

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=" + GEMINI_API_KEY;

  var res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error("Gemini HTTP " + res.getResponseCode() + ": " + res.getContentText().substring(0, 200));
  }

  var data = JSON.parse(res.getContentText());
  if (!data.candidates || !data.candidates[0]) {
    throw new Error("Gemini вернул пустой ответ");
  }

  var text = data.candidates[0].content.parts[0].text.trim();

  // Убираем markdown-обёртку если есть (```json ... ```)
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    var parsed = JSON.parse(text);
    // Нормализуем поля
    parsed.name              = String(parsed.name || "Товар").trim();
    parsed.category          = String(parsed.category || "12 · Прочее").trim();
    parsed.market_price_thb  = parseInt(parsed.market_price_thb, 10) || 0;
    parsed.search_query      = String(parsed.search_query || parsed.name).trim();
    return parsed;
  } catch (parseErr) {
    throw new Error("Не удалось разобрать ответ Gemini: " + text.substring(0, 200));
  }
}

// ============================================================
// ДЕДУПЛИКАЦИЯ
// ============================================================

/**
 * Возвращает товар из списка если название достаточно совпадает.
 * Критерий: ≥ 2 значимых слова (>3 символов) совпадают И их доля ≥ 50%.
 */
function findSimilarItem(name, items) {
  var normName  = normalize(name);
  var words1    = significantWords(normName);
  if (words1.length === 0) return null;

  var bestItem  = null;
  var bestScore = 0;

  for (var i = 0; i < items.length; i++) {
    var words2  = significantWords(normalize(items[i].name));
    if (words2.length === 0) continue;

    var common  = words1.filter(function(w) { return words2.indexOf(w) >= 0; });
    var score   = common.length / Math.min(words1.length, words2.length);

    if (common.length >= 2 && score >= 0.5 && score > bestScore) {
      bestScore = score;
      bestItem  = items[i];
    }
  }

  return bestItem;
}

function normalize(str) {
  return str.toLowerCase().replace(/[^a-zа-яё0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function significantWords(str) {
  return str.split(" ").filter(function(w) { return w.length > 3; });
}

// ============================================================
// ФОРМИРОВАНИЕ ИМЕНИ ФАЙЛА
// ============================================================

function buildFilename(item, originalName, photoIndex) {
  var ext     = originalName.match(/\.[^.]+$/);
  ext         = ext ? ext[0].toLowerCase() : ".jpg";
  var catCode = getCategoryCode(item.category);
  var itemNum = String(item.no).padStart(3, "0");
  var slug    = buildSlug(item.name);

  // Первое фото: без суффикса. Дополнительные: -2, -3, ...
  // Используем timestamp хвост для уникальности при повторном запуске
  var suffix = "";
  if (photoIndex > 1) {
    suffix = "-" + new Date().getTime().toString().slice(-5);
  }

  return catCode + "-" + itemNum + "-" + slug + suffix + ext;
}

function getCategoryCode(categoryStr) {
  if (!categoryStr) return "12";
  var m = categoryStr.match(/^(\d{2})\s*[·•]/);
  return m ? m[1] : "12";
}

function buildSlug(name) {
  var t = {
    "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh",
    "з":"z","и":"i","й":"j","к":"k","л":"l","м":"m","н":"n","о":"o",
    "п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"kh","ц":"ts",
    "ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"
  };
  return name.toLowerCase().split("").map(function(c) {
    return t[c] !== undefined ? t[c] : c;
  }).join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40) || "item";
}

// ============================================================
// ССЫЛКА НА МАРКЕТПЛЕЙС
// ============================================================

function buildSearchLink(query) {
  // Lazada Thailand — самый популярный маркетплейс в Таиланде
  return "https://www.lazada.co.th/catalog/?q=" + encodeURIComponent(query);
}

// ============================================================
// РАБОТА С ТАБЛИЦЕЙ
// ============================================================

function getOrCreateItemsSheet(ss) {
  // Пробуем найти лист по имени, потом берём первый
  var sheet = ss.getSheetByName(ITEMS_SHEET_NAME) ||
              ss.getSheetByName("Sheet1") ||
              ss.getSheets()[0];

  // Если лист пустой — добавляем заголовки
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["no", "name", "category", "price", "available_at", "link_on_web"]);
    var hdr = sheet.getRange(1, 1, 1, 6);
    hdr.setFontWeight("bold");
    hdr.setBackground("#E85D26");
    hdr.setFontColor("#FFFFFF");
    sheet.setFrozenRows(1);
    // Ширина столбцов
    sheet.setColumnWidth(2, 220);
    sheet.setColumnWidth(3, 200);
    sheet.setColumnWidth(6, 300);
  }

  return sheet;
}

function loadItems(ss) {
  var sheet = ss.getSheetByName(ITEMS_SHEET_NAME) ||
              ss.getSheetByName("Sheet1") ||
              ss.getSheets()[0];

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = data[0].map(function(h) {
    return String(h).toLowerCase().trim().replace(/\s+/g, "_");
  });

  var items = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var obj = {};
    headers.forEach(function(h, idx) { obj[h] = String(row[idx] || "").trim(); });
    var no   = (obj["no"] || String(i)).trim();
    var name = (obj["name"] || "").trim();
    var cat  = (obj["category"] || "12 · Прочее").trim();
    if (!name) continue;
    items.push({ no: no, name: name, category: cat });
  }
  return items;
}

function getNextItemNo(existingItems) {
  var max = 0;
  existingItems.forEach(function(i) {
    var n = parseInt(i.no, 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return max + 1;
}

// ============================================================
// ЛОГ
// ============================================================

function getOrCreateLogSheet(ss) {
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(["Дата и время", "Исходное имя", "Новое имя", "Успех", "Комментарий"]);
    var hdr = sheet.getRange(1, 1, 1, 5);
    hdr.setFontWeight("bold");
    hdr.setBackground("#E85D26");
    hdr.setFontColor("#FFFFFF");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(5, 400);
  }
  return sheet;
}

function logResult(logSheet, original, oldName, newName, success, comment) {
  logSheet.appendRow([new Date(), original, newName || "—", success ? "✅" : "❌", comment || ""]);
}

// ============================================================
// ТРИГГЕРЫ
// ============================================================

function setupTrigger() {
  removeTrigger();
  ScriptApp.newTrigger("autoRenamePhotos").timeBased().everyHours(1).create();
  SpreadsheetApp.getActiveSpreadsheet().toast("Автозапуск: раз в час", "✅ Триггер создан", 5);
  Logger.log("Hourly триггер для autoRenamePhotos создан.");
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "autoRenamePhotos") ScriptApp.deleteTrigger(t);
  });
}
