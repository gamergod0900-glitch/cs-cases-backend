const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// Подключение к базе данных (строка берётся из переменной окружения DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== Создаём таблицы при запуске сервера, если их ещё нет =====
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      balance INTEGER NOT NULL DEFAULT 1000,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
      item_name TEXT NOT NULL,
      item_image TEXT NOT NULL,
      rarity TEXT NOT NULL,
      value INTEGER NOT NULL,
      added_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  // На случай, если таблица inventory уже была создана раньше без этой колонки
  await pool.query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS withdraw_status TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS openings (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
      case_name TEXT NOT NULL,
      item_name TEXT NOT NULL,
      item_image TEXT NOT NULL,
      rarity TEXT NOT NULL,
      value INTEGER NOT NULL,
      opened_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
      item_name TEXT NOT NULL,
      item_value INTEGER NOT NULL,
      trade_link TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  // На случай, если таблица withdrawals уже была создана раньше без этой колонки
  await pool.query(`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS inventory_id INTEGER;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
      order_id TEXT UNIQUE NOT NULL,
      amount_uah INTEGER NOT NULL,
      amount_usd NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Чтобы админ-панель могла обновлять то же сообщение в Telegram, что видит владелец
  await pool.query(`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS admin_chat_id BIGINT;`);
  await pool.query(`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS admin_message_id BIGINT;`);

  // Кейсы теперь хранятся в базе данных, а не в коде — так их можно менять из админ-панели
  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_defs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      image TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_items (
      id SERIAL PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES case_defs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      rarity TEXT NOT NULL,
      weight INTEGER NOT NULL,
      value INTEGER NOT NULL
    );
  `);

  // Если таблица кейсов ещё пустая — заполняем её текущими тремя кейсами (первый запуск после обновления)
  const caseCount = await pool.query("SELECT COUNT(*) FROM case_defs");
  if (parseInt(caseCount.rows[0].count, 10) === 0) {
    console.log("Таблица кейсов пуста — заполняем стартовыми кейсами...");
    for (let i = 0; i < SEED_CASES.length; i++) {
      const c = SEED_CASES[i];
      await pool.query(
        "INSERT INTO case_defs (id, name, price, image, sort_order) VALUES ($1, $2, $3, $4, $5)",
        [c.id, c.name, c.price, c.image, i]
      );
      for (const item of c.items) {
        await pool.query(
          "INSERT INTO case_items (case_id, name, image, rarity, weight, value) VALUES ($1, $2, $3, $4, $5, $6)",
          [c.id, item.name, item.image, item.rarity, item.weight, item.value]
        );
      }
    }
  }

  console.log("База данных готова: таблицы users, inventory, openings, withdrawals, payments, case_defs, case_items проверены/созданы");
}

// Отправка сообщения владельцу проекта в Telegram через Bot API
async function notifyAdmin(text) {
  const token = process.env.BOT_TOKEN;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!token || !adminId) {
    console.warn("BOT_TOKEN или ADMIN_TELEGRAM_ID не заданы — уведомление не отправлено");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: adminId, text, parse_mode: "HTML" })
    });
  } catch (err) {
    console.error("Не удалось отправить уведомление в Telegram:", err);
  }
}

// Отправка сообщения администратору с кнопкой (используется при первом запросе на вывод)
async function notifyAdminWithButton(text, buttonText, callbackData) {
  const token = process.env.BOT_TOKEN;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!token || !adminId) {
    console.warn("BOT_TOKEN или ADMIN_TELEGRAM_ID не заданы — уведомление не отправлено");
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        text,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: buttonText, callback_data: callbackData }]]
        }
      })
    });
    const data = await res.json();
    if (data.ok) {
      return { chatId: data.result.chat.id, messageId: data.result.message_id };
    }
    return null;
  } catch (err) {
    console.error("Не удалось отправить уведомление в Telegram:", err);
    return null;
  }
}

