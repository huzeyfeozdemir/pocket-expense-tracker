-- Cep Bütçe — database schema (SQLite, runs inside the browser via sql.js)
-- This is the same schema the app creates in js/db.js.
-- Money is stored in kuruş (1 TL = 100 kuruş) as INTEGER to avoid rounding errors.
-- Negative amount = money out, positive amount = money in.
--
-- accounts      my bank accounts, credit cards and cash wallet
-- categories    spending / income categories; 'excluded' ones (transfers) never count in totals
-- imports       every statement file I uploaded
-- transactions  every transaction from every bank; search_text = description without Turkish letters
-- rules         "if the description contains KEYWORD (and money goes in/out) → CATEGORY"
--               default rules ship with the app, learned rules come from the review box

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id    INTEGER PRIMARY KEY,
  bank  TEXT NOT NULL,
  name  TEXT NOT NULL,
  type  TEXT NOT NULL CHECK (type IN ('bank', 'credit_card', 'cash')),
  UNIQUE (bank, name)
);
CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  kind  TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'excluded')),
  color TEXT NOT NULL DEFAULT '#9aa5a0'
);
CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  file_name   TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  import_id    INTEGER REFERENCES imports(id),
  date         TEXT NOT NULL,
  description  TEXT NOT NULL,
  search_text  TEXT NOT NULL,
  amount_kurus INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'TRY',
  category_id  INTEGER REFERENCES categories(id),
  source       TEXT NOT NULL CHECK (source IN ('import', 'manual')),
  needs_review INTEGER NOT NULL DEFAULT 0,
  fingerprint  TEXT NOT NULL,
  UNIQUE (account_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY,
  keyword     TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('in', 'out', 'any')),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  priority    INTEGER NOT NULL DEFAULT 50,
  source      TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('default', 'learned')),
  UNIQUE (keyword, direction)
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_review ON transactions(needs_review);

-- Starting categories and rules are inserted by js/db.js (CATEGORIES, DEFAULT_RULES).
