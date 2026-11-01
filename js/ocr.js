/*
 * ocr.js — reads bank statements that were saved as a picture (Ziraat's mobile app does this).
 *
 * Plain OCR on a small, blurry picture makes mistakes ("−242,24" → "-24224", "0" → "O").
 * So we do not trust a single reading. Steps:
 *
 *  1. Layout: read the whole page once to find the column headers (Tarih, Fiş No,
 *     Açıklama, Tutar, Bakiye) and every row (each row starts with a date).
 *  2. Numbers: cut out each date / amount / balance cell and read it again with an OCR
 *     that only knows digits, at three different zoom settings. Each reading is a "vote".
 *  3. Checking: for every row, "balance change = amount" must hold, and the totals printed
 *     at the bottom ("Borç", "Alacak") must add up. Among the votes we pick the numbers that
 *     satisfy these rules. Rows that still do not add up are flagged for review.
 *
 * Output: { text, rows: [{ date, description, amountKurus, balanceKurus, uncertain, fingerprint }] }
 */
(function (global) {
  'use strict';

  const TESS = { workerPath: 'lib/tesseract/worker.min.js', corePath: 'lib/tesseract/', langPath: 'lib/tesseract', gzip: true };
  const LAYOUT_SCALE = 3;
  // Different zoom settings make different mistakes; together they out-vote them
  const PASSES = [
    { scale: 2, up: 3, threshold: 0 },
    { scale: 3, up: 2, threshold: 0 },
    { scale: 2, up: 4, threshold: 160 },
  ];

  let textWorker = null;
  let digitWorker = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('OCR dosyaları yüklenemedi. İnternet bağlantını kontrol et.'));
      document.head.appendChild(s);
    });
  }

  async function getWorkers(status) {
    if (textWorker && digitWorker) return;
    status('fotoğraf PDF — yazı tanıma (OCR) hazırlanıyor, ilk seferde biraz sürer…');
    if (!global.Tesseract) await loadScript('lib/tesseract/tesseract.min.js');
    textWorker = await Tesseract.createWorker('tur', 1, TESS);
    digitWorker = await Tesseract.createWorker('tur', 1, TESS);
    // Only digits, dot, comma and minus; the picture is one line of text
    await digitWorker.setParameters({ tessedit_char_whitelist: '0123456789.,-', tessedit_pageseg_mode: '7' });
  }

  async function renderPage(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }

  // Cut a rectangle (in PDF units) out of the page picture, enlarge it and optionally make it black & white
  function cutCell(canvas, scale, box, up, threshold) {
    const x = box.x0 * scale, y = box.y0 * scale, w = (box.x1 - box.x0) * scale, h = (box.y1 - box.y0) * scale;
    const c = document.createElement('canvas');
    c.width = Math.round(w * up) + 40;
    c.height = Math.round(h * up) + 40;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, x, y, w, h, 20, 20, w * up, h * up);
    if (threshold) {
      const img = g.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < threshold ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      g.putImageData(img, 0, 0);
    }
    return c;
  }

  // ---------- Turning a reading into a value ----------

  // Ziraat always prints 2 decimals, so the last two digits are kuruş: "-24224" → 24224 kuruş = 242,24 TL
  function readMoney(raw) {
    const digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.length < 3 || digits.length > 12) return null;
    return { value: parseInt(digits, 10), minus: /-/.test(raw) };
  }

  // "130.10.2026" or "10.102026" → keep the last 8 digits → "2026-10-30"
  function readDate(raw) {
    const digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.length < 8) return null;
    const d = digits.slice(-8);
    const day = +d.slice(0, 2), month = +d.slice(2, 4), year = +d.slice(4);
    if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000 || year > 2100) return null;
    return `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
  }

  // Votes: { value → count }, best first
  function ranked(values) {
    const counts = new Map();
    for (const v of values) if (v != null) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }

  // ---------- 1. Layout ----------

  async function readLayout(page, status) {
    const canvas = await renderPage(page, LAYOUT_SCALE);
    const { data } = await textWorker.recognize(canvas, {}, { blocks: true, text: true });
    const words = [];
    for (const b of data.blocks || [])
      for (const p of b.paragraphs)
        for (const l of p.lines)
          for (const w of l.words) {
            const s = LAYOUT_SCALE;
            words.push({ t: w.text, x0: w.bbox.x0 / s, x1: w.bbox.x1 / s, y0: w.bbox.y0 / s, y1: w.bbox.y1 / s });
          }
    return { text: data.text, words };
  }

  function findColumns(words) {
    const desc = words.find((w) => /klama/i.test(w.t)); // "Açıklama"
    if (!desc) return null;
    const mid = (w) => (w.y0 + w.y1) / 2;
    const onHeader = words.filter((w) => Math.abs(mid(w) - mid(desc)) < (desc.y1 - desc.y0) * 1.5);
    const date = onHeader.find((w) => /tar/i.test(w.t) && w.x1 < desc.x0);
    const slip = onHeader.find((w) => /^f/i.test(w.t) && w.x1 < desc.x0 && (!date || w.x0 > date.x1));
    const amount = onHeader.find((w) => /tut/i.test(w.t));
    const balance = onHeader.find((w) => /bak/i.test(w.t));
    if (!amount || !balance) return null;
    return {
      headerY: desc.y1,
      dateX0: (date ? date.x0 : 0) - 3,
      slipX0: slip ? slip.x0 - 3 : desc.x0 * 0.45,
      descX0: desc.x0 - 3,
      amountX0: amount.x0 - 4,
      balanceX0: balance.x0 - 4,
      balanceX1: balance.x1 + 30,
    };
  }

  // ---------- 3. Checking with the balance and the totals ----------

  function solve(rows, debitVotes, creditVotes) {
    // Oldest first: decide from the dates (the list may be newest-first)
    const first = rows[0].date, last = rows[rows.length - 1].date;
    const chron = first && last && first > last ? rows.slice().reverse() : rows.slice();

    let best = null;
    for (const startBalance of chron[0].balances.slice(0, 3).concat(chron[0].balances.length ? [] : [null])) {
      const pick = [{ row: chron[0], amount: chron[0].amounts[0], balance: startBalance, checked: false }];
      let score = 0;
      for (let k = 1; k < chron.length; k++) {
        const r = chron[k];
        const prev = pick[k - 1].balance;
        let chosen = null;
        if (prev != null) {
          // a pair (amount, balance) from the votes where balance change = amount
          outer: for (const a of r.amounts) for (const b of r.balances) {
            if (Math.abs(b - prev) === a) { chosen = { amount: a, balance: b, checked: true }; break outer; }
          }
          // balance misread but amount fine: the next row will confirm the repaired balance
          if (!chosen && k + 1 < chron.length) {
            const next = chron[k + 1];
            outer2: for (const a of r.amounts) for (const s of [1, -1]) {
              const b = prev + s * a;
              for (const a2 of next.amounts) for (const b2 of next.balances) {
                if (Math.abs(b2 - b) === a2) { chosen = { amount: a, balance: b, checked: true }; break outer2; }
              }
            }
          }
        }
        if (chosen) score++;
        else chosen = { amount: r.amounts[0], balance: r.balances[0] ?? null, checked: false };
        pick.push({ row: r, ...chosen });
      }
      if (!best || score > best.score) best = { pick, score };
    }

    // Signs: money in if the balance went up
    const out = best.pick.map((p, k) => {
      const prev = k > 0 ? best.pick[k - 1].balance : null;
      let sign = p.row.minusVotes > p.row.passes / 2 ? -1 : 1;
      if (p.checked && prev != null) sign = p.balance < prev ? -1 : 1;
      return { ...p, amountKurus: p.amount == null ? null : sign * p.amount };
    });

    // The oldest row has no earlier balance: its sign is the one that makes the totals add up
    const oldest = out[0];
    if (oldest.amount != null && creditVotes.length) {
      const otherIn = out.slice(1).filter((p) => p.amountKurus > 0).reduce((a, p) => a + p.amountKurus, 0);
      if (creditVotes.includes(otherIn + oldest.amount)) oldest.amountKurus = oldest.amount;
      else if (creditVotes.includes(otherIn)) oldest.amountKurus = -oldest.amount;
    }

    // Final proof: the printed "Borç" and "Alacak" totals must match what we read
    const inSum = out.filter((p) => p.amountKurus > 0).reduce((a, p) => a + p.amountKurus, 0);
    const outSum = out.filter((p) => p.amountKurus < 0).reduce((a, p) => a - p.amountKurus, 0);
    const haveTotals = creditVotes.length > 0 && debitVotes.length > 0;
    const totalsOk = haveTotals && creditVotes.includes(inSum) && debitVotes.includes(outSum);
    for (const p of out) p.uncertain = totalsOk ? false : !p.checked || p.amountKurus == null;
    // Totals printed but not matching while every row looked fine: something is off, check all
    if (haveTotals && !totalsOk && out.every((p) => !p.uncertain)) out.forEach((p) => (p.uncertain = true));

    const byRow = new Map(out.map((p) => [p.row, p]));
    return rows.map((r) => byRow.get(r));
  }

  // ---------- Main ----------

  async function readImageStatement(pdfjsLib, data, status = () => {}, password) {
    await getWorkers(status);
    const doc = await pdfjsLib.getDocument({ data, password }).promise;
    const allRows = [];
    const debitReads = [];
    const creditReads = [];
    let fullText = '';
    let columns = null;

    for (let p = 1; p <= doc.numPages; p++) {
      status(`fotoğraf okunuyor: sayfa ${p}/${doc.numPages} — satırlar bulunuyor…`);
      const page = await doc.getPage(p);
      const { text, words } = await readLayout(page, status);
      fullText += text + '\n';
      columns = findColumns(words) || columns; // later pages may have no header
      if (!columns) continue;

      const headerY = findColumns(words) ? columns.headerY : 0;
      const anchors = words.filter(
        (w) => w.x1 < columns.slipX0 && w.y0 > headerY && w.t.replace(/[^0-9]/g, '').length >= 7
      );
      if (!anchors.length) continue;
      const lineH = Math.max(...anchors.map((a) => a.y1 - a.y0));
      const mid = (w) => (w.y0 + w.y1) / 2;

      // Description words belong to the closest row (a long description wraps over two lines)
      const descWords = words.filter((w) => w.x0 >= columns.descX0 && w.x1 <= columns.amountX0 + 2 && w.y0 > headerY);
      const lastY = mid(anchors[anchors.length - 1]) + lineH * 1.8;
      const rows = anchors.map((a) => ({
        y: mid(a),
        description: '',
        dates: [readDate(a.t)],
        amountReads: [],
        balanceReads: [],
      }));
      for (const r of rows) {
        const mine = descWords.filter((w) => {
          const nearest = rows.reduce((best, x) => (Math.abs(x.y - mid(w)) < Math.abs(best.y - mid(w)) ? x : best));
          return nearest === r && Math.abs(mid(w) - r.y) < lineH * 1.8 && mid(w) < lastY;
        });
        // Group the words into text lines (top to bottom), then read each line left to right
        const lines = [];
        for (const w of mine.sort((a, b) => mid(a) - mid(b))) {
          const line = lines[lines.length - 1];
          if (line && Math.abs(mid(w) - line.y) < lineH * 0.5) line.words.push(w);
          else lines.push({ y: mid(w), words: [w] });
        }
        r.description = lines
          .map((l) => l.words.sort((a, b) => a.x0 - b.x0).map((w) => w.t).join(' '))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      const totals = words.filter((w) => /^(bor|ala)/i.test(w.t) && w.x0 < columns.descX0 && w.y0 > headerY);

      // 2. Read every number cell again, digits only, at several zoom settings
      for (let i = 0; i < PASSES.length; i++) {
        const pass = PASSES[i];
        status(`fotoğraf okunuyor: sayfa ${p}/${doc.numPages} — rakamlar kontrol ediliyor (${i + 1}/${PASSES.length})…`);
        const canvas = await renderPage(page, pass.scale);
        const read = async (box) => (await digitWorker.recognize(cutCell(canvas, pass.scale, box, pass.up, pass.threshold))).data.text.trim();
        for (const r of rows) {
          const y0 = r.y - lineH * 1.1, y1 = r.y + lineH * 1.1;
          r.dates.push(readDate(await read({ x0: columns.dateX0, x1: columns.slipX0 - 2, y0, y1 })));
          r.amountReads.push(readMoney(await read({ x0: columns.amountX0, x1: columns.balanceX0 - 2, y0, y1 })));
          r.balanceReads.push(readMoney(await read({ x0: columns.balanceX0, x1: columns.balanceX1, y0, y1 })));
        }
        for (const t of totals) {
          const box = { x0: columns.amountX0, x1: columns.balanceX0 - 2, y0: mid(t) - lineH * 0.8, y1: mid(t) + lineH * 0.8 };
          (/^bor/i.test(t.t) ? debitReads : creditReads).push(readMoney(await read(box)));
        }
      }

      for (const r of rows) {
        allRows.push({
          date: ranked(r.dates)[0] || null,
          description: r.description,
          amounts: ranked(r.amountReads.filter(Boolean).map((m) => m.value)),
          balances: ranked(r.balanceReads.filter(Boolean).map((m) => m.value)),
          minusVotes: r.amountReads.filter((m) => m && m.minus).length,
          passes: PASSES.length,
        });
      }
    }

    const rows = allRows.filter((r) => r.date && r.amounts.length);
    if (!rows.length) return { text: fullText, rows: [] };
    const solved = solve(rows, ranked(debitReads.filter(Boolean).map((m) => m.value)), ranked(creditReads.filter(Boolean).map((m) => m.value)));

    return {
      text: fullText,
      rows: solved.map((p) => ({
        date: p.row.date,
        description: p.row.description,
        amountKurus: p.amountKurus,
        balanceKurus: p.balance,
        uncertain: p.uncertain,
        fingerprint: `ZR|${p.row.date}|${p.amountKurus}|${p.balance}`,
      })),
    };
  }

  global.ImageStatement = { readImageStatement, readMoney, readDate };
})(window);
