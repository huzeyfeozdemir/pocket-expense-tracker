-- Cep Bütçe — main queries used by the app (js/db.js)
-- :m = month as 'YYYY-MM'

-- 1. Home: total income and expense of a month, all banks combined
SELECT
  COALESCE(SUM(CASE WHEN c.kind = 'income'  THEN t.amount_kurus END), 0)  AS income,
  COALESCE(SUM(CASE WHEN c.kind = 'expense' THEN -t.amount_kurus END), 0) AS expense
FROM transactions t
JOIN categories c ON c.id = t.category_id
WHERE strftime('%Y-%m', t.date) = :m;

-- 2. Home: expenses by category (donut chart)
SELECT c.name, c.color, SUM(-t.amount_kurus) AS total
FROM transactions t
JOIN categories c ON c.id = t.category_id
WHERE c.kind = 'expense' AND strftime('%Y-%m', t.date) = :m
GROUP BY c.id HAVING total > 0
ORDER BY total DESC;

-- 3. Home: expenses and income by bank
SELECT a.bank,
       COALESCE(SUM(CASE WHEN c.kind = 'expense' THEN -t.amount_kurus END), 0) AS expense,
       COALESCE(SUM(CASE WHEN c.kind = 'income'  THEN t.amount_kurus END), 0) AS income
FROM transactions t
JOIN accounts a ON a.id = t.account_id
LEFT JOIN categories c ON c.id = t.category_id
WHERE strftime('%Y-%m', t.date) = :m
GROUP BY a.bank ORDER BY expense DESC;

-- 4. After an import: categorize with rules
--    learned rules first, then by priority, then the longest (most specific) keyword
UPDATE transactions
SET category_id = (
      SELECT r.category_id FROM rules r
      WHERE transactions.search_text LIKE '%' || r.keyword || '%'
        AND (r.direction = 'any'
             OR (r.direction = 'out' AND transactions.amount_kurus < 0)
             OR (r.direction = 'in'  AND transactions.amount_kurus > 0))
      ORDER BY r.source = 'learned' DESC, r.priority, length(r.keyword) DESC
      LIMIT 1)
WHERE category_id IS NULL;

-- 5. Whatever is still unknown goes to the review box
UPDATE transactions SET needs_review = CASE WHEN category_id IS NULL THEN 1 ELSE 0 END;

-- 6. Transfers between my own accounts: same amount out of one account and into another within 2 days
SELECT o.id AS out_id, i.id AS in_id
FROM transactions o
JOIN transactions i
  ON i.amount_kurus = -o.amount_kurus
 AND i.account_id <> o.account_id
 AND abs(julianday(i.date) - julianday(o.date)) <= 2
WHERE o.amount_kurus < 0;

-- 7. Review box
SELECT t.id, t.date, t.description, t.amount_kurus, a.bank
FROM transactions t JOIN accounts a ON a.id = t.account_id
WHERE t.needs_review = 1
ORDER BY t.date DESC, t.id;
