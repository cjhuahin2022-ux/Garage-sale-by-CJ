/**
 * Garage Sale — Хуахин
 * Главный модуль: загрузка данных, рендеринг, автообновление
 */

(function () {
  "use strict";

  // ----------------------------------------------------------------
  // Состояние приложения
  // ----------------------------------------------------------------
  let allItems = [];
  let photoMap = {};
  let currentCategory = null; // null = "Все"
  let searchQuery = "";
  let lastFetchTime = 0;
  let refreshTimer = null;

  // ----------------------------------------------------------------
  // Эмодзи для категорий
  // ----------------------------------------------------------------
  const CATEGORY_EMOJI = {
    "бытовая техника":  "🏠",
    "мебель":           "🛋️",
    "детские игрушки":  "🧸",
    "фешн":             "👗",
    "транспорт":        "🚲",
    "спортивные товары":"⚽",
    "электроника":      "📱",
    "декор":            "🖼️",
    "книги":            "📚",
    "посуда":           "🍽️",
    "инструменты":      "🔧",
    "животные":         "🐾",
    "прочее":           "📦",
  };

  function getCategoryEmoji(category) {
    if (!category) return "📦";
    const key = category.toLowerCase().trim();
    return CATEGORY_EMOJI[key] || "🏷️";
  }

  // ----------------------------------------------------------------
  // CSV-парсер (поддерживает кавычки и запятые внутри полей)
  // ----------------------------------------------------------------
  function parseCSV(text) {
    const rows = [];
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const row = [];
      let field = "";
      let inQuotes = false;

      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        if (ch === '"') {
          if (inQuotes && line[j + 1] === '"') {
            field += '"';
            j++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === "," && !inQuotes) {
          row.push(field.trim());
          field = "";
        } else {
          field += ch;
        }
      }
      row.push(field.trim());
      rows.push(row);
    }

    return rows;
  }

  // ----------------------------------------------------------------
  // Загрузка данных из Google Sheets (CSV)
  // ----------------------------------------------------------------
  async function fetchSheetData() {
    const url =
      "https://docs.google.com/spreadsheets/d/" +
      CONFIG.SHEET_ID +
      "/export?format=csv&gid=0";

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        "Не удалось загрузить таблицу. Убедитесь что таблица опубликована (File → Publish to web → CSV)."
      );
    }

    const text = await res.text();
    const rows = parseCSV(text);

    if (rows.length < 2) return [];

    // Заголовки из первой строки (приводим к нижнему регистру, убираем пробелы)
    const headers = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, "_"));

    const items = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every((cell) => !cell)) continue; // пустые строки

      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = row[idx] || "";
      });

      // Нормализуем поля
      const item = {
        no:           (obj["no"] || obj["#"] || String(i)).trim(),
        name:         (obj["name"] || obj["название"] || "").trim(),
        category:     (obj["category"] || obj["категория"] || "Прочее").trim(),
        price:        parseFloat((obj["price"] || "0").replace(/[^\d.]/g, "")) || 0,
        available_at: (obj["available_at"] || obj["available at"] || "").trim() || CONFIG.DEFAULT_AVAILABLE_DATE,
        link_on_web:  (obj["link_on_web"] || obj["link on web"] || "").trim(),
      };

      if (!item.name) continue;
      items.push(item);
    }

    return items;
  }

  // ----------------------------------------------------------------
  // Загрузка списка фото из Google Drive
  // ----------------------------------------------------------------
  async function fetchDrivePhotos() {
    if (!CONFIG.GOOGLE_API_KEY || CONFIG.GOOGLE_API_KEY === "YOUR_API_KEY_HERE") {
      console.warn("Google API ключ не указан — фото из Drive не загружены.");
      return [];
    }

    const allFiles = [];
    let pageToken = null;

    do {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set(
        "q",
        `'${CONFIG.DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`
      );
      url.searchParams.set("fields", "nextPageToken,files(id,name)");
      url.searchParams.set("key", CONFIG.GOOGLE_API_KEY);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          "Drive API ошибка: " +
            (err.error?.message || res.status) +
            ". Проверьте API ключ и доступ к папке."
        );
      }

      const data = await res.json();
      allFiles.push(...(data.files || []));
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    return allFiles;
  }

  // ----------------------------------------------------------------
  // Сопоставление фото с товарами по имени файла
  // ----------------------------------------------------------------
  function buildPhotoMap(driveFiles) {
    const map = {};

    for (const file of driveFiles) {
      // Убираем расширение
      const baseName = file.name.replace(/\.[^.]+$/, "");

      // Ищем ведущие цифры (номер товара): "1", "01", "1-холодильник", "1_name" и т.д.
      const numMatch = baseName.match(/^(\d+)/);
      if (numMatch) {
        // Нормализуем: "01" → "1"
        const num = String(parseInt(numMatch[1], 10));
        if (!map[num]) {
          // Thumbnail URL — работает для публично открытых файлов
          map[num] =
            "https://drive.google.com/thumbnail?id=" +
            file.id +
            "&sz=w600";
        }
      }
    }

    return map;
  }

  // ----------------------------------------------------------------
  // Рендеринг кнопок категорий
  // ----------------------------------------------------------------
  function renderCategories(items) {
    const nav = document.getElementById("category-nav");

    // Считаем количество товаров по категориям
    const counts = {};
    for (const item of items) {
      counts[item.category] = (counts[item.category] || 0) + 1;
    }

    const categories = Object.keys(counts).sort((a, b) => a.localeCompare(b, "ru"));

    nav.innerHTML = "";

    // Кнопка "Все"
    const allBtn = createCatButton("Все", items.length, null);
    nav.appendChild(allBtn);

    for (const cat of categories) {
      const btn = createCatButton(cat, counts[cat], cat);
      nav.appendChild(btn);
    }

    updateActiveCatButton();
  }

  function createCatButton(label, count, value) {
    const btn = document.createElement("button");
    btn.className = "cat-btn";
    btn.dataset.category = value === null ? "" : value;

    const emoji = value ? getCategoryEmoji(value) : "🏷️";

    const emojiSpan = document.createElement("span");
    emojiSpan.textContent = emoji;

    const textSpan = document.createElement("span");
    textSpan.textContent = label;

    const countSpan = document.createElement("span");
    countSpan.className = "cat-count";
    countSpan.textContent = "(" + count + ")";

    btn.appendChild(emojiSpan);
    btn.appendChild(textSpan);
    btn.appendChild(countSpan);

    btn.addEventListener("click", () => {
      currentCategory = value;
      updateActiveCatButton();
      renderItems();
      // Прокрутить к сетке товаров
      document.getElementById("item-grid").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    return btn;
  }

  function updateActiveCatButton() {
    const buttons = document.querySelectorAll(".cat-btn");
    buttons.forEach((btn) => {
      const val = btn.dataset.category || null;
      btn.classList.toggle(
        "active",
        (currentCategory === null && val === null) ||
          (currentCategory !== null && val === currentCategory)
      );
    });
  }

  // ----------------------------------------------------------------
  // Рендеринг сетки товаров
  // ----------------------------------------------------------------
  function renderItems() {
    const grid = document.getElementById("item-grid");
    const emptyState = document.getElementById("empty-state");
    const countEl = document.getElementById("items-count");

    // Фильтрация по категории
    let filtered = currentCategory
      ? allItems.filter((i) => i.category === currentCategory)
      : [...allItems];

    // Фильтрация по поиску
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q)
      );
    }

    grid.innerHTML = "";

    if (filtered.length === 0) {
      emptyState.classList.remove("hidden");
      countEl.classList.add("hidden");
      return;
    }

    emptyState.classList.add("hidden");
    countEl.classList.remove("hidden");
    countEl.textContent = "Показано товаров: " + filtered.length;

    for (const item of filtered) {
      const card = createCard(item, photoMap[item.no]);
      grid.appendChild(card);
    }
  }

  // ----------------------------------------------------------------
  // Создание карточки товара (без innerHTML для XSS-безопасности)
  // ----------------------------------------------------------------
  function createCard(item, photoUrl) {
    const card = document.createElement("article");
    card.className = "card";
    card.setAttribute("role", "listitem");

    // --- Фото ---
    const photoWrap = document.createElement("div");
    photoWrap.className = "card-photo-wrap";

    if (photoUrl) {
      const img = document.createElement("img");
      img.className = "card-photo";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = item.name;

      // При ошибке загрузки — показываем плейсхолдер
      img.onerror = () => {
        photoWrap.removeChild(img);
        photoWrap.appendChild(createPlaceholder(item.category));
      };

      img.src = photoUrl;
      photoWrap.appendChild(img);
    } else {
      photoWrap.appendChild(createPlaceholder(item.category));
    }

    // Бейдж категории
    const catBadge = document.createElement("span");
    catBadge.className = "card-category-badge";
    catBadge.textContent = getCategoryEmoji(item.category) + " " + item.category;
    photoWrap.appendChild(catBadge);

    // Бейдж номера
    const numBadge = document.createElement("span");
    numBadge.className = "card-number-badge";
    numBadge.textContent = "#" + item.no;
    photoWrap.appendChild(numBadge);

    card.appendChild(photoWrap);

    // --- Тело карточки ---
    const body = document.createElement("div");
    body.className = "card-body";

    // Название
    const name = document.createElement("h3");
    name.className = "card-name";
    name.textContent = item.name;
    body.appendChild(name);

    // Цена
    const priceWrap = document.createElement("div");
    priceWrap.className = "card-price";
    const priceText = document.createTextNode(
      CONFIG.CURRENCY_SYMBOL + formatNumber(item.price)
    );
    priceWrap.appendChild(priceText);
    const priceNote = document.createElement("span");
    priceNote.className = "card-price-note";
    priceNote.textContent = "~75% от нового";
    priceWrap.appendChild(priceNote);
    body.appendChild(priceWrap);

    // Дата
    const date = document.createElement("div");
    date.className = "card-date";
    date.textContent = "📅 Доступно с " + item.available_at;
    body.appendChild(date);

    // Кнопка ссылки
    const footer = document.createElement("div");
    footer.className = "card-footer";

    if (item.link_on_web) {
      const link = document.createElement("a");
      link.className = "card-link-btn";
      link.href = item.link_on_web;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "🔗 Смотреть похожее";
      footer.appendChild(link);
    } else {
      const noLink = document.createElement("span");
      noLink.className = "card-no-link";
      noLink.textContent = "Нет ссылки";
      footer.appendChild(noLink);
    }

    body.appendChild(footer);
    card.appendChild(body);

    return card;
  }

  function createPlaceholder(category) {
    const ph = document.createElement("div");
    ph.className = "card-photo-placeholder";

    const icon = document.createElement("span");
    icon.className = "placeholder-icon";
    icon.textContent = getCategoryEmoji(category);

    const label = document.createElement("span");
    label.textContent = category || "Фото отсутствует";

    ph.appendChild(icon);
    ph.appendChild(label);
    return ph;
  }

  // ----------------------------------------------------------------
  // Форматирование числа (с разделителями)
  // ----------------------------------------------------------------
  function formatNumber(num) {
    if (!num && num !== 0) return "—";
    return Number(num).toLocaleString("ru-RU");
  }

  // ----------------------------------------------------------------
  // Управление состояниями UI
  // ----------------------------------------------------------------
  function showLoading() {
    document.getElementById("loading-state").classList.remove("hidden");
    document.getElementById("item-grid").classList.add("hidden");
    document.getElementById("error-state").classList.add("hidden");
    document.getElementById("empty-state").classList.add("hidden");
    document.getElementById("items-count").classList.add("hidden");
  }

  function hideLoading() {
    document.getElementById("loading-state").classList.add("hidden");
    document.getElementById("item-grid").classList.remove("hidden");
  }

  function showError(err) {
    console.error("[GarageSale]", err);
    document.getElementById("loading-state").classList.add("hidden");
    document.getElementById("error-state").classList.remove("hidden");
    const msg = document.getElementById("error-message");
    msg.textContent = err.message || "Неизвестная ошибка. Откройте консоль браузера для деталей.";
  }

  function updateLastUpdated() {
    const el = document.getElementById("last-updated");
    if (el) {
      const now = new Date();
      el.textContent = now.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }

  // ----------------------------------------------------------------
  // Главная функция загрузки данных
  // ----------------------------------------------------------------
  async function loadData() {
    const now = Date.now();
    lastFetchTime = now;

    showLoading();

    try {
      // Параллельная загрузка таблицы и фото
      const [items, driveFiles] = await Promise.all([
        fetchSheetData(),
        fetchDrivePhotos().catch((err) => {
          // Ошибка Drive не блокирует показ товаров — просто без фото
          console.warn("[GarageSale] Drive:", err.message);
          return [];
        }),
      ]);

      allItems = items;
      photoMap = buildPhotoMap(driveFiles);

      renderCategories(items);
      renderItems();
      updateLastUpdated();
      hideLoading();
    } catch (err) {
      showError(err);
    }
  }

  // ----------------------------------------------------------------
  // Поиск
  // ----------------------------------------------------------------
  function initSearch() {
    const input = document.getElementById("search-input");
    if (!input) return;

    let debounceTimer = null;
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        searchQuery = input.value.trim();
        renderItems();
      }, 200);
    });
  }

  // ----------------------------------------------------------------
  // Автообновление
  // ----------------------------------------------------------------
  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      loadData();
    }, CONFIG.REFRESH_INTERVAL_MS);
  }

  function initVisibilityRefresh() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      const elapsed = Date.now() - lastFetchTime;
      if (elapsed > CONFIG.MIN_REFRESH_GAP_MS) {
        loadData();
      }
    });
  }

  // ----------------------------------------------------------------
  // Кнопка "Попробовать снова"
  // ----------------------------------------------------------------
  function initRetry() {
    const btn = document.getElementById("retry-btn");
    if (btn) {
      btn.addEventListener("click", loadData);
    }
  }

  // ----------------------------------------------------------------
  // Инициализация приложения
  // ----------------------------------------------------------------
  function init() {
    initSearch();
    initRetry();
    initVisibilityRefresh();
    startAutoRefresh();
    loadData();
  }

  // Запуск после загрузки DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
