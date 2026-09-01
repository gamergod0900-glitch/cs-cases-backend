const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

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

  console.log("База данных готова: таблицы users, inventory, openings, withdrawals проверены/созданы");
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
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
  } catch (err) {
    console.error("Не удалось отправить уведомление в Telegram:", err);
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

// ===== Описание кейсов и их содержимого (хранится прямо в коде сервера) =====
const CASES = {
  gold: {
    name: "Штурмовой Арсенал",
    price: 50,
    items: [
      { name: "АК-47 | Снежный камуфляж", image: "images/skin-ak-white.png", rarity: "common", weight: 60, value: 40 },
      { name: "АК-47 | Ледяная синь", image: "images/skin-ak-blue.png", rarity: "rare", weight: 30, value: 90 },
      { name: "АК-47 | Лесной хаос", image: "images/skin-ak-camo.png", rarity: "epic", weight: 10, value: 220 }
    ]
  },
  platinum: {
    name: "Клинок Императора",
    price: 200,
    items: [
      { name: "Керамбит-крюк | Танзанит", image: "images/skin-knife-hook.png", rarity: "rare", weight: 50, value: 350 },
      { name: "Штык-нож | Морская глубина", image: "images/skin-knife-blue.png", rarity: "epic", weight: 35, value: 700 },
      { name: "Клинок | Северное сияние", image: "images/skin-knife-gradient.png", rarity: "legendary", weight: 15, value: 1500 }
    ]
  },
  silver: {
    name: "Тайный Агент",
    price: 30,
    items: [
      { name: "Beretta | Лесная тень", image: "images/skin-beretta.png", rarity: "common", weight: 50, value: 20 },
      { name: "Glock | Радужный отблеск", image: "images/skin-glock.png", rarity: "common", weight: 30, value: 35 },
      { name: "USP-S | Алый шёпот", image: "images/skin-usp-red.png", rarity: "rare", weight: 15, value: 80 },
      { name: "USP-S | Золотой монстр", image: "images/skin-usp-gold.png", rarity: "legendary", weight: 5, value: 300 }
    ]
  }
};

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
    const caseData = CASES[case_id];
    if (!caseData) return res.status(400).json({ error: "Такого кейса не существует" });

    const userResult = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: "Пользователь не найден" });

    const user = userResult.rows[0];
    if (user.balance < caseData.price) {
      return res.status(400).json({ error: "Недостаточно средств" });
    }

    const winner = pickWinner(caseData.items);
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
    await notifyAdminWithButton(
      `🎁 <b>Запрос на вывод предмета</b>\n\n` +
      `Игрок: ${userLabel} (id ${telegram_id})\n` +
      `Предмет: ${item.item_name}\n` +
      `Ценность: ${item.value} ₴\n` +
      `Ссылка на трейд: ${trade_link.trim()}\n\n` +
      `Статус: ⏳ В обработке`,
      "✅ Принял в обработку",
      `accept:${withdrawalId}`
    );

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
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    const wResult = await pool.query("SELECT * FROM withdrawals WHERE id = $1", [withdrawalId]);
    if (wResult.rows.length === 0) {
      await answerCallback(callback.id, "Заявка не найдена");
      return res.sendStatus(200);
    }
    const withdrawal = wResult.rows[0];

    if (action === "accept") {
      await pool.query("UPDATE withdrawals SET status = 'accepted' WHERE id = $1", [withdrawalId]);
      await pool.query("UPDATE inventory SET withdraw_status = 'accepted' WHERE id = $1", [withdrawal.inventory_id]);
      await editAdminMessage(
        chatId, messageId,
        `🎁 <b>Запрос на вывод предмета</b>\n\nПредмет: ${withdrawal.item_name}\nЦенность: ${withdrawal.item_value} ₴\nСсылка на трейд: ${withdrawal.trade_link}\n\nСтатус: 🔄 В процессе`,
        "📤 Трейд отправлен",
        `sent:${withdrawalId}`
      );
      await answerCallback(callback.id, "Отмечено как «в процессе»");
    } else if (action === "sent") {
      await pool.query("UPDATE withdrawals SET status = 'trade_sent' WHERE id = $1", [withdrawalId]);
      await pool.query("UPDATE inventory SET withdraw_status = 'trade_sent' WHERE id = $1", [withdrawal.inventory_id]);
      await editAdminMessage(
        chatId, messageId,
        `🎁 <b>Запрос на вывод предмета</b>\n\nПредмет: ${withdrawal.item_name}\nЦенность: ${withdrawal.item_value} ₴\nСсылка на трейд: ${withdrawal.trade_link}\n\nСтатус: 📤 Трейд отправлен игроку`,
        "🎉 Скин получен игроком",
        `done:${withdrawalId}`
      );
      await answerCallback(callback.id, "Отмечено как «трейд отправлен»");
    } else if (action === "done") {
      await pool.query("UPDATE withdrawals SET status = 'received' WHERE id = $1", [withdrawalId]);
      // Только теперь предмет реально удаляется из инвентаря игрока
      await pool.query("DELETE FROM inventory WHERE id = $1", [withdrawal.inventory_id]);
      await editAdminMessage(
        chatId, messageId,
        `🎁 <b>Запрос на вывод предмета</b>\n\nПредмет: ${withdrawal.item_name}\nЦенность: ${withdrawal.item_value} ₴\n\nСтатус: ✅ Выполнено, предмет получен игроком`,
        null, null
      );
      await answerCallback(callback.id, "Вывод завершён ✅");
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Ошибка обработки webhook:", err);
    res.sendStatus(200); // Telegram всё равно ждёт 200, иначе будет повторять попытки
  }
});

// Пополнение баланса (пока демо-режим, без настоящей оплаты)
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
