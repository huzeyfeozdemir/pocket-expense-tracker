-- Pocket Expense Tracker — database schema (SQLite)
-- Money is stored in kuruş (1 TL = 100 kuruş) as INTEGER to avoid rounding errors.
-- Negative amount = money out, positive amount = money in.

PRAGMA foreign_keys = ON;

-- My bank accounts and credit cards
CREATE TABLE accounts (
    id    INTEGER PRIMARY KEY,
    bank  TEXT NOT NULL,                          -- e.g. 'Kuveyt Türk'
    name  TEXT NOT NULL,                          -- e.g. 'Vadesiz TL'
    type  TEXT NOT NULL CHECK (type IN ('bank', 'credit_card'))
);

-- Spending / income categories
CREATE TABLE categories (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    kind  TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'excluded'))
);

-- Every statement file I upload
CREATE TABLE imports (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    file_name   TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every single transaction from every bank
CREATE TABLE transactions (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    import_id    INTEGER REFERENCES imports(id),     -- NULL for manual entries
    date         TEXT NOT NULL,                      -- 'YYYY-MM-DD'
    description  TEXT NOT NULL,                      -- as written in the statement
    amount_kurus INTEGER NOT NULL,                   -- -20000 = -200,00 TL
    currency     TEXT NOT NULL DEFAULT 'TRY',
    category_id  INTEGER REFERENCES categories(id),  -- NULL until categorized
    source       TEXT NOT NULL CHECK (source IN ('import', 'manual')),
    needs_review INTEGER NOT NULL DEFAULT 0,         -- 1 = show in the review box
    fingerprint  TEXT NOT NULL,                      -- unique key built from the statement line
    UNIQUE (account_id, fingerprint)                 -- the same line can never be imported twice
);

-- "If the description contains X, the category is Y"
CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    keyword     TEXT NOT NULL UNIQUE,
    category_id INTEGER NOT NULL REFERENCES categories(id)
);

-- Starting categories
INSERT INTO categories (name, kind) VALUES
    ('Yemek', 'expense'), ('Market', 'expense'), ('Faturalar', 'expense'),
    ('Ulaşım', 'expense'), ('Eğlence', 'expense'), ('Giyim', 'expense'),
    ('Abonelik', 'expense'), ('Eğitim', 'expense'), ('Kişilere gönderim', 'expense'),
    ('Kredi kartı (detaysız)', 'expense'), ('Diğer', 'expense'),
    ('Burs', 'income'), ('Aile', 'income'), ('Maaş', 'income'), ('Diğer gelir', 'income'),
    ('Hesaplar arası transfer', 'excluded'), ('Kredi kartı ödemesi', 'excluded');

-- Starting rules
INSERT INTO rules (keyword, category_id) VALUES
    ('NETFA',            (SELECT id FROM categories WHERE name = 'Yemek')),
    ('A101',             (SELECT id FROM categories WHERE name = 'Market')),
    ('TURKCELL',         (SELECT id FROM categories WHERE name = 'Faturalar')),
    ('ISTANBULKART',     (SELECT id FROM categories WHERE name = 'Ulaşım')),
    ('YEMEKSEPETI',      (SELECT id FROM categories WHERE name = 'Yemek')),
    ('YOUTUBE',          (SELECT id FROM categories WHERE name = 'Abonelik')),
    ('BURS',             (SELECT id FROM categories WHERE name = 'Burs')),
    ('KREDI KARTI ODEME',(SELECT id FROM categories WHERE name = 'Kredi kartı (detaysız)'));
