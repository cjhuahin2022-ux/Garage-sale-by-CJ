/**
 * photo-recognition.gs
 * =====================
 * Google Apps Script для автоматического распознавания фотографий
 * и переименования файлов в Google Drive.
 *
 * КАК УСТАНОВИТЬ:
 * 1. Откройте Google Таблицу
 * 2. Extensions (Расширения) → Apps Script
 * 3. Вставьте весь этот код в редактор
 * 4. Укажите GEMINI_API_KEY и DRIVE_FOLDER_ID ниже
 * 5. Нажмите "Сохранить" (Ctrl+S)
 * 6. Запустите функцию setupTrigger() один раз (она создаёт hourly триггер)
 * 7. В таблице появится меню "📸 Фото" — через него можно запустить вручную
 *
 * ФОРМАТ ПЕРЕИМЕНОВАНИЯ:
 * Старое имя: "photo_2025.jpg"
 * Новое имя:  "01-003-iphone-13-pro.jpg"
 *              ^^ ^^^ ^^^^^^^^^^^^^^^^
 *              |  |   Название товара (транслит)
 *              |  Номер товара (3 цифры)
 *              Код категории (2 цифры)
 */

// ============================================================
// НАСТРОЙКИ — заполните перед запуском
// ============================================================

/** Бесплатный ключ: aistudio.google.com → Получить ключ API */
var GEMINI_API_KEY = "AIzaSyDN_wViAMFzBEkAzVnq4iE_xsjTWJqTHgc";

/** ID папки Google Drive (из URL папки) */
var DRIVE_FOLDER_ID = "1vduBNHsuhBdIzc2qFDtSwlNsawWTn-fC";

/** Название листа с товарами */
var ITEMS_SHEET_NAME = "Sheet1";

/** Название листа для лога (создастся автоматически) */
var LOG_SHEET_NAME = "Photo Log";

/** Максимальный размер изображения для Gemini (в байтах). 4MB */
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// ============================================================
// МЕНЮ В GOOGLE SHEETS
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("📸 Фото")
    .addItem("Распознать и переименовать новые фото", "autoRenamePhotos")
    .addSeparator()
    .addItem("Настроить автозапуск (раз в час)", "setupTrigger")
    .addItem("Удалить автозапуск", "removeTrigger")
    .addToUi();
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ
// ============================================================

function autoRenamePhotos() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = getOrCreateLogSheet(ss);

  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
    logSheet.appendRow([new Date(), "—", "❌ НЕТ КЛЮЧА", "Gemini API ключ не установлен. Укажите GEMINI_API_KEY в начале скрипта."]);
    SpreadsheetApp.getActiveSpreadsheet().toast("Укажите GEMINI_API_KEY в скрипте", "⚠️ Ключ не установлен", 10);
    SpreadsheetApp.getUi().alert(
      "⚠️ Укажите GEMINI_API_KEY в начале скрипта.\n\n" +
      "Получите бесплатный ключ на aistudio.google.com"
    );
    return;
  }

  var items = loadItems(ss);

  if (items.length === 0) {
    logSheet.appendRow([new Date(), "—", "❌ НЕТ ТОВАРОВ", "Товары не найдены. Добавьте строки в таблицу (Sheet1)."]);
    Logger.log("Товары не найдены в таблице.");
    return;
  }

  var folder;
  try {
    folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  } catch (e) {
    logSheet.appendRow([new Date(), "—", "❌ ОШИБКА DRIVE", e.message]);
    SpreadsheetApp.getUi().alert("❌ Не удалось открыть папку Drive: " + e.message);
    return;
  }

  var files = folder.getFiles();
  var processed = 0;
  var renamed = 0;
  var skipped = 0;
  var errors = 0;

  while (files.hasNext()) {
    var file = files.next();

    // Пропускаем не-изображения
    if (!file.getMimeType().startsWith("image/")) continue;

    // Пропускаем уже переименованные файлы (формат: NN-NNN-*)
    if (/^\d{2}-\d{3}-/.test(file.getName())) {
      skipped++;
      continue;
    }

    processed++;
    Logger.log("Обрабатываю: " + file.getName());

    try {
      var matchedItem = recognizePhoto(file, items);

      if (!matchedItem) {
        logResult(logSheet, file.getName(), file.getName(), null, false, "Не удалось определить товар");
        errors++;
        continue;
      }

      var newName = buildFilename(matchedItem, file.getName());
      var oldName = file.getName();
      file.setName(newName);

      Logger.log("Переименован: " + oldName + " → " + newName);
      logResult(logSheet, oldName, oldName, newName, true, "OK · Товар #" + matchedItem.no + " · " + matchedItem.name);
      renamed++;

    } catch (e) {
      Logger.log("Ошибка при обработке " + file.getName() + ": " + e.message);
      logResult(logSheet, file.getName(), file.getName(), null, false, "Ошибка: " + e.message);
      errors++;
    }

    // Небольшая пауза чтобы не превысить лимиты API
    Utilities.sleep(500);
  }

  var summary =
    "✅ Готово!\n\n" +
    "Обработано: " + processed + "\n" +
    "Переименовано: " + renamed + "\n" +
    "Пропущено (уже в формате): " + skipped + "\n" +
    "Ошибок: " + errors;

  Logger.log(summary);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    "Переименовано: " + renamed + " | Ошибок: " + errors,
    "📸 Распознавание фото завершено",
    10
  );
}

// ============================================================
// РАСПОЗНАВАНИЕ ФОТО ЧЕРЕЗ GEMINI VISION
// ============================================================

