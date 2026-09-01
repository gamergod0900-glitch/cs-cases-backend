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

  console.log("База данных готова: таблицы users, inventory, openings проверены/созданы");
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