// Редактирование уже отправленного сообщения (меняем текст и/или кнопку по мере смены статуса)
async function editAdminMessage(chatId, messageId, text, buttonText, callbackData) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  try {
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML"
    };
    if (buttonText && callbackData) {
      body.reply_markup = { inline_keyboard: [[{ text: buttonText, callback_data: callbackData }]] };
    } else {
      body.reply_markup = { inline_keyboard: [] };
    }
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error("Не удалось отредактировать сообщение:", err);
  }
}

// Подтверждение нажатия кнопки (убирает "часики" на кнопке у администратора)
async function answerCallback(callbackQueryId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
  } catch (err) {
    console.error("Не удалось подтвердить нажатие кнопки:", err);
  }
}

// Описание содержимого сообщения в Telegram для каждого этапа заявки на вывод
function withdrawalStageContent(stage, w) {
  const base = `🎁 <b>Запрос на вывод предмета</b>\n\nПредмет: ${w.item_name}\nЦенность: ${w.item_value} ₴\nСсылка на трейд: ${w.trade_link}\n\n`;
  if (stage === "accepted") {
    return { text: base + "Статус: 🔄 В процессе", buttonText: "📤 Трейд отправлен", callbackData: `sent:${w.id}` };
  }
  if (stage === "trade_sent") {
    return { text: base + "Статус: 📤 Трейд отправлен игроку", buttonText: "🎉 Скин получен игроком", callbackData: `done:${w.id}` };
  }
  if (stage === "received") {
    return { text: base + "Статус: ✅ Выполнено, предмет получен игроком", buttonText: null, callbackData: null };
  }
  return { text: base + "Статус: ⏳ В обработке", buttonText: "✅ Принял в обработку", callbackData: `accept:${w.id}` };
}

// Переводит заявку на вывод в новый статус (используется и кнопками в Telegram, и админ-панелью),
// заодно обновляет то же самое сообщение в Telegram, чтобы обе точки управления оставались синхронными
async function advanceWithdrawalStatus(withdrawalId, newStage) {
  const wResult = await pool.query("SELECT * FROM withdrawals WHERE id = $1", [withdrawalId]);
  if (wResult.rows.length === 0) return null;
  const withdrawal = wResult.rows[0];

  await pool.query("UPDATE withdrawals SET status = $1 WHERE id = $2", [newStage, withdrawalId]);

  if (newStage === "received") {
    await pool.query("DELETE FROM inventory WHERE id = $1", [withdrawal.inventory_id]);
  } else {
    await pool.query("UPDATE inventory SET withdraw_status = $1 WHERE id = $2", [newStage, withdrawal.inventory_id]);
  }

  if (withdrawal.admin_chat_id && withdrawal.admin_message_id) {
    const { text, buttonText, callbackData } = withdrawalStageContent(newStage, withdrawal);
    await editAdminMessage(withdrawal.admin_chat_id, withdrawal.admin_message_id, text, buttonText, callbackData);
  }

  const updated = await pool.query("SELECT * FROM withdrawals WHERE id = $1", [withdrawalId]);
  return updated.rows[0];
}

// Простая защита админ-эндпоинтов паролем (передаётся в заголовке x-admin-password)
function requireAdmin(req, res, next) {
  const password = req.headers["x-admin-password"];
  if (!process.env.ADMIN_PANEL_PASSWORD) {
    console.warn("ADMIN_PANEL_PASSWORD не задан — админ-панель отключена");
    return res.status(500).json({ error: "Админ-панель не настроена на сервере" });
  }
  if (password !== process.env.ADMIN_PANEL_PASSWORD) {
    return res.status(401).json({ error: "Неверный пароль" });
  }
  next();
}

// ===== Описание кейсов и их содержимого (хранится прямо в коде сервера) =====
// Курс для конвертации гривны в доллары при создании счёта на оплату (NOWPayments принимает суммы в USD).
// Курс фиксированный и его нужно периодически обновлять вручную под актуальный курс.
const UAH_PER_USD = 41;

