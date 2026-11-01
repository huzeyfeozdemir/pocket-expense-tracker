/*
 * db.js — the app's database: SQLite running inside the browser (sql.js).
 *
 * - All data lives on this device only. After every change the whole
 *   database file is saved to the browser's IndexedDB storage.
 * - Money is stored in kuruş as whole numbers (200,00 TL = -20000).
 * - Categorizing, duplicate checks and all summaries are done with SQL.
 */
(function (global) {
  'use strict';

  const SCHEMA = `
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
  `;

  // name, kind, chart color
  const CATEGORIES = [
    ['Yemek', 'expense', '#e07a5f'],
    ['Market', 'expense', '#f2a65a'],
    ['Faturalar', 'expense', '#3d5a80'],
    ['Ulaşım', 'expense', '#5fa8d3'],
    ['Eğlence', 'expense', '#9b5de5'],
    ['Giyim', 'expense', '#f15bb5'],
    ['Abonelik', 'expense', '#00b4a6'],
    ['Eğitim', 'expense', '#2a9d8f'],
    ['Kişisel bakım', 'expense', '#c9a227'],
    ['Alışveriş', 'expense', '#8d6e63'],
    ['Kişilere gönderim', 'expense', '#6c757d'],
    ['Kredi kartı (detaysız)', 'expense', '#495057'],
    ['Diğer', 'expense', '#adb5bd'],
    ['Burs', 'income', '#2f9e6f'],
    ['Aile', 'income', '#52b788'],
    ['Maaş', 'income', '#40916c'],
    ['Diğer gelir', 'income', '#95d5b2'],
    ['Hesaplar arası transfer', 'excluded', '#ced4da'],
    ['Kredi kartı ödemesi', 'excluded', '#ced4da'],
  ];

  // keyword (already normalized: no Turkish letters, upper case), direction, category, priority
  // Lower priority number = checked first. Generic "money transfer" rules come last.
  const DEFAULT_RULES = [
    ['NETFA', 'out', 'Yemek', 40],
    ['KAHVE', 'out', 'Yemek', 50], ['CAFE', 'out', 'Yemek', 50], ['STARBUCKS', 'out', 'Yemek', 50],
    ['YEMEKSEPETI', 'out', 'Yemek', 50], ['GETIR', 'out', 'Yemek', 50], ['CHICKEN', 'out', 'Yemek', 50],
    ['BURGER', 'out', 'Yemek', 50], ['PIZZA', 'out', 'Yemek', 50], ['KOMAGENE', 'out', 'Yemek', 50],
    ['DONER', 'out', 'Yemek', 50], ['LAHMACUN', 'out', 'Yemek', 50],
    ['A101', 'out', 'Market', 50], ['MIGROS', 'out', 'Market', 50], ['CARREFOUR', 'out', 'Market', 50],
    ['SOK MARKET', 'out', 'Market', 50], ['BIM BIRLESIK', 'out', 'Market', 50],
    ['TURKCELL', 'out', 'Faturalar', 50], ['VODAFONE', 'out', 'Faturalar', 50],
    ['TT MOBIL', 'out', 'Faturalar', 50], ['TURK TELEKOM', 'out', 'Faturalar', 50],
    ['FATURA', 'out', 'Faturalar', 60],
    ['ISTANBULKART', 'out', 'Ulaşım', 50], ['BELBIM', 'out', 'Ulaşım', 50], ['MARTI', 'out', 'Ulaşım', 55],
    ['BITAKSI', 'out', 'Ulaşım', 50], ['UBER', 'out', 'Ulaşım', 55],
    ['YOUTUBE', 'out', 'Abonelik', 50], ['SPOTIFY', 'out', 'Abonelik', 50], ['NETFLIX', 'out', 'Abonelik', 50],
    ['AMZNPR', 'out', 'Abonelik', 45], ['OPENAI', 'out', 'Abonelik', 50], ['CHATGPT', 'out', 'Abonelik', 50],
    ['APPLE.COM', 'out', 'Abonelik', 50],
    ['GRATIS', 'out', 'Kişisel bakım', 50], ['WATSONS', 'out', 'Kişisel bakım', 50],
    ['TRENDYOL', 'out', 'Alışveriş', 60], ['AMAZON', 'out', 'Alışveriş', 60], ['HEPSIBURADA', 'out', 'Alışveriş', 60],
    ['YUZME', 'out', 'Eğlence', 50], ['SINEMA', 'out', 'Eğlence', 50],
    ['BURS', 'in', 'Burs', 40], ['KREDI YURTLAR', 'in', 'Burs', 40],
    ['KREDI KARTI', 'out', 'Kredi kartı (detaysız)', 30], ['KART BORCU', 'out', 'Kredi kartı (detaysız)', 30],
    ['KK ODEME', 'out', 'Kredi kartı (detaysız)', 30],
    // Money sent to people: only after every shop/brand rule had its chance
    ['FAST PARA TRANSFERI', 'out', 'Kişilere gönderim', 90],
    ['PARA TRANSFERI', 'out', 'Kişilere gönderim', 95],
    ['HAVALE', 'out', 'Kişilere gönderim', 95],
  ];

  // "Kredi Kartı Ödemesi" → "KREDI KARTI ODEMESI": makes rules work with or without Turkish letters
  function normalize(text) {
    return String(text)
      .toLocaleUpperCase('tr-TR')
      .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
      .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Suggest a short keyword to remember a place: "Firma Adı: YIRMIBIRCO KAHVE ISTANBUL,Harcama" → "YIRMIBIRCO KAHVE"
  function suggestKeyword(description, amountKurus = -1) {
    let t = normalize(description);
    // Money transfer: remember the other person (receiver if I sent it, sender if I received it)
    if (/FAST|PARA TRANSFERI|HAVALE/.test(t)) {
      const field = amountKurus < 0 ? 'ALICI' : 'GONDEREN';
      const m = t.match(new RegExp(field + '\\s*:\\s*([A-Z ]+?)\\s*(?:,|$)'));
      if (m) return m[1].trim().split(' ').slice(0, 3).join(' ');
    }
    t = t
      .replace(/FIRMA ADI\s*:/g, ' ')
      .replace(/\b(POS|EPOS|TMSZ)\b/g, ' ')
      .replace(/IYZICO\s*[/*]?|PAYCELL\s*\/?/g, ' ')
      .replace(/,\s*HARCAMA.*$/, ' ')
      .replace(/\b(ISTANBUL|ANKARA|IZMIR|IST)\b/g, ' ')
      .replace(/[*/,]/g, ' ')
      .replace(/\b\d+\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return t.split(' ').slice(0, 2).join(' ');
  }

  // ---------- Saving the database file in IndexedDB ----------

  const IDB_NAME = 'cep-butce';
  const IDB_STORE = 'files';

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const r = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbPut(key, value) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- The Database object ----------

  class Database {
    constructor(SQL, bytes) {
      this.SQL = SQL;
      this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
      this.db.run('PRAGMA foreign_keys = ON;');
      this.db.run(SCHEMA);
      this.migrate();
      this.seed();
    }

    // Columns added after the first version: add them to databases created earlier
    migrate() {
      const cols = this.all('PRAGMA table_info(transactions)').map((c) => c.name);
      if (!cols.includes('ocr')) this.db.run('ALTER TABLE transactions ADD COLUMN ocr INTEGER NOT NULL DEFAULT 0');
    }

    static async open(SQL, { persist = true } = {}) {
      const bytes = persist ? await idbGet('main.sqlite').catch(() => null) : null;
      const d = new Database(SQL, bytes || null);
      d.persist = persist;
      return d;
    }

    async save() {
      if (this.persist) await idbPut('main.sqlite', this.db.export());
    }

    // Run a SELECT and get rows as plain objects
    all(sql, params = {}) {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
    one(sql, params = {}) {
      return this.all(sql, params)[0] || null;
    }
    run(sql, params = {}) {
      this.db.run(sql, params);
      return this.db.getRowsModified();
    }

    seed() {
      for (const [name, kind, color] of CATEGORIES) {
        this.run('INSERT OR IGNORE INTO categories (name, kind, color) VALUES (:n, :k, :c)', { ':n': name, ':k': kind, ':c': color });
      }
      for (const [keyword, direction, category, priority] of DEFAULT_RULES) {
        this.run(
          `INSERT OR IGNORE INTO rules (keyword, direction, category_id, priority, source)
           SELECT :kw, :dir, id, :p, 'default' FROM categories WHERE name = :cat`,
          { ':kw': keyword, ':dir': direction, ':p': priority, ':cat': category }
        );
      }
    }

    accountId(bank, name = 'Vadesiz TL', type = 'bank') {
      this.run('INSERT OR IGNORE INTO accounts (bank, name, type) VALUES (:b, :n, :t)', { ':b': bank, ':n': name, ':t': type });
      return this.one('SELECT id FROM accounts WHERE bank = :b AND name = :n', { ':b': bank, ':n': name }).id;
    }

    // ---- Import a parsed statement ----
    importStatement(bankName, rows, fileName) {
      const accountId = this.accountId(bankName);
      this.run('INSERT INTO imports (account_id, file_name) VALUES (:a, :f)', { ':a': accountId, ':f': fileName });
      const importId = this.one('SELECT last_insert_rowid() AS id').id;

      let added = 0;
      this.db.run('BEGIN');
      for (const r of rows) {
        added += this.run(
          `INSERT OR IGNORE INTO transactions
             (account_id, import_id, date, description, search_text, amount_kurus, source, fingerprint, ocr)
           VALUES (:a, :i, :d, :desc, :s, :amt, 'import', :fp, :ocr)`,
          { ':a': accountId, ':i': importId, ':d': r.date, ':desc': r.description, ':s': normalize(r.description), ':amt': r.amountKurus, ':fp': r.fingerprint, ':ocr': r.uncertain ? 1 : 0 }
        );
      }
      this.db.run('COMMIT');

      const before = this.one('SELECT COUNT(*) AS n FROM transactions WHERE import_id = :i AND category_id IS NULL', { ':i': importId }).n;
      this.categorize();
      const transfers = this.detectTransfers();
      // Rows read from a photo whose numbers did not add up: always ask me to check them
      this.run('UPDATE transactions SET needs_review = 1 WHERE import_id = :i AND ocr = 1', { ':i': importId });
      const toReview = this.one('SELECT COUNT(*) AS n FROM transactions WHERE import_id = :i AND needs_review = 1', { ':i': importId }).n;
      return { found: rows.length, added, skipped: rows.length - added, autoCategorized: before - toReview, toReview, transfers };
    }

    // ---- Rules: give every uncategorized transaction a category if a rule matches ----
    categorize() {
      this.run(`
        UPDATE transactions
        SET category_id = (
              SELECT r.category_id FROM rules r
              WHERE transactions.search_text LIKE '%' || r.keyword || '%'
                AND (r.direction = 'any'
                     OR (r.direction = 'out' AND transactions.amount_kurus < 0)
                     OR (r.direction = 'in'  AND transactions.amount_kurus > 0))
              ORDER BY r.source = 'learned' DESC, r.priority, length(r.keyword) DESC
              LIMIT 1)
        WHERE category_id IS NULL`);
      // Whatever is still unknown goes to the review box
      this.run('UPDATE transactions SET needs_review = 1 WHERE category_id IS NULL');
    }

    // ---- Money moved between my own accounts: same amount out of one, into another, within 2 days ----
    detectTransfers() {
      const transferId = this.one("SELECT id FROM categories WHERE name = 'Hesaplar arası transfer'").id;
      const pairs = this.all(`
        SELECT o.id AS out_id, i.id AS in_id
        FROM transactions o
        JOIN transactions i
          ON i.amount_kurus = -o.amount_kurus
         AND i.account_id <> o.account_id
         AND abs(julianday(i.date) - julianday(o.date)) <= 2
        LEFT JOIN categories oc ON oc.id = o.category_id
        LEFT JOIN categories ic ON ic.id = i.category_id
        WHERE o.amount_kurus < 0
          AND (o.category_id IS NULL OR oc.name = 'Kişilere gönderim')
          AND (i.category_id IS NULL)
          AND o.source = 'import' AND i.source = 'import'`);
      const used = new Set();
      for (const p of pairs) {
        if (used.has(p.out_id) || used.has(p.in_id)) continue;
        used.add(p.out_id); used.add(p.in_id);
        this.run('UPDATE transactions SET category_id = :c, needs_review = 0 WHERE id IN (:a, :b)', { ':c': transferId, ':a': p.out_id, ':b': p.in_id });
      }
      return used.size / 2;
    }

    // ---- Review box ----
    reviewQueue() {
      return this.all(`
        SELECT t.id, t.date, t.description, t.amount_kurus, t.category_id, t.ocr, a.bank
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.needs_review = 1
        ORDER BY t.date DESC, t.id`);
    }

    setCategory(txId, categoryId, keyword) {
      this.run('UPDATE transactions SET category_id = :c, needs_review = 0, ocr = 0 WHERE id = :t', { ':c': categoryId, ':t': txId });
      let alsoCategorized = 0;
      if (keyword && normalize(keyword).length >= 3) {
        const tx = this.one('SELECT amount_kurus FROM transactions WHERE id = :t', { ':t': txId });
        const direction = tx.amount_kurus < 0 ? 'out' : 'in';
        this.run(
          `INSERT INTO rules (keyword, direction, category_id, priority, source) VALUES (:k, :d, :c, 10, 'learned')
           ON CONFLICT (keyword, direction) DO UPDATE SET category_id = excluded.category_id, source = 'learned', priority = 10`,
          { ':k': normalize(keyword), ':d': direction, ':c': categoryId }
        );
        // Apply the new rule to everything still waiting in the review box
        alsoCategorized = this.run(
          `UPDATE transactions SET category_id = :c, needs_review = 0
           WHERE needs_review = 1 AND search_text LIKE '%' || :k || '%'
             AND ((:d = 'out' AND amount_kurus < 0) OR (:d = 'in' AND amount_kurus > 0))`,
          { ':c': categoryId, ':k': normalize(keyword), ':d': direction }
        );
      }
      return alsoCategorized;
    }

    addManual({ date, description, amountKurus, categoryId }) {
      const accountId = this.accountId('Nakit', 'Cüzdan', 'cash');
      this.run(
        `INSERT INTO transactions (account_id, date, description, search_text, amount_kurus, category_id, source, fingerprint)
         VALUES (:a, :d, :desc, :s, :amt, :c, 'manual', :fp)`,
        { ':a': accountId, ':d': date, ':desc': description, ':s': normalize(description), ':amt': amountKurus, ':c': categoryId, ':fp': `MANUAL|${Date.now()}|${Math.random()}` }
      );
    }

    deleteTransaction(id) {
      this.run("DELETE FROM transactions WHERE id = :id AND source = 'manual'", { ':id': id });
    }

    // ---- Queries for the screens ----
    categories() {
      return this.all('SELECT id, name, kind, color FROM categories ORDER BY kind, id');
    }
    months() {
      return this.all("SELECT DISTINCT strftime('%Y-%m', date) AS month FROM transactions ORDER BY month DESC").map((r) => r.month);
    }
    banks() {
      return this.all('SELECT DISTINCT a.bank FROM accounts a JOIN transactions t ON t.account_id = a.id ORDER BY a.bank').map((r) => r.bank);
    }
    summary(month) {
      return this.one(`
        SELECT
          COALESCE(SUM(CASE WHEN c.kind = 'income'  THEN t.amount_kurus END), 0)  AS income,
          COALESCE(SUM(CASE WHEN c.kind = 'expense' THEN -t.amount_kurus END), 0) AS expense
        FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE strftime('%Y-%m', t.date) = :m`, { ':m': month });
    }
    pendingInMonth(month) {
      return this.one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_kurus), 0) AS total FROM transactions
                       WHERE needs_review = 1 AND strftime('%Y-%m', date) = :m`, { ':m': month });
    }
    byCategory(month) {
      return this.all(`
        SELECT c.name, c.color, SUM(-t.amount_kurus) AS total
        FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE c.kind = 'expense' AND strftime('%Y-%m', t.date) = :m
        GROUP BY c.id HAVING total > 0
        ORDER BY total DESC`, { ':m': month });
    }
    byBank(month) {
      return this.all(`
        SELECT a.bank,
               COALESCE(SUM(CASE WHEN c.kind = 'expense' THEN -t.amount_kurus END), 0) AS expense,
               COALESCE(SUM(CASE WHEN c.kind = 'income'  THEN t.amount_kurus END), 0) AS income
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE strftime('%Y-%m', t.date) = :m
        GROUP BY a.bank ORDER BY expense DESC`, { ':m': month });
    }
    transactions({ month, bank, categoryId } = {}) {
      return this.all(`
        SELECT t.id, t.date, t.description, t.amount_kurus, t.needs_review, t.source,
               a.bank, c.id AS category_id, c.name AS category, c.kind, c.color
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE (:m IS NULL OR strftime('%Y-%m', t.date) = :m)
          AND (:b IS NULL OR a.bank = :b)
          AND (:c IS NULL OR t.category_id = :c OR (:c = -1 AND t.needs_review = 1))
        ORDER BY t.date DESC, t.id DESC`,
        { ':m': month || null, ':b': bank || null, ':c': categoryId == null ? null : categoryId });
    }
    learnedRules() {
      return this.all(`SELECT r.id, r.keyword, c.name AS category FROM rules r JOIN categories c ON c.id = r.category_id
                       WHERE r.source = 'learned' ORDER BY r.id DESC`);
    }
    deleteRule(id) {
      this.run("DELETE FROM rules WHERE id = :id AND source = 'learned'", { ':id': id });
    }

    // ---- Backup ----
    exportBytes() {
      return this.db.export();
    }
    async replaceWith(bytes) {
      const next = new this.SQL.Database(bytes);
      next.exec('SELECT COUNT(*) FROM transactions'); // throws if it is not our database
      this.db.close();
      this.db = next;
      this.db.run(SCHEMA);
      this.migrate();
      this.seed();
      await this.save();
    }
    async wipe() {
      this.db.close();
      this.db = new this.SQL.Database();
      this.db.run(SCHEMA);
      this.migrate();
      this.seed();
      await this.save();
    }
  }

  const api = { Database, normalize, suggestKeyword, SCHEMA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AppDB = api;
})(typeof window !== 'undefined' ? window : globalThis);
