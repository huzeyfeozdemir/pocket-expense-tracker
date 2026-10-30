-- Pocket Expense Tracker — main queries used by the app

-- 1. Home screen: this month's income, expense and balance (all banks combined)
SELECT
    SUM(CASE WHEN c.kind = 'income'  THEN t.amount_kurus ELSE 0 END) / 100.0 AS income_tl,
    SUM(CASE WHEN c.kind = 'expense' THEN -t.amount_kurus ELSE 0 END) / 100.0 AS expense_tl,
    SUM(CASE WHEN c.kind IN ('income', 'expense') THEN t.amount_kurus ELSE 0 END) / 100.0 AS balance_tl
FROM transactions t
JOIN categories c ON c.id = t.category_id
WHERE strftime('%Y-%m', t.date) = '2026-10';

-- 2. Home screen: expenses by category (for the chart)
SELECT c.name AS category,
       SUM(-t.amount_kurus) / 100.0 AS total_tl
FROM transactions t
JOIN categories c ON c.id = t.category_id
WHERE c.kind = 'expense'
  AND strftime('%Y-%m', t.date) = '2026-10'
GROUP BY c.name
ORDER BY total_tl DESC;

-- 3. Home screen: expenses by bank
SELECT a.bank,
       SUM(-t.amount_kurus) / 100.0 AS total_tl
FROM transactions t
JOIN accounts a   ON a.id = t.account_id
JOIN categories c ON c.id = t.category_id
WHERE c.kind = 'expense'
  AND strftime('%Y-%m', t.date) = '2026-10'
GROUP BY a.bank;

-- 4. Review box: transactions waiting for my answer
SELECT t.id, t.date, a.bank, t.description, t.amount_kurus / 100.0 AS amount_tl
FROM transactions t
JOIN accounts a ON a.id = t.account_id
WHERE t.needs_review = 1
ORDER BY t.date;

-- 5. After import: apply rules to transactions without a category
UPDATE transactions
SET category_id = (
        SELECT r.category_id FROM rules r
        WHERE upper(transactions.description) LIKE '%' || r.keyword || '%'
        LIMIT 1),
    needs_review = 0
WHERE category_id IS NULL
  AND EXISTS (SELECT 1 FROM rules r
              WHERE upper(transactions.description) LIKE '%' || r.keyword || '%');

-- 6. Everything still without a category goes to the review box
UPDATE transactions SET needs_review = 1 WHERE category_id IS NULL;