function recognizePhoto(file, items) {
  var blob = file.getBlob();

  // Проверяем размер файла
  if (blob.getBytes().length > MAX_IMAGE_BYTES) {
    Logger.log("Файл слишком большой: " + file.getName() + " (" + blob.getBytes().length + " байт)");
    // Пробуем продолжить с оригиналом (Gemini обычно справляется)
  }

  var base64Image = Utilities.base64Encode(blob.getBytes());
  var mimeType = blob.getContentType();

  var prompt = buildPrompt(items);

  var payload = {
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Image
          }
        },
        {
          text: prompt
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 20
    }
  };

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + GEMINI_API_KEY;

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();

  if (responseCode !== 200) {
    var errBody = response.getContentText();
    throw new Error("Gemini API вернул код " + responseCode + ": " + errBody.substring(0, 200));
  }

  var data = JSON.parse(response.getContentText());

  // Извлекаем ответ
  var candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    Logger.log("Gemini не вернул ответа для: " + file.getName());
    return null;
  }

  var text = candidates[0].content.parts[0].text.trim();
  Logger.log("Gemini ответил: " + text + " для файла: " + file.getName());

  // Gemini должен вернуть только номер товара
  var numMatch = text.match(/\d+/);
  if (!numMatch) return null;

  var itemNo = String(parseInt(numMatch[0], 10));
  if (itemNo === "0") return null;

  // Ищем товар с этим номером
  var matched = items.filter(function(i) { return i.no === itemNo; })[0];
  return matched || null;
}

// ============================================================
// ПРОМПТ ДЛЯ GEMINI
// ============================================================

function buildPrompt(items) {
  var itemsList = items.map(function(i) {
    return i.no + ": " + i.name + " [" + i.category + "]";
  }).join("\n");

  return (
    "You are a product identification assistant for a garage sale.\n" +
    "Look at this photo and identify which item from the list below is shown.\n\n" +
    "ITEM LIST:\n" +
    itemsList + "\n\n" +
    "INSTRUCTIONS:\n" +
    "- Return ONLY the item number (the number before the colon)\n" +
    "- If you cannot identify any item from the list, return: 0\n" +
    "- Do not explain, do not add any text — just the number\n\n" +
    "ITEM NUMBER:"
  );
}

// ============================================================
// ФОРМИРОВАНИЕ НОВОГО ИМЕНИ ФАЙЛА
// ============================================================

function buildFilename(item, originalName) {
  var ext = originalName.match(/\.[^.]+$/);
  ext = ext ? ext[0].toLowerCase() : ".jpg";

  var catCode = getCategoryCode(item.category);
  var itemNum = String(item.no).padStart(3, "0");
  var slug = buildSlug(item.name);

  return catCode + "-" + itemNum + "-" + slug + ext;
}

function getCategoryCode(categoryStr) {
  if (!categoryStr) return "12";
  // Новый формат: "01 · Электроника"
  var match = categoryStr.match(/^(\d{2})\s*[·•]/);
  if (match) return match[1];
  // Запасной: возвращаем "12" (Прочее)
  return "12";
}

/** Транслитерация кириллицы в латиницу */
function buildSlug(name) {
  var translit = {
    "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh",
    "з":"z","и":"i","й":"j","к":"k","л":"l","м":"m","н":"n","о":"o",
    "п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"kh","ц":"ts",
    "ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu",
    "я":"ya"
  };

  var result = name.toLowerCase().split("").map(function(ch) {
    return translit[ch] !== undefined ? translit[ch] : ch;
  }).join("");

  return result
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40) || "item";
}

// ============================================================
// ЗАГРУЗКА ТОВАРОВ ИЗ ТАБЛИЦЫ
// ============================================================

function loadItems(ss) {
  var sheet;
  try {
    sheet = ss.getSheetByName(ITEMS_SHEET_NAME) || ss.getSheets()[0];
  } catch (e) {
    return [];
  }

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  // Заголовки из первой строки
  var headers = data[0].map(function(h) {
    return String(h).toLowerCase().trim().replace(/\s+/g, "_");
  });

  var items = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var obj = {};
    headers.forEach(function(h, idx) {
      obj[h] = String(row[idx] || "").trim();
    });

    var no = (obj["no"] || obj["#"] || String(i)).trim();
    var name = (obj["name"] || obj["название"] || "").trim();
    var category = (obj["category"] || obj["категория"] || "12 · Прочее").trim();

    if (!name || !no) continue;

    items.push({ no: no, name: name, category: category });
  }

  return items;
}

// ============================================================
// ЛОГ РЕЗУЛЬТАТОВ
// ============================================================

function getOrCreateLogSheet(ss) {
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow([
      "Дата и время",
      "Исходное имя",
      "Новое имя",
      "Успех",
      "Комментарий"
    ]);
    // Форматирование заголовка
    var header = sheet.getRange(1, 1, 1, 5);
    header.setFontWeight("bold");
    header.setBackground("#E85D26");
    header.setFontColor("#FFFFFF");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function logResult(logSheet, originalName, oldName, newName, success, comment) {
  logSheet.appendRow([
    new Date(),
    originalName,
    newName || "—",
    success ? "✅" : "❌",
    comment || ""
  ]);
}

// ============================================================
// ТРИГГЕРЫ (АВТОЗАПУСК)
// ============================================================

/**
 * Запустите эту функцию один раз для настройки hourly автозапуска.
 * После запуска: скрипт будет автоматически проверять папку каждый час.
 */
function setupTrigger() {
  // Удаляем старые триггеры этой функции
  removeTrigger();

  ScriptApp.newTrigger("autoRenamePhotos")
    .timeBased()
    .everyHours(1)
    .create();

  SpreadsheetApp.getActiveSpreadsheet().toast(
    "Автозапуск настроен: раз в час",
    "✅ Триггер создан",
    5
  );
  Logger.log("Hourly триггер для autoRenamePhotos создан.");
}

function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "autoRenamePhotos") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
