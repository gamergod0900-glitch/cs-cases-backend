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

  console.log("База данных готова: таблицы users, inventory, openings, withdrawals, payments проверены/созданы");
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
// Курс для конвертации гривны в доллары при создании счёта на оплату (NOWPayments принимает суммы в USD).
// Курс фиксированный и его нужно периодически обновлять вручную под актуальный курс.
const UAH_PER_USD = 41;

// Список криптовалют для пополнения. min_usd — примерная минимальная сумма платежа для этой сети
// (зависит от комиссии сети: чем "тяжелее" блокчейн, тем выше минимум). Раз на эти цифры
// нельзя надёжно положиться через живой запрос к NOWPayments (комиссии сети динамические
// и API возвращал нестабильные данные), задаём разумные ориентиры вручную — их стоит
// периодически сверять с реальными комиссиями сетей и подправлять при необходимости.
const SUPPORTED_CURRENCIES = [
  { code: "usdttrc20", label: "USDT (TRC20)", min_usd: 1 },
  { code: "ton", label: "Toncoin (TON)", min_usd: 1 },
  { code: "trx", label: "TRON (TRX)", min_usd: 1 },
  { code: "ltc", label: "Litecoin (LTC)", min_usd: 2 },
  { code: "doge", label: "Dogecoin (DOGE)", min_usd: 3 },
  { code: "usdterc20", label: "USDT (ERC20)", min_usd: 15 },
  { code: "eth", label: "Ethereum (ETH)", min_usd: 15 },
  { code: "btc", label: "Bitcoin (BTC)", min_usd: 18 }
];

const CASES = {
  anomaly: {
    name: "Аномалия",
    price: 90,
    items: [
      { name: "Desert Eagle | Firebreathing", image: "images/skin-deagle-fire.png", rarity: "common", weight: 35, value: 45 },
      { name: "PP-Bizon | Чертёж объекта", image: "images/skin-bizon-blueprint.png", rarity: "common", weight: 30, value: 55 },
      { name: "ПП-19 Бизон | Предатель", image: "images/skin-bizon-traitor.png", rarity: "rare", weight: 18, value: 130 },
      { name: "R8 Revolver | Cobalt Grip", image: "images/skin-r8-cobalt.png", rarity: "rare", weight: 10, value: 160 },
      { name: "AWP | Chromatic Aberration", image: "images/skin-awp-chromatic.png", rarity: "epic", weight: 5, value: 480 },
      { name: "Керамбит | Ультрафиолет", image: "images/skin-karambit-uv.png", rarity: "legendary", weight: 2, value: 1350 }
    ]
  },
  "blood-mark": {
    name: "Кровавая Метка",
    price: 60,
    items: [
      { name: "Glock-18 | Карамельное яблоко", image: "images/skin-glock-candy.png", rarity: "common", weight: 35, value: 30 },
      { name: "MAG-7 | Разрушение ядра", image: "images/skin-mag7-core.png", rarity: "common", weight: 27, value: 45 },
      { name: "CZ75-Auto | Настоящий змееяд", image: "images/skin-cz75-viper.png", rarity: "rare", weight: 20, value: 110 },
      { name: "G3SG1 | Red Jasper", image: "images/skin-g3sg1-jasper.png", rarity: "epic", weight: 13, value: 320 },
      { name: "AWP | Градиент", image: "images/skin-awp-gradient.png", rarity: "legendary", weight: 5, value: 900 }
    ]
  },
  "blue-pulse": {
    name: "Синий Импульс",
    price: 100,
    items: [
      { name: "CZ75-Auto | Полуночная пальма", image: "images/skin-cz75-palm.png", rarity: "common", weight: 32, value: 35 },
      { name: "MAG-7 | Чайка", image: "images/skin-mag7-gull.png", rarity: "common", weight: 28, value: 50 },
      { name: "Negev | Сверхлёгкий", image: "images/skin-negev-light.png", rarity: "rare", weight: 20, value: 140 },
      { name: "AK-47 | Вулкан", image: "images/skin-ak-vulcan.png", rarity: "epic", weight: 15, value: 520 },
      { name: "Скелетный нож | Патина", image: "images/skin-skeleton-knife.png", rarity: "legendary", weight: 5, value: 1400 }
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
