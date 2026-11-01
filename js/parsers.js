/*
 * parsers.js — turns a bank statement PDF into a list of transactions.
 *
 * How it works:
 *  1. pdf.js gives us every piece of text on the page together with its
 *     position (x = left/right, y = up/down).
 *  2. Each bank prints its statement in fixed columns (date, description,
 *     amount, balance). We find the column headers ("Açıklama", "Tutar"…)
 *     and use their x positions to know which text belongs to which column.
 *  3. Every row starts with a date. We use those dates as "anchors" and
 *     attach the description and amount texts that sit next to them.
 *
 * Output of every parser: [{ date, description, amountKurus, balanceKurus, fingerprint }]
 *   amountKurus  = amount in kuruş (1 TL = 100 kuruş), negative = money out
 *   fingerprint  = a key that is the same every time the same row is imported,
 *                  so the database can refuse duplicates
 */
(function (global) {
  'use strict';

  // ---------- Small helpers ----------

  // "1.210,44" → 121044, "-577,00" → -57700, "4.000" → 400000
  function parseMoney(text) {
    const s = String(text).replace(/TL/g, '').replace(/\s/g, '');
    if (!/^-?[\d.]+(,\d{1,2})?$/.test(s)) return null;
    const negative = s.startsWith('-');
    const [whole, decimals = '0'] = s.replace('-', '').replace(/\./g, '').split(',');
    const kurus = parseInt(whole, 10) * 100 + parseInt(decimals.padEnd(2, '0'), 10);
    return negative ? -kurus : kurus;
  }

  // "19.10.2026" or "19/10/2026" → "2026-10-19"
  function toIsoDate(text) {
    const m = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(text.trim());
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  const sameLine = (a, b, tolerance = 2) => Math.abs(a.y - b.y) <= tolerance;
  const joinText = (items) =>
    items
      .slice()
      .sort((a, b) => b.y - a.y || a.x - b.x) // top to bottom, left to right
      .map((i) => i.str.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+,/g, ',')
      .trim();

  function findHeader(items, word) {
    return items.find((i) => i.str.trim() === word);
  }

  // True for the column-header line itself (it must never become part of a description).
  function isHeaderLine(item, descH) {
    return item.str.trim() === 'Açıklama' || (item.page === descH.page && item.y >= descH.y - 3);
  }

  // A header word that sits on the same line as the "Açıklama" header
  // (the same word can also appear elsewhere, e.g. "Kullanılabilir Bakiye").
  function headerOnLine(items, lineItem, word, filter = () => true) {
    return items.find((i) => i.str.trim() === word && Math.abs(i.y - lineItem.y) <= 8 && i.page === lineItem.page && filter(i));
  }

  function groupByPage(items) {
    const pages = new Map();
    for (const it of items) {
      if (!pages.has(it.page)) pages.set(it.page, []);
      pages.get(it.page).push(it);
    }
    return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
  }

  // ---------- Bank detection ----------

  function detectBank(items) {
    // Compare without spaces and Turkish capitals, so OCR text like "www. ziraatbank" also matches
    const text = items
      .map((i) => i.str)
      .join(' ')
      .toUpperCase()
      .replace(/İ/g, 'I')
      .replace(/Ü/g, 'U')
      .replace(/\s+/g, '');
    if (text.includes('KUVEYTTURK')) return 'kuveyt';
    if (text.includes('YAPIKREDI') || text.includes('YAPIVEKREDI')) return 'yapikredi';
    if (text.includes('ZIRAAT')) return 'ziraat';
    return null;
  }

  // ---------- Kuveyt Türk ----------
  // Columns: İşlem Tarihi | Referans Kodu | Açıklama | Tutar | Bakiye
  // A long description wraps to lines above AND below the date line.
  function parseKuveyt(items) {
    const descH = findHeader(items, 'Açıklama');
    if (!descH) throw new Error('Kuveyt Türk ekstresinin sütun başlıkları bulunamadı.');
    const refH = headerOnLine(items, descH, 'Referans');
    const amtH = headerOnLine(items, descH, 'Tutar');
    const balH = headerOnLine(items, descH, 'Bakiye');
    if (!refH || !amtH || !balH) throw new Error('Kuveyt Türk ekstresinin sütun başlıkları bulunamadı.');

    const descMin = refH.x + 30;
    const amtMin = amtH.x - 15;
    const balMin = balH.x - 5;
    const rows = [];

    for (const pageItems of groupByPage(items)) {
      const anchors = pageItems.filter((i) => i.x < refH.x - 10 && toIsoDate(i.str));
      const descItems = pageItems.filter((i) => i.x >= descMin && i.x < amtMin && !isHeaderLine(i, descH));

      for (const anchor of anchors) {
        const line = pageItems.filter((i) => sameLine(i, anchor));
        const ref = line.find((i) => i.x >= refH.x - 10 && i.x < descMin);
        const amountText = line.filter((i) => i.x >= amtMin && i.x < balMin).map((i) => i.str.trim()).join('');
        const balanceText = line.filter((i) => i.x >= balMin).map((i) => i.str.trim()).join('');

        // A description line belongs to the closest date row.
        const myDesc = descItems.filter((d) => {
          const nearest = anchors.reduce((best, a) => (Math.abs(a.y - d.y) < Math.abs(best.y - d.y) ? a : best));
          return nearest === anchor && Math.abs(d.y - anchor.y) < 14;
        });

        const amountKurus = parseMoney(amountText);
        if (amountKurus === null) continue;
        const date = toIsoDate(anchor.str);
        rows.push({
          date,
          description: joinText(myDesc),
          amountKurus,
          balanceKurus: parseMoney(balanceText),
          fingerprint: `KT|${date}|${ref ? ref.str.trim() : ''}|${amountKurus}`,
        });
      }
    }
    return rows;
  }

  // ---------- Yapı Kredi ----------
  // Columns: Tarih | Saat | İşlem | Kanal | Açıklama | İşlem Tutarı | Bakiye
  // A long description wraps UPWARDS: extra lines sit above the date line.
  function parseYapiKredi(items) {
    const descH = findHeader(items, 'Açıklama');
    if (!descH) throw new Error('Yapı Kredi ekstresinin sütun başlıkları bulunamadı.');
    const timeH = headerOnLine(items, descH, 'Saat');
    const typeH = headerOnLine(items, descH, 'İşlem', (i) => i.x < descH.x);
    const amtH = headerOnLine(items, descH, 'İşlem', (i) => i.x > descH.x);
    const balH = headerOnLine(items, descH, 'Bakiye');
    if (!timeH || !descH || !amtH || !balH) throw new Error('Yapı Kredi ekstresinin sütun başlıkları bulunamadı.');

    const descMin = descH.x - 5;
    const amtMin = amtH.x - 15;
    const balMin = balH.x - 30;
    const rows = [];

    for (const pageItems of groupByPage(items)) {
      const anchors = pageItems.filter((i) => i.x < timeH.x - 10 && toIsoDate(i.str));
      // Lines whose date cell is "-" are summary rows ("Diğer Bekleyen İşlemler"): ignore them.
      const junkYs = pageItems.filter((i) => i.x < timeH.x - 10 && i.str.trim() === '-').map((i) => i.y);
      const descItems = pageItems.filter(
        (i) =>
          i.x >= descMin &&
          i.x < amtMin &&
          !isHeaderLine(i, descH) &&
          !junkYs.some((y) => Math.abs(y - i.y) <= 2)
      );

      for (const anchor of anchors) {
        const line = pageItems.filter((i) => sameLine(i, anchor));
        const time = line.find((i) => i.x >= timeH.x - 5 && i.x < (typeH ? typeH.x - 5 : descMin));
        const amountText = line.filter((i) => i.x >= amtMin && i.x < balMin).map((i) => i.str).join('');
        const balanceText = line.filter((i) => i.x >= balMin).map((i) => i.str).join('');

        // A description line belongs to the closest date row at or below it.
        const myDesc = descItems.filter((d) => {
          const below = anchors.filter((a) => a.y <= d.y + 2);
          if (!below.length) return false;
          const owner = below.reduce((best, a) => (a.y > best.y ? a : best));
          return owner === anchor && d.y - anchor.y < 45;
        });

        const amountKurus = parseMoney(amountText);
        if (amountKurus === null) continue;
        const date = toIsoDate(anchor.str);
        rows.push({
          date,
          description: joinText(myDesc),
          amountKurus,
          balanceKurus: parseMoney(balanceText),
          fingerprint: `YK|${date}|${time ? time.str.trim() : ''}|${amountKurus}`,
        });
      }
    }
    return rows;
  }

  // ---------- Ziraat ----------
  // Exported from Excel: the columns can be split over several pages
  // (page 1: Tarih + Fiş No, page 2: Açıklama + İşlem Tutarı + Bakiye).
  // Rows on the two pages line up at the same height (y).
  function parseZiraat(items) {
    const pages = groupByPage(items);
    const datePages = [];
    const dataPages = [];

    for (const pageItems of pages) {
      const dates = pageItems
        .filter((i) => i.x < 150 && toIsoDate(i.str))
        .map((d) => ({
          y: d.y,
          date: toIsoDate(d.str),
          slip: (pageItems.find((i) => sameLine(i, d) && /^[A-Z]\d{3,}$/.test(i.str.trim())) || {}).str || '',
        }));

      const amtH = pageItems.find((i) => /^(İşlem )?Tutar(ı)?$/.test(i.str.trim()));
      const balH = amtH && headerOnLine(pageItems, amtH, 'Bakiye');
      const data = [];
      if (amtH && balH) {
        const lines = new Map();
        for (const it of pageItems) {
          if (it.y >= amtH.y - 2) continue; // only rows below the header
          const key = Math.round(it.y);
          if (!lines.has(key)) lines.set(key, []);
          lines.get(key).push(it);
        }
        for (const [y, line] of lines) {
          const amountKurus = parseMoney(line.filter((i) => i.x >= amtH.x - 20 && i.x < balH.x).map((i) => i.str).join(''));
          if (amountKurus === null) continue;
          data.push({
            y,
            description: joinText(line.filter((i) => i.x < amtH.x - 10 && i.x > 20)),
            amountKurus,
            balanceKurus: parseMoney(line.filter((i) => i.x >= balH.x).map((i) => i.str).join('')),
          });
        }
      }
      if (dates.length) datePages.push(dates);
      if (data.length) dataPages.push(data);
    }

    const rows = [];
    const count = Math.min(datePages.length, dataPages.length);
    for (let p = 0; p < count; p++) {
      for (const d of datePages[p]) {
        const match = dataPages[p].find((r) => Math.abs(r.y - d.y) <= 3);
        if (!match) continue;
        rows.push({
          date: d.date,
          description: match.description,
          amountKurus: match.amountKurus,
          balanceKurus: match.balanceKurus,
          fingerprint: `ZR|${d.date}|${d.slip.trim()}|${match.amountKurus}`,
        });
      }
    }
    return rows;
  }

  const PARSERS = { kuveyt: parseKuveyt, yapikredi: parseYapiKredi, ziraat: parseZiraat };
  const BANK_NAMES = { kuveyt: 'Kuveyt Türk', yapikredi: 'Yapı Kredi', ziraat: 'Ziraat' };

  // ---------- Reading the PDF ----------

  async function extractItems(pdfjsLib, data) {
    const doc = await pdfjsLib.getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;
    const items = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const it of content.items) {
        if (it.str && it.str.trim()) items.push({ page: p, x: it.transform[4], y: it.transform[5], str: it.str });
      }
    }
    return items;
  }

  // Main entry: returns { bank, rows } or throws a readable error.
  // ---------- Image-only PDFs (OCR) ----------
  // Some banks (Ziraat's mobile app) save the statement as a picture. app.js turns the
  // picture into text with OCR (Tesseract); here we turn that text into transactions.
  // OCR can misread a digit, so every row is checked against the balance column.

  function detectBankText(text) {
    return detectBank([{ str: text }]);
  }

  function parseOcrZiraat(text) {
    const money = '-?\\s?[\\d.]+,\\d{2}';
    const lineRe = new RegExp('^(\\d{2}[.,]\\d{2}[.,]\\d{4})\\s*[—–-]?\\s*([A-Z]\\d{3,})?\\s+(.+?)\\s+(' + money + ')\\s+(' + money + ')\\s*$');
    const rows = [];
    for (const raw of text.split('\n')) {
      const m = lineRe.exec(raw.trim());
      if (!m) continue;
      rows.push({
        date: toIsoDate(m[1].replace(/,/g, '.')),
        slip: m[2] || '',
        description: m[3].replace(/\s+/g, ' ').trim(),
        amountKurus: parseMoney(m[4].replace(/\s/g, '')),
        balanceKurus: parseMoney(m[5]),
      });
    }
    // The picture shows totals: "Borç: 0,00" (money out) and "Alacak: 4.000,00" (money in)
    const total = (word) => {
      const m = new RegExp(word + '\\s*:?\\s*([\\d.]+,\\d{2})').exec(text);
      return m ? parseMoney(m[1]) : null;
    };
    const debitTotal = total('Bor[çc]');
    const creditTotal = total('Alacak');

    // Decide + or − from the balance: if the balance went up, money came in
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const abs = Math.abs(r.amountKurus);
      const prev = rows[i - 1];
      if (prev && prev.balanceKurus != null && r.balanceKurus != null) {
        const diff = r.balanceKurus - prev.balanceKurus;
        r.amountKurus = diff < 0 ? -abs : abs;
        r.uncertain = Math.abs(diff) !== abs;
      } else if (r.amountKurus < 0) {
        r.uncertain = false;
      } else {
        r.amountKurus = abs; // first row: sign decided below from the printed totals
        r.uncertain = debitTotal == null || creditTotal == null;
      }
    }
    // First row: the sign that makes "Alacak" (money in) add up is the right one
    if (rows.length && creditTotal != null) {
      const first = rows[0];
      const abs = Math.abs(first.amountKurus);
      const otherIn = rows.slice(1).filter((r) => r.amountKurus > 0).reduce((a, r) => a + r.amountKurus, 0);
      first.amountKurus = otherIn + abs === creditTotal ? abs : -abs;
    }
    // Final check: the totals printed on the statement must match what we read
    if (debitTotal != null && creditTotal != null) {
      const inSum = rows.filter((r) => r.amountKurus > 0).reduce((a, r) => a + r.amountKurus, 0);
      const outSum = rows.filter((r) => r.amountKurus < 0).reduce((a, r) => a - r.amountKurus, 0);
      if (inSum !== creditTotal || outSum !== debitTotal) rows.forEach((r) => (r.uncertain = true));
    }
    return rows.map((r) => ({
      date: r.date,
      description: r.description,
      amountKurus: r.amountKurus,
      balanceKurus: r.balanceKurus,
      uncertain: !!r.uncertain,
      fingerprint: `ZR|${r.date}|${r.slip}|${r.amountKurus}`,
    }));
  }

  const OCR_PARSERS = { ziraat: parseOcrZiraat };

  // Main entry: returns { bank, rows, ocr } or throws a readable error.
  // options.ocrText(data) → Promise<string>: reads an image-only PDF (given by app.js in the browser)
  async function parseStatement(pdfjsLib, data, options = {}) {
    const items = await extractItems(pdfjsLib, data.slice()); // pdf.js takes over the buffer: give it a copy
    if (!items.length) {
      if (!options.ocrText) {
        throw new Error('Bu PDF\'te okunabilir metin yok (fotoğraf gibi kaydedilmiş).');
      }
      const text = await options.ocrText(data.slice());
      const bank = detectBankText(text);
      if (!bank) throw new Error('Fotoğraf okundu ama hangi bankaya ait olduğu anlaşılamadı.');
      if (!OCR_PARSERS[bank]) throw new Error(`${BANK_NAMES[bank]} için fotoğraf ekstre henüz desteklenmiyor.`);
      const rows = OCR_PARSERS[bank](text);
      if (!rows.length) throw new Error('Fotoğraf okundu ama içinde işlem satırı bulunamadı.');
      return { bank, rows, ocr: true };
    }
    const bank = detectBank(items);
    if (!bank) throw new Error('Bu ekstrenin hangi bankaya ait olduğu anlaşılamadı.');
    const rows = PARSERS[bank](items);
    if (!rows.length) throw new Error('Ekstrede işlem bulunamadı.');
    return { bank, rows, ocr: false };
  }

  const api = { parseStatement, extractItems, detectBank, parseMoney, toIsoDate, parseOcrZiraat, PARSERS, BANK_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Parsers = api;
})(typeof window !== 'undefined' ? window : globalThis);