// Список криптовалют для пополнения. min_usd — примерная минимальная сумма платежа для этой сети
// (зависит от комиссии сети: чем "тяжелее" блокчейн, тем выше минимум). Раз на эти цифры
// нельзя надёжно положиться через живой запрос к NOWPayments (комиссии сети динамические
// и API возвращал нестабильные данные), задаём разумные ориентиры вручную — их стоит
// периодически сверять с реальными комиссиями сетей и подправлять при необходимости.
const SUPPORTED_CURRENCIES = [
  { code: "usdttrc20", label: "USDT (TRC20)", min_usd: 6 },
  { code: "ton", label: "Toncoin (TON)", min_usd: 6 },
  { code: "trx", label: "TRON (TRX)", min_usd: 6 },
  { code: "ltc", label: "Litecoin (LTC)", min_usd: 8 },
  { code: "doge", label: "Dogecoin (DOGE)", min_usd: 10 },
  { code: "usdterc20", label: "USDT (ERC20)", min_usd: 20 },
  { code: "eth", label: "Ethereum (ETH)", min_usd: 20 },
  { code: "btc", label: "Bitcoin (BTC)", min_usd: 25 }
];

// Стартовые данные кейсов — используются только один раз, чтобы заполнить пустую базу при первом запуске.
// После этого все изменения кейсов делаются через админ-панель и хранятся в таблицах case_defs/case_items.
const SEED_CASES = [
  {
    id: "anomaly",
    name: "Аномалия",
    price: 90,
    image: "images/case-anomaly.png",
    items: [
      { name: "Desert Eagle | Firebreathing", image: "images/skin-deagle-fire.png", rarity: "common", weight: 35, value: 45 },
      { name: "PP-Bizon | Чертёж объекта", image: "images/skin-bizon-blueprint.png", rarity: "common", weight: 30, value: 55 },
      { name: "ПП-19 Бизон | Предатель", image: "images/skin-bizon-traitor.png", rarity: "rare", weight: 18, value: 130 },
      { name: "R8 Revolver | Cobalt Grip", image: "images/skin-r8-cobalt.png", rarity: "rare", weight: 10, value: 160 },
      { name: "AWP | Chromatic Aberration", image: "images/skin-awp-chromatic.png", rarity: "epic", weight: 5, value: 480 },
      { name: "Керамбит | Ультрафиолет", image: "images/skin-karambit-uv.png", rarity: "legendary", weight: 2, value: 1350 }
    ]
  },
  {
    id: "blood-mark",
    name: "Кровавая Метка",
    price: 60,
    image: "images/case-blood-mark.png",
    items: [
      { name: "Glock-18 | Карамельное яблоко", image: "images/skin-glock-candy.png", rarity: "common", weight: 35, value: 30 },
      { name: "MAG-7 | Разрушение ядра", image: "images/skin-mag7-core.png", rarity: "common", weight: 27, value: 45 },
      { name: "CZ75-Auto | Настоящий змееяд", image: "images/skin-cz75-viper.png", rarity: "rare", weight: 20, value: 110 },
      { name: "G3SG1 | Red Jasper", image: "images/skin-g3sg1-jasper.png", rarity: "epic", weight: 13, value: 320 },
      { name: "AWP | Градиент", image: "images/skin-awp-gradient.png", rarity: "legendary", weight: 5, value: 900 }
    ]
  },
  {
    id: "blue-pulse",
    name: "Синий Импульс",
    price: 100,
    image: "images/case-blue-pulse.png",
    items: [
      { name: "CZ75-Auto | Полуночная пальма", image: "images/skin-cz75-palm.png", rarity: "common", weight: 32, value: 35 },
      { name: "MAG-7 | Чайка", image: "images/skin-mag7-gull.png", rarity: "common", weight: 28, value: 50 },
      { name: "Negev | Сверхлёгкий", image: "images/skin-negev-light.png", rarity: "rare", weight: 20, value: 140 },
      { name: "AK-47 | Вулкан", image: "images/skin-ak-vulcan.png", rarity: "epic", weight: 15, value: 520 },
      { name: "Скелетный нож | Патина", image: "images/skin-skeleton-knife.png", rarity: "legendary", weight: 5, value: 1400 }
    ]
  }
];

