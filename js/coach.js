/*
 * coach.js — the "Koç" screen's numbers: weekly Finance Score, tips, streaks and badges.
 *
 * Everything is worked out from the data on the phone with simple rules (no AI, nothing is sent).
 * Statements arrive late, so "this week" means the 7 days ending at the newest transaction,
 * not the 7 days ending today. Only lira transactions count; euro is kept apart.
 *
 * Finance Score (0–100), like a sleep score:
 *   40  spending pace   this week's spending against a weekly allowance
 *                       (the budgets, or my usual weekly spending when there are none)
 *   25  budgets         how each budgeted category is doing so far this month
 *   25  saving          share of this month's income that is left over
 *   10  tidy            transactions waiting in the review box lower the score
 */
(function (global) {
  'use strict';

  const DAYS_PER_MONTH = 30.4;

  // "2026-10-31" + (-6) → "2026-10-25"
  function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysInMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // What I may spend in a day: the budgets spread over the month, or my average day so far
  function dailyAllowance(db, before) {
    const budgetTotal = db.budgets().reduce((t, b) => t + b.budget, 0);
    if (budgetTotal) return { kurus: budgetTotal / DAYS_PER_MONTH, fromBudgets: true };
    const range = db.dataRange();
    if (!range.first || range.first >= before) return null;
    const days = Math.max(1, Math.round((Date.parse(before) - Date.parse(range.first)) / 864e5));
    const spent = db.totalsBetween(range.first, addDays(before, -1)).expense;
    return spent > 0 ? { kurus: spent / days, fromBudgets: false } : null;
  }

  // Score of the 7 days ending at `end`
  function weekScore(db, end) {
    const start = addDays(end, -6);
    const month = end.slice(0, 7);
    const spent = db.totalsBetween(start, end).expense;

    const allowance = dailyAllowance(db, start);
    const weekly = allowance ? allowance.kurus * 7 : null;
    // ≤ allowance → full points, twice the allowance → none
    const pace = weekly ? clamp(40 * (2 - spent / weekly), 0, 40) : 20;

    // Budgets: compare with how much of the month has passed (spending 60% by the 15th is fine)
    const day = Number(end.slice(8));
    const share = day / daysInMonth(month);
    const status = db.budgetStatus(month, end);
    const budgetPts = status.length
      ? 25 * status.reduce((t, b) => t + clamp((1.5 - b.spent / (b.budget * share)) / 0.5, 0, 1), 0) / status.length
      : 15;

    // Saving: 20% of income left over (or more) → full points, spending 20% more than income → none
    const mtd = db.totalsBetween(month + '-01', end);
    const rate = mtd.income > 0 ? (mtd.income - mtd.expense) / mtd.income : (mtd.expense ? -1 : 0);
    const saving = clamp(25 * (rate + 0.2) / 0.4, 0, 25);

    const waiting = db.one(`SELECT COUNT(*) AS n FROM transactions
                            WHERE needs_review = 1 AND date BETWEEN :f AND :t`, { ':f': month + '-01', ':t': end }).n;
    const tidy = Math.max(0, 10 - 2 * waiting);

    return {
      start, end, spent, weekly, rate, waiting,
      score: Math.round(pace + budgetPts + saving + tidy),
      parts: { pace, budget: budgetPts, saving, tidy },
      hasBudgets: status.length > 0,
    };
  }

  function scoreLabel(score) {
    if (score >= 80) return 'Harika';
    if (score >= 60) return 'İyi';
    if (score >= 40) return 'Fena değil';
    return 'Dikkat';
  }

  // The newest week and the 3 before it (oldest first), for the small history bars
  function scores(db) {
    const range = db.dataRange();
    if (!range.last) return [];
    const weeks = [];
    for (let k = 3; k >= 0; k--) {
      const end = addDays(range.last, -7 * k);
      if (end < range.first) continue; // no data that far back
      weeks.push(weekScore(db, end));
    }
    return weeks;
  }

  // ---- Streaks: days in a row under the daily allowance ----
  function streaks(db) {
    const range = db.dataRange();
    if (!range.first) return { current: 0, best: 0, noSpendDays: 0, limit: null };
    const allowance = dailyAllowance(db, addDays(range.last, 1));
    if (!allowance) return { current: 0, best: 0, noSpendDays: 0, limit: null };
    const byDay = new Map(db.dailyExpense(range.first, range.last).map((r) => [r.date, r.expense]));
    let run = 0, best = 0;
    for (let d = range.first; d <= range.last; d = addDays(d, 1)) {
      run = (byDay.get(d) || 0) <= allowance.kurus ? run + 1 : 0;
      best = Math.max(best, run);
    }
    // No-spend days in the newest month
    const month = range.last.slice(0, 7);
    let noSpendDays = 0;
    for (let d = month + '-01'; d <= range.last; d = addDays(d, 1)) if (!(byDay.get(d) > 0)) noSpendDays++;
    return { current: run, best, noSpendDays, limit: allowance.kurus, fromBudgets: allowance.fromBudgets };
  }

  // ---- Tips: plain sentences from the newest month compared with the one before ----
  // Each tip: { icon, text, tone: 'good' | 'warn' | 'info' }
  function tips(db, tl) {
    const months = db.months();
    if (!months.length) return [];
    const month = months[0];
    const [y, m] = month.split('-').map(Number);
    const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const out = [];

    // Budgets close to or over the limit
    for (const b of db.budgetStatus(month)) {
      const pct = Math.round((b.spent / b.budget) * 100);
      if (pct > 100) out.push({ icon: '🚨', tone: 'warn', text: `${b.name} bütçeni aştın: ${tl(b.spent - b.budget)} fazla (%${pct}).` });
      else if (pct >= 80) out.push({ icon: '⚠️', tone: 'warn', text: `${b.name} bütçenin %${pct}'ini kullandın, ${tl(b.budget - b.spent)} kaldı.` });
    }

    // Categories that went up or down a lot since last month
    if (months.includes(prevMonth)) {
      const before = new Map(db.byCategory(prevMonth).map((c) => [c.id, c.total]));
      const changes = db.byCategory(month)
        .map((c) => ({ ...c, before: before.get(c.id) || 0 }))
        .filter((c) => c.before > 0)
        .map((c) => ({ ...c, pct: Math.round(((c.total - c.before) / c.before) * 100), diff: c.total - c.before }));
      for (const c of changes.filter((c) => c.pct >= 30 && c.diff >= 20000).sort((a, b) => b.diff - a.diff).slice(0, 2)) {
        out.push({ icon: '📈', tone: 'warn', text: `${c.name} harcaman geçen aya göre %${c.pct} arttı (+${tl(c.diff)}).` });
      }
      for (const c of changes.filter((c) => c.pct <= -20 && -c.diff >= 20000).sort((a, b) => a.diff - b.diff).slice(0, 1)) {
        out.push({ icon: '👏', tone: 'good', text: `${c.name} harcaman geçen aya göre %${-c.pct} azaldı (−${tl(-c.diff)}).` });
      }
    }

    // Saving rate of the month
    const s = db.summary(month);
    if (s.income > 0) {
      const rate = Math.round(((s.income - s.expense) / s.income) * 100);
      if (rate < 0) out.push({ icon: '🔻', tone: 'warn', text: `Bu ay gelirinden ${tl(s.expense - s.income)} fazla harcadın.` });
      else if (rate >= 20) out.push({ icon: '💪', tone: 'good', text: `Bu ay gelirinin %${rate}'ini biriktirdin.` });
    }

    // One category taking most of the money
    const cats = db.byCategory(month);
    const total = cats.reduce((t, c) => t + c.total, 0);
    if (cats.length > 1 && cats[0].total / total >= 0.4) {
      out.push({ icon: '🔎', tone: 'info', text: `Bu ayki harcamanın %${Math.round((cats[0].total / total) * 100)}'i ${cats[0].name}.` });
    }

    const waiting = db.reviewQueue().length;
    if (waiting) out.push({ icon: '❓', tone: 'info', text: `${waiting} işlem kategorisiz; incele ki toplamlar doğru olsun.`, go: 'review' });
    if (!db.budgets().length) out.push({ icon: '🎯', tone: 'info', text: 'Kategorilere aylık bütçe koyarsan puanın ve uyarılar daha doğru olur.' });
    for (const g of db.goals()) {
      if (g.saved >= g.target) out.push({ icon: '🏆', tone: 'good', text: `"${g.name}" hedefine ulaştın!` });
    }
    return out;
  }

  // ---- Badges ----
  function badges(db, streak) {
    const months = db.months();
    const has = (sql) => db.one(sql).n > 0;
    // A full month where every budget was kept (not the newest month: it may still be going)
    const keptMonth = db.budgets().length > 0 && months.slice(1).some((m) => db.budgetStatus(m).every((b) => b.spent <= b.budget));
    const savedMonth = months.some((m) => { const s = db.summary(m); return s.income > 0 && (s.income - s.expense) / s.income >= 0.2; });
    return [
      { icon: '📄', name: 'İlk ekstre', earned: has('SELECT COUNT(*) AS n FROM imports') },
      { icon: '🏦', name: '3 banka bir arada', earned: db.banks().filter((b) => b !== 'Nakit').length >= 3 },
      { icon: '🧹', name: 'Temiz kutu', earned: months.length > 0 && db.reviewQueue().length === 0 },
      { icon: '🔥', name: '7 gün seri', earned: streak.best >= 7 },
      { icon: '⚡', name: '30 gün seri', earned: streak.best >= 30 },
      { icon: '🎯', name: 'Bütçe ustası', earned: keptMonth },
      { icon: '🐷', name: 'Birikimci', earned: savedMonth },
      { icon: '🏆', name: 'Hedefe ulaştın', earned: db.goals().some((g) => g.saved >= g.target) },
    ];
  }

  global.Coach = { weekScore, scores, scoreLabel, streaks, tips, badges, addDays };
})(window);