// Честный взвешенный случайный выбор — считается только здесь, на сервере
function pickWinner(items) {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let rnd = Math.random() * total;
  for (const item of items) {
    if (rnd < item.weight) return item;
    rnd -= item.weight;
  }
  return items[items.length - 1];
}

// ===== Маршруты (endpoints) =====

app.get("/", (req, res) => {
  res.send("Сервер CS Cases работает! 🎉 База данных подключена.");
});

// Получить (или создать, если ещё нет) пользователя по его Telegram ID
app.post("/api/user", async (req, res) => {
  try {
    const { telegram_id, first_name, username } = req.body;
    if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });

    const existing = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);

    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }

    const created = await pool.query(
      "INSERT INTO users (telegram_id, first_name, username) VALUES ($1, $2, $3) RETURNING *",
      [telegram_id, first_name || null, username || null]
    );
    res.json(created.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Открыть кейс
app.post("/api/open-case", async (req, res) => {
  try {
    const { telegram_id, case_id } = req.body;

    const caseResult = await pool.query("SELECT * FROM case_defs WHERE id = $1", [case_id]);
    if (caseResult.rows.length === 0) return res.status(400).json({ error: "Такого кейса не существует" });
    const caseData = caseResult.rows[0];

    const itemsResult = await pool.query("SELECT * FROM case_items WHERE case_id = $1", [case_id]);
    if (itemsResult.rows.length === 0) return res.status(400).json({ error: "В этом кейсе нет предметов" });

    const userResult = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: "Пользователь не найден" });

    const user = userResult.rows[0];
    if (user.balance < caseData.price) {
      return res.status(400).json({ error: "Недостаточно средств" });
    }

    const winner = pickWinner(itemsResult.rows);
    const newBalance = user.balance - caseData.price;

    await pool.query("UPDATE users SET balance = $1 WHERE telegram_id = $2", [newBalance, telegram_id]);

    await pool.query(
      `INSERT INTO openings (telegram_id, case_name, item_name, item_image, rarity, value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [telegram_id, caseData.name, winner.name, winner.image, winner.rarity, winner.value]
    );

    res.json({ item: winner, newBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Публичный список кейсов для главного экрана сайта (картинки, названия, цены и содержимое)
app.get("/api/cases", async (req, res) => {
  try {
    const casesResult = await pool.query("SELECT * FROM case_defs ORDER BY sort_order ASC, name ASC");
    const cases = [];
    for (const c of casesResult.rows) {
      const itemsResult = await pool.query("SELECT * FROM case_items WHERE case_id = $1", [c.id]);
      cases.push({
        id: c.id,
        name: c.name,
        price: c.price,
        image: c.image,
        items: itemsResult.rows.map(i => ({
          name: i.name,
          image: i.image,
          rarity: i.rarity,
          weight: i.weight,
          value: i.value
        }))
      });
    }
    res.json(cases);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Добавить полученный предмет в инвентарь
app.post("/api/inventory/add", async (req, res) => {
  try {
    const { telegram_id, item_name, item_image, rarity, value } = req.body;
    await pool.query(
      `INSERT INTO inventory (telegram_id, item_name, item_image, rarity, value)
       VALUES ($1, $2, $3, $4, $5)`,
      [telegram_id, item_name, item_image, rarity, value]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Получить инвентарь пользователя
app.get("/api/inventory/:telegram_id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM inventory WHERE telegram_id = $1 ORDER BY added_at DESC",
      [req.params.telegram_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Получить историю открытий пользователя
app.get("/api/history/:telegram_id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM openings WHERE telegram_id = $1 ORDER BY opened_at DESC LIMIT 50",
      [req.params.telegram_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Продать предмет из инвентаря обратно на баланс
app.post("/api/inventory/sell", async (req, res) => {
  try {
    const { telegram_id, item_id } = req.body;

    const itemResult = await pool.query(
      "SELECT * FROM inventory WHERE id = $1 AND telegram_id = $2",
      [item_id, telegram_id]
    );
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: "Предмет не найден" });
    }
    const item = itemResult.rows[0];

    await pool.query("DELETE FROM inventory WHERE id = $1", [item_id]);

    const updated = await pool.query(
      "UPDATE users SET balance = balance + $1 WHERE telegram_id = $2 RETURNING balance",
      [item.value, telegram_id]
    );

    res.json({ newBalance: updated.rows[0].balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Запросить вывод предмета (ручная обработка через Telegram-уведомление владельцу)
app.post("/api/inventory/withdraw", async (req, res) => {
  try {
    const { telegram_id, item_id, trade_link } = req.body;
    if (!trade_link || !trade_link.trim()) {
      return res.status(400).json({ error: "Укажи ссылку на трейд" });
    }

    const itemResult = await pool.query(
      "SELECT * FROM inventory WHERE id = $1 AND telegram_id = $2",
      [item_id, telegram_id]
    );
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: "Предмет не найден" });
    }
    const item = itemResult.rows[0];
    if (item.withdraw_status) {
      return res.status(400).json({ error: "Заявка на этот предмет уже отправлена" });
    }

    const userResult = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
    const user = userResult.rows[0];

    // Предмет остаётся в инвентаре, но помечается статусом — исчезнет только когда владелец подтвердит получение
    await pool.query("UPDATE inventory SET withdraw_status = 'pending' WHERE id = $1", [item_id]);

    const withdrawalResult = await pool.query(
      `INSERT INTO withdrawals (telegram_id, item_name, item_value, trade_link, status, inventory_id)
       VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id`,
      [telegram_id, item.item_name, item.value, trade_link.trim(), item_id]
    );
    const withdrawalId = withdrawalResult.rows[0].id;

    const userLabel = user.username ? `@${user.username}` : (user.first_name || `ID ${telegram_id}`);
    const sent = await notifyAdminWithButton(
      `🎁 <b>Запрос на вывод предмета</b>\n\n` +
      `Игрок: ${userLabel} (id ${telegram_id})\n` +
      `Предмет: ${item.item_name}\n` +
      `Ценность: ${item.value} ₴\n` +
      `Ссылка на трейд: ${trade_link.trim()}\n\n` +
      `Статус: ⏳ В обработке`,
      "✅ Принял в обработку",
      `accept:${withdrawalId}`
    );

    // Сохраняем, какое именно сообщение отправили — понадобится, чтобы редактировать его позже
    if (sent) {
      await pool.query(
        "UPDATE withdrawals SET admin_chat_id = $1, admin_message_id = $2 WHERE id = $3",
        [sent.chatId, sent.messageId, withdrawalId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ===== Webhook: сюда Telegram присылает нажатия кнопок администратором =====
app.post("/telegram-webhook", async (req, res) => {
  try {
    const callback = req.body.callback_query;
    if (!callback) {
      return res.sendStatus(200); // не связанное с нами обновление — просто подтверждаем получение
    }

    const [action, withdrawalIdStr] = (callback.data || "").split(":");
    const withdrawalId = parseInt(withdrawalIdStr, 10);
    const stageMap = { accept: "accepted", sent: "trade_sent", done: "received" };
    const newStage = stageMap[action];

    if (!newStage) {
      await answerCallback(callback.id, "Неизвестное действие");
      return res.sendStatus(200);
    }

    const updated = await advanceWithdrawalStatus(withdrawalId, newStage);
    if (!updated) {
      await answerCallback(callback.id, "Заявка не найдена");
      return res.sendStatus(200);
    }

    const confirmText = {
      accepted: "Отмечено как «в процессе»",
      trade_sent: "Отмечено как «трейд отправлен»",
      received: "Вывод завершён ✅"
    }[newStage];
    await answerCallback(callback.id, confirmText);

    res.sendStatus(200);
  } catch (err) {
    console.error("Ошибка обработки webhook:", err);
    res.sendStatus(200); // Telegram всё равно ждёт 200, иначе будет повторять попытки
  }
});

// Пополнение баланса (демо-режим, оставлен для теста — реальные платежи идут через /api/payment/create)
app.post("/api/topup", async (req, res) => {
  try {
    const { telegram_id, amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Некорректная сумма" });

    const result = await pool.query(
      "UPDATE users SET balance = balance + $1 WHERE telegram_id = $2 RETURNING balance",
      [amount, telegram_id]
    );
    res.json({ newBalance: result.rows[0].balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Список доступных криптовалют с минимальной суммой пополнения в гривне для каждой
app.get("/api/payment/currencies", (req, res) => {
  const results = SUPPORTED_CURRENCIES.map(c => ({
    code: c.code,
    label: c.label,
    min_uah: Math.ceil((c.min_usd * UAH_PER_USD) / 5) * 5 // округляем до 5 ₴ для красоты
  }));
  res.json(results);
});

// Создать настоящий криптоплатёж через NOWPayments
app.post("/api/payment/create", async (req, res) => {
  try {
    const { telegram_id, amount_uah, pay_currency } = req.body;
    if (!amount_uah || amount_uah <= 0) {
      return res.status(400).json({ error: "Некорректная сумма" });
    }
    if (!pay_currency) {
      return res.status(400).json({ error: "Выбери криптовалюту для оплаты" });
    }

    const amount_usd = +(amount_uah / UAH_PER_USD).toFixed(2);
    const order_id = `topup_${telegram_id}_${Date.now()}`;

    const npRes = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        price_amount: amount_usd,
        price_currency: "usd",
        pay_currency,
        order_id,
        order_description: "Пополнение баланса CS Cases",
        ipn_callback_url: "https://cs-cases-backend.onrender.com/nowpayments-webhook"
      })
    });

    const npData = await npRes.json();
    if (!npData.invoice_url) {
      console.error("Ошибка создания счёта NOWPayments:", npData);
      return res.status(500).json({ error: npData.message || "Не удалось создать платёж, попробуй позже" });
    }

    await pool.query(
      `INSERT INTO payments (telegram_id, order_id, amount_uah, amount_usd, status)
       VALUES ($1, $2, $3, $4, 'waiting')`,
      [telegram_id, order_id, amount_uah, amount_usd]
    );

    res.json({ invoice_url: npData.invoice_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Рекурсивно сортирует ключи объекта по алфавиту — нужно для проверки подписи NOWPayments
function sortObjectDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectDeep);
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = sortObjectDeep(obj[key]);
      return acc;
    }, {});
  }
  return obj;
}

// Webhook: сюда NOWPayments присылает уведомления об изменении статуса платежа
app.post("/nowpayments-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"];
    const sortedBody = sortObjectDeep(req.body);
    const expectedSignature = crypto
      .createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET)
      .update(JSON.stringify(sortedBody))
      .digest("hex");

    if (signature !== expectedSignature) {
      console.warn("Неверная подпись webhook NOWPayments — запрос отклонён");
      return res.sendStatus(403);
    }

    const { order_id, payment_status } = req.body;

    if (payment_status === "finished") {
      const paymentResult = await pool.query("SELECT * FROM payments WHERE order_id = $1", [order_id]);
      if (paymentResult.rows.length > 0 && paymentResult.rows[0].status !== "finished") {
        const payment = paymentResult.rows[0];
        await pool.query(
          "UPDATE users SET balance = balance + $1 WHERE telegram_id = $2",
          [payment.amount_uah, payment.telegram_id]
        );
        await pool.query("UPDATE payments SET status = 'finished' WHERE id = $1", [payment.id]);
        console.log(`Зачислено ${payment.amount_uah} ₴ пользователю ${payment.telegram_id} (заказ ${order_id})`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Ошибка обработки webhook NOWPayments:", err);
    res.sendStatus(200); // NOWPayments ждёт 200, иначе будет повторять попытки
  }
});

// ================== АДМИН-ПАНЕЛЬ ==================
// Все маршруты ниже защищены паролем (заголовок x-admin-password), см. requireAdmin выше

// Проверка пароля (используется формой входа в панели)
app.post("/api/admin/login", requireAdmin, (req, res) => {
  res.json({ success: true });
});

// --- Заявки на вывод ---
app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*, u.first_name, u.username
      FROM withdrawals w
      LEFT JOIN users u ON u.telegram_id = w.telegram_id
      ORDER BY w.requested_at DESC
      LIMIT 200
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/admin/withdrawals/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body; // ожидается: accepted | trade_sent | received
    if (!["accepted", "trade_sent", "received"].includes(status)) {
      return res.status(400).json({ error: "Некорректный статус" });
    }
    const updated = await advanceWithdrawalStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: "Заявка не найдена" });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Пользователи ---
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.telegram_id, u.first_name, u.username, u.balance, u.created_at,
        (SELECT COUNT(*) FROM openings o WHERE o.telegram_id = u.telegram_id) AS cases_opened,
        (SELECT COUNT(*) FROM inventory i WHERE i.telegram_id = u.telegram_id) AS inventory_count
      FROM users u
      ORDER BY u.created_at DESC
      LIMIT 300
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/admin/users/:telegram_id/balance", requireAdmin, async (req, res) => {
  try {
    const { balance } = req.body;
    if (balance === undefined || balance < 0) {
      return res.status(400).json({ error: "Некорректный баланс" });
    }
    const result = await pool.query(
      "UPDATE users SET balance = $1 WHERE telegram_id = $2 RETURNING *",
      [balance, req.params.telegram_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Пользователь не найден" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Управление кейсами ---
app.get("/api/admin/cases", requireAdmin, async (req, res) => {
  try {
    const casesResult = await pool.query("SELECT * FROM case_defs ORDER BY sort_order ASC, name ASC");
    const cases = [];
    for (const c of casesResult.rows) {
      const itemsResult = await pool.query("SELECT * FROM case_items WHERE case_id = $1 ORDER BY value DESC", [c.id]);
      cases.push({ ...c, items: itemsResult.rows });
    }
    res.json(cases);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/admin/cases", requireAdmin, async (req, res) => {
  try {
    const { id, name, price, image, items } = req.body;
    if (!id || !name || !price || !image || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Заполни все поля кейса и добавь хотя бы один предмет" });
    }

    const existing = await pool.query("SELECT id FROM case_defs WHERE id = $1", [id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Кейс с таким ID уже существует" });
    }

    const countResult = await pool.query("SELECT COUNT(*) FROM case_defs");
    const sortOrder = parseInt(countResult.rows[0].count, 10);

    await pool.query(
      "INSERT INTO case_defs (id, name, price, image, sort_order) VALUES ($1, $2, $3, $4, $5)",
      [id, name, price, image, sortOrder]
    );
    for (const item of items) {
      await pool.query(
        "INSERT INTO case_items (case_id, name, image, rarity, weight, value) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, item.name, item.image, item.rarity, item.weight, item.value]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/api/admin/cases/:id", requireAdmin, async (req, res) => {
  try {
    const { name, price, image, items } = req.body;
    if (!name || !price || !image || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Заполни все поля кейса и добавь хотя бы один предмет" });
    }

    const existing = await pool.query("SELECT id FROM case_defs WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Кейс не найден" });

    await pool.query(
      "UPDATE case_defs SET name = $1, price = $2, image = $3 WHERE id = $4",
      [name, price, image, req.params.id]
    );

    // Проще всего полностью пересоздать список предметов кейса при редактировании
    await pool.query("DELETE FROM case_items WHERE case_id = $1", [req.params.id]);
    for (const item of items) {
      await pool.query(
        "INSERT INTO case_items (case_id, name, image, rarity, weight, value) VALUES ($1, $2, $3, $4, $5, $6)",
        [req.params.id, item.name, item.image, item.rarity, item.weight, item.value]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/api/admin/cases/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM case_defs WHERE id = $1", [req.params.id]); // case_items удалятся сами (ON DELETE CASCADE)
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- История платежей ---
app.get("/api/admin/payments", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.first_name, u.username
      FROM payments p
      LEFT JOIN users u ON u.telegram_id = p.telegram_id
      ORDER BY p.created_at DESC
      LIMIT 300
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Не удалось подключиться к базе данных:", err);
  });
