/*
 * app.js — the screens and what happens when you tap things.
 *
 * Screens: home (summary), list (all transactions), upload (statements + backup),
 * review ("what is this?" box). Each screen has a render function that rebuilds
 * its HTML from the database every time it is shown.
 */
(function () {
  'use strict';

  let db = null; // AppDB.Database
  const state = {
    screen: 'home',
    month: null, // 'YYYY-MM'
    bank: null, // filter on the list screen
    categoryId: null, // filter on the list screen (-1 = waiting for review)
    reviewIndex: 0,
    lastImport: null, // result card on the upload screen
  };

  // ---------- Formatting helpers ----------

  const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  const money = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 121044 → "1.210,44 ₺"
  function tl(kurus, { sign = false } = {}) {
    const text = money.format(Math.abs(kurus) / 100) + ' ₺';
    if (!sign) return (kurus < 0 ? '−' : '') + text;
    return (kurus < 0 ? '−' : '+') + text;
  }
  // Whole lira for the small summary cards: 1209044 → "12.090 ₺"
  function tlShort(kurus) {
    return (kurus < 0 ? '−' : '') + Math.round(Math.abs(kurus) / 100).toLocaleString('tr-TR') + ' ₺';
  }
  function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  function dayLabel(iso) {
    const d = new Date(iso + 'T12:00:00');
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${DAYS[d.getDay()]}`;
  }
  function todayIso() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  // Statement descriptions can contain any characters: escape them before putting them into HTML
  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // A short, readable title from a long bank description:
  // "Firma Adı: YIRMIBIRCO KAHVE ISTANBUL,Harcama" → "Yirmibirco Kahve"
  function shortTitle(description, amountKurus = -1) {
    const d = String(description);
    const field = amountKurus < 0 ? 'Alıcı' : 'Gönderen';
    let t =
      (d.match(/Kurum Adı\s*:\s*([^,]+)/i) || [])[1] ||
      (/FAST|Para Transferi|HAVALE/i.test(d) && (d.match(new RegExp(field + '\\s*:\\s*([^,]+)', 'i')) || [])[1]) ||
      d
        .replace(/Firma Adı\s*:/i, ' ')
        .replace(/\b(POS|EPOS|TMSZ)\b/g, ' ')
        .replace(/IYZICO\s*[/*]?|PAYCELL\s*\/?/gi, ' ')
        .replace(/,\s*Harcama.*$/i, ' ')
        .replace(/(^|\s)(ISTANBUL|İSTANBUL|İstanbul|Istanbul|IST)(?=[\s,]|$)/g, ' ')
        .replace(/[*/]/g, ' ')
        .replace(/\b\d+\b/g, ' ');
    t = t.replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
    if (!t) return description;
    // Title Case without turning "I" into "ı": bank texts are written without Turkish capitals
    return t
      .replace(/İ/g, 'i')
      .toLowerCase()
      .replace(/(^|\s)\S/g, (c) => c.toLocaleUpperCase('tr-TR'));
  }

  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- Navigation ----------

  function show(screen) {
    state.screen = screen;
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== `screen-${screen}`;
    for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('active', b.dataset.screen === screen);
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    const fn = { home: renderHome, list: renderList, upload: renderUpload, review: renderReview }[state.screen];
    fn();
    const n = db.reviewQueue().length;
    const badge = $('#review-badge');
    badge.hidden = n === 0;
    badge.textContent = n;
  }

  function ensureMonth() {
    const months = db.months();
    if (!state.month || (months.length && !months.includes(state.month))) {
      state.month = months[0] || todayIso().slice(0, 7);
    }
    return months;
  }

  // ---------- 1. Home ----------

  function renderHome() {
    const el = $('#screen-home');
    const months = ensureMonth();

    if (!months.length) {
      el.innerHTML = `
        <h1>Merhaba 👋</h1>
        <div class="card empty">
          <div class="big">📄</div>
          <h2>Henüz veri yok</h2>
          <p class="muted">Bankalarından indirdiğin ekstreleri yükle; bütün hesapların burada tek ekranda birleşsin.</p>
          <button class="btn" data-go="upload">Ekstre yükle</button>
        </div>`;
      return;
    }

    const i = months.indexOf(state.month);
    const s = db.summary(state.month);
    const pending = db.pendingInMonth(state.month);
    const cats = db.byCategory(state.month);
    const banks = db.byBank(state.month);
    const balance = s.income - s.expense;
    const maxBank = Math.max(1, ...banks.map((b) => b.expense));

    el.innerHTML = `
      <h1>Merhaba 👋</h1>
      <div class="month-bar">
        <button class="icon-btn" id="prev-month" ${i >= months.length - 1 ? 'disabled' : ''} aria-label="Önceki ay">‹</button>
        <span>${monthLabel(state.month)}</span>
        <button class="icon-btn" id="next-month" ${i <= 0 ? 'disabled' : ''} aria-label="Sonraki ay">›</button>
      </div>

      <div class="summary">
        <div class="card"><div class="label">Gelir</div><div class="value pos">${tlShort(s.income)}</div></div>
        <div class="card"><div class="label">Gider</div><div class="value neg">${tlShort(s.expense)}</div></div>
        <div class="card"><div class="label">Kalan</div><div class="value">${tlShort(balance)}</div></div>
      </div>

      ${pending.n ? `
        <button class="banner" data-go="review">
          <span>🔍 ${pending.n} işlem seni bekliyor<small>Kategorisi belli olmayan işlemler toplamlara henüz dahil değil.</small></span>
          <span>İncele ›</span>
        </button>` : ''}

      <h2>Harcamalar</h2>
      <div class="card">
        ${cats.length ? `
          <div class="donut-center">${donutSvg(cats, s.expense)}</div>
          ${cats.map((c) => `
            <div class="cat-line">
              <span class="dot" style="background:${c.color}"></span>
              <span class="name">${esc(c.name)}</span>
              <span class="pct">%${Math.round((c.total / s.expense) * 100)}</span>
              <b>${tl(c.total)}</b>
            </div>`).join('')}
` : '<p class="muted">Bu ay kategorilenmiş harcama yok.</p>'}
      </div>

      <h2>Bankalara göre</h2>
      <div class="card">
        ${banks.map((b) => `
          <div class="bar-row">
            <div class="top"><span>${esc(b.bank)}</span><b>${tl(-b.expense)}</b></div>
            <div class="bar"><i style="width:${(b.expense / maxBank) * 100}%"></i></div>
            ${b.income ? `<div class="small muted" style="margin-top:4px">Gelen: ${tl(b.income)}</div>` : ''}
          </div>`).join('')}
      </div>`;

    $('#prev-month').onclick = () => { state.month = months[i + 1]; render(); };
    $('#next-month').onclick = () => { state.month = months[i - 1]; render(); };
  }

  // A ring chart made of SVG arcs, one per category
  function donutSvg(cats, total) {
    const r = 52, c = 2 * Math.PI * r;
    let offset = 0;
    const arcs = cats.map((cat) => {
      const len = (cat.total / total) * c;
      const arc = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${cat.color}" stroke-width="22"
        stroke-dasharray="${Math.max(len - 1.5, 0.5)} ${c}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"/>`;
      offset += len;
      return arc;
    });
    return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="Kategori dağılımı">
      ${arcs.join('')}
      <text x="70" y="66" text-anchor="middle" font-size="11" fill="#7a847f">Toplam</text>
      <text x="70" y="84" text-anchor="middle" font-size="16" font-weight="700" fill="#1d2420">${tlShort(total)}</text>
    </svg>`;
  }

  // ---------- 2. Transactions ----------

  function renderList() {
    const el = $('#screen-list');
    const months = ensureMonth();
    const banks = db.banks();
    const cats = db.categories();
    const rows = months.length ? db.transactions({ month: state.month, bank: state.bank, categoryId: state.categoryId }) : [];

    const groups = [];
    for (const r of rows) {
      if (!groups.length || groups[groups.length - 1].date !== r.date) groups.push({ date: r.date, rows: [] });
      groups[groups.length - 1].rows.push(r);
    }

    el.innerHTML = `
      <div class="title-row"><h1>İşlemler</h1><button class="add-btn" id="add-cash">+ Nakit</button></div>
      ${months.length ? `
      <div class="field">
        <select id="list-month">${months.map((m) => `<option value="${m}" ${m === state.month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select>
      </div>` : ''}
      <div class="chips">
        <button class="chip ${!state.bank ? 'on' : ''}" data-bank="">Tümü</button>
        ${banks.map((b) => `<button class="chip ${state.bank === b ? 'on' : ''}" data-bank="${esc(b)}">${esc(b)}</button>`).join('')}
      </div>
      <div class="field">
        <select id="list-cat">
          <option value="">Kategori: Hepsi</option>
          <option value="-1" ${state.categoryId === -1 ? 'selected' : ''}>❓ İncelenecekler</option>
          ${cats.map((c) => `<option value="${c.id}" ${state.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      ${!rows.length ? '<div class="card empty"><p class="muted">Gösterilecek işlem yok.</p></div>' : ''}
      ${groups.map((g) => `
        <div class="day">${dayLabel(g.date)}</div>
        <div class="tx-group">${g.rows.map(txRow).join('')}</div>`).join('')}
`;

    const monthSel = $('#list-month');
    if (monthSel) monthSel.onchange = (e) => { state.month = e.target.value; render(); };
    $('#list-cat').onchange = (e) => { state.categoryId = e.target.value === '' ? null : Number(e.target.value); render(); };
    for (const chip of el.querySelectorAll('[data-bank]')) chip.onclick = () => { state.bank = chip.dataset.bank || null; render(); };
    for (const row of el.querySelectorAll('[data-tx]')) row.onclick = () => openCategorySheet(Number(row.dataset.tx));
    $('#add-cash').onclick = openCashSheet;
  }

  function txRow(r) {
    const color = r.color || '#d9b44a';
    const letter = r.category ? r.category[0] : '?';
    return `
      <button class="tx" data-tx="${r.id}">
        <span class="ic" style="background:${color}">${esc(letter)}</span>
        <span class="t">
          <b>${esc(shortTitle(r.description, r.amount_kurus))}</b>
          <small>${r.needs_review ? '<span class="tag-review">❓ İncelenecek</span>' : esc(r.category || '')} · ${esc(r.bank)}</small>
        </span>
        <span class="amt ${r.amount_kurus > 0 ? 'pos' : ''}">${tl(r.amount_kurus, { sign: true })}</span>
      </button>`;
  }

  // ---------- 3. Upload ----------

  function renderUpload() {
    const el = $('#screen-upload');
    const rules = db.learnedRules();
    const r = state.lastImport;

    el.innerHTML = `
      <h1>Ekstre Yükle</h1>
      <p class="muted small">Kuveyt Türk, Yapı Kredi ve Ziraat ekstreleri (PDF). Banka otomatik tanınır. Aynı işlem iki kez eklenmez, dönemleri çakışan ekstreleri rahatça yükleyebilirsin.</p>
      <label class="drop" for="file-input">
        <span class="big">📄</span>
        <b>PDF seç</b>
        <span class="muted small">Birden fazla dosya seçebilirsin</span>
      </label>
      <input type="file" id="file-input" accept="application/pdf,.pdf" multiple hidden>

      <div id="import-result">${r ? importResultHtml(r) : ''}</div>

      <h2>Öğrenilen kurallar</h2>
      <div class="card">
        ${rules.length ? rules.map((x) => `
          <div class="rule-row">
            <span><b>${esc(x.keyword)}</b> → ${esc(x.category)}</span>
            <button class="link-btn" data-rule="${x.id}">Sil</button>
          </div>`).join('') : '<p class="muted small" style="margin:0">İnceleme kutusunda "hatırla" dediğin yerler burada listelenir.</p>'}
      </div>

      <h2>Yedek</h2>
      <p class="muted small">Verilerin sadece bu telefonda duruyor. Tarayıcı verilerini silersen hepsi gider; ara sıra yedek al.</p>
      <div class="btn-row">
        <button class="btn ghost" id="backup">Yedeği indir</button>
        <label class="btn ghost" for="restore-input">Yedekten yükle</label>
      </div>
      <input type="file" id="restore-input" accept=".sqlite,application/octet-stream" hidden>
      <div style="margin-top:8px"><button class="btn danger" id="wipe">Tüm verileri sil</button></div>`;

    $('#file-input').onchange = (e) => importFiles([...e.target.files]);
    for (const b of el.querySelectorAll('[data-rule]')) b.onclick = async () => { db.deleteRule(Number(b.dataset.rule)); await db.save(); render(); };
    $('#backup').onclick = downloadBackup;
    $('#restore-input').onchange = (e) => restoreBackup(e.target.files[0]);
    $('#wipe').onclick = () => confirmSheet('Tüm veriler silinsin mi?', 'İşlemler, öğrenilen kurallar ve yüklenen ekstreler kalıcı olarak silinir.', 'Evet, sil', async () => {
      await db.wipe();
      state.lastImport = null;
      state.month = null;
      toast('Bütün veriler silindi.');
      render();
    });
  }

  function importResultHtml(results) {
    return results.map((r) => r.error ? `
      <div class="card result-err" style="margin-top:12px">
        <b>⚠️ ${esc(r.file)}</b>
        <p class="small" style="margin:6px 0 0">${esc(r.error)}</p>
      </div>` : `
      <div class="card result-ok" style="margin-top:12px">
        <b>✅ ${esc(r.bank)} · ${esc(r.file)}</b>
        <div class="result-line"><span>Bulunan işlem</span><b>${r.found}</b></div>
        <div class="result-line"><span>Yeni eklenen</span><b>${r.added}</b></div>
        ${r.skipped ? `<div class="result-line muted"><span>Zaten vardı, atlandı</span><b>${r.skipped}</b></div>` : ''}
        <div class="result-line"><span>Otomatik kategorilendi</span><b>${r.autoCategorized}</b></div>
        ${r.transfers ? `<div class="result-line"><span>Hesaplar arası transfer</span><b>${r.transfers}</b></div>` : ''}
        ${r.toReview ? `<button class="btn" style="margin-top:10px" data-go="review">${r.toReview} işlemi incele ›</button>` : ''}
      </div>`).join('');
  }

  async function importFiles(files) {
    if (!files.length) return;
    $('#import-result').innerHTML = '<div class="card" style="margin-top:12px">Okunuyor…</div>';
    const results = [];
    for (const file of files) {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const { bank, rows } = await Parsers.parseStatement(pdfjsLib, data);
        const bankName = Parsers.BANK_NAMES[bank];
        const res = db.importStatement(bankName, rows, file.name);
        results.push({ file: file.name, bank: bankName, ...res });
      } catch (err) {
        console.error(err);
        results.push({ file: file.name, error: err.message || 'Dosya okunamadı.' });
      }
    }
    await db.save();
    state.lastImport = results;
    state.month = null; // jump to the newest month
    render();
  }

  function downloadBackup() {
    const blob = new Blob([db.exportBytes()], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cep-butce-yedek-${todayIso()}.sqlite`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function restoreBackup(file) {
    if (!file) return;
    try {
      await db.replaceWith(new Uint8Array(await file.arrayBuffer()));
      state.month = null;
      toast('Yedek geri yüklendi.');
      render();
    } catch (err) {
      toast('Bu dosya geçerli bir yedek değil.');
    }
  }

  // ---------- 4. Review box ----------

  function renderReview() {
    const el = $('#screen-review');
    const queue = db.reviewQueue();

    if (!queue.length) {
      el.innerHTML = `
        <h1>Bu ne? 🤔</h1>
        <div class="card empty">
          <div class="big">🎉</div>
          <h2>İncelenecek işlem yok</h2>
          <p class="muted">Tanınmayan bir işlem gelince burada sorarım.</p>
        </div>`;
      return;
    }

    if (state.reviewIndex >= queue.length) state.reviewIndex = 0;
    const tx = queue[state.reviewIndex];
    const cats = categoriesFor(tx.amount_kurus);
    const suggestion = AppDB.suggestKeyword(tx.description, tx.amount_kurus);

    el.innerHTML = `
      <h1>Bu ne? 🤔</h1>
      <div class="muted small">${state.reviewIndex + 1} / ${queue.length}</div>
      <div class="progress"><i style="width:${((state.reviewIndex + 1) / queue.length) * 100}%"></i></div>

      <div class="card review-card">
        <div class="muted small">${dayLabel(tx.date)} · ${esc(tx.bank)}</div>
        <div class="desc">${esc(tx.description)}</div>
        <div class="big ${tx.amount_kurus > 0 ? 'pos' : ''}">${tl(tx.amount_kurus, { sign: true })}</div>
      </div>

      <h2>Hangi kategori?</h2>
      <div class="cat-grid" id="review-cats">
        ${cats.map((c) => `<button class="cat-btn" data-cat="${c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`).join('')}
      </div>

      <label class="remember"><input type="checkbox" id="remember" ${suggestion ? 'checked' : ''}>
        <span>Bundan sonra bu kelimeyi içeren işlemleri hep bu kategoriye koy:</span></label>
      <input type="text" id="keyword" class="kw-input" value="${esc(suggestion)}" placeholder="Örn. DAVUTPASA CARSI">

      <div class="btn-row">
        <button class="btn ghost" id="skip">Atla</button>
        <button class="btn" id="save" disabled>Kaydet</button>
      </div>`;

    let chosen = null;
    for (const b of el.querySelectorAll('[data-cat]')) {
      b.onclick = () => {
        chosen = Number(b.dataset.cat);
        for (const x of el.querySelectorAll('[data-cat]')) x.classList.toggle('on', x === b);
        $('#save').disabled = false;
      };
    }
    $('#skip').onclick = () => { state.reviewIndex = (state.reviewIndex + 1) % queue.length; render(); };
    $('#save').onclick = async () => {
      const keyword = $('#remember').checked ? $('#keyword').value : '';
      const others = db.setCategory(tx.id, chosen, keyword);
      await db.save();
      toast(others ? `Kaydedildi · ${others} benzer işlem de kategorilendi` : 'Kaydedildi');
      render();
    };
  }

  // Money out → expense categories, money in → income categories; transfers fit both
  function categoriesFor(amountKurus) {
    const kind = amountKurus < 0 ? 'expense' : 'income';
    const hasCard = db.one("SELECT COUNT(*) AS n FROM accounts WHERE type = 'credit_card'").n > 0;
    const list = db.categories().filter((c) => c.kind === kind || c.kind === 'excluded');
    return list
      .filter((c) => hasCard || c.name !== 'Kredi kartı ödemesi') // only useful once a card statement exists
      .sort((a, b) => (a.kind === 'excluded') - (b.kind === 'excluded')); // transfers at the end
  }

  // ---------- Sheets (pop-up panels) ----------

  function openSheet(html, onReady) {
    $('#sheet').innerHTML = html;
    $('#sheet').hidden = false;
    $('#sheet-backdrop').hidden = false;
    onReady && onReady($('#sheet'));
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
  }

  // Tap on a transaction → change its category
  function openCategorySheet(txId) {
    const tx = db.one(
      `SELECT t.*, a.bank FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = :id`,
      { ':id': txId }
    );
    const cats = categoriesFor(tx.amount_kurus);
    openSheet(`
      <h3>${esc(shortTitle(tx.description, tx.amount_kurus))}</h3>
      <div class="muted small">${dayLabel(tx.date)} · ${esc(tx.bank)} · <b>${tl(tx.amount_kurus, { sign: true })}</b></div>
      <p class="small" style="word-break:break-word">${esc(tx.description)}</p>
      <div class="cat-grid">
        ${cats.map((c) => `<button class="cat-btn ${c.id === tx.category_id ? 'on' : ''}" data-cat="${c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`).join('')}
      </div>
      <label class="remember"><input type="checkbox" id="sheet-remember">
        <span>Benzerlerini de hatırla:</span></label>
      <input type="text" id="sheet-keyword" class="kw-input" value="${esc(AppDB.suggestKeyword(tx.description, tx.amount_kurus))}">
      ${tx.source === 'manual' ? '<button class="btn danger" id="sheet-delete" style="margin-bottom:8px">Bu nakit kaydını sil</button>' : ''}
      <button class="btn ghost" id="sheet-close">Kapat</button>`,
      (sheet) => {
        for (const b of sheet.querySelectorAll('[data-cat]')) {
          b.onclick = async () => {
            const keyword = $('#sheet-remember').checked ? $('#sheet-keyword').value : '';
            const others = db.setCategory(txId, Number(b.dataset.cat), keyword);
            await db.save();
            closeSheet();
            toast(others ? `Güncellendi · ${others} benzer işlem de` : 'Kategori güncellendi');
            render();
          };
        }
        const del = $('#sheet-delete');
        if (del) del.onclick = async () => { db.deleteTransaction(txId); await db.save(); closeSheet(); render(); };
        $('#sheet-close').onclick = closeSheet;
      });
  }

  // "+ Nakit" → add a cash expense or income
  function openCashSheet() {
    let kind = 'expense';
    const draw = (sheet) => {
      const cats = db.categories().filter((c) => c.kind === kind);
      sheet.querySelector('#cash-cat').innerHTML = cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    };
    openSheet(`
      <h3>Nakit ekle</h3>
      <p class="muted small" style="margin-top:0">Nakit harcamalar ekstrede görünmez; buradan elle eklenir.</p>
      <div class="seg"><button class="on" data-kind="expense">Gider</button><button data-kind="income">Gelir</button></div>
      <div class="field"><label>Tutar (₺)</label><input type="number" id="cash-amount" inputmode="decimal" min="0" step="0.01" placeholder="0,00"></div>
      <div class="field"><label>Açıklama</label><input type="text" id="cash-desc" placeholder="Örn. Halı saha"></div>
      <div class="field"><label>Kategori</label><select id="cash-cat"></select></div>
      <div class="field"><label>Tarih</label><input type="date" id="cash-date" value="${todayIso()}"></div>
      <div class="btn-row"><button class="btn ghost" id="cash-cancel">Vazgeç</button><button class="btn" id="cash-save">Ekle</button></div>`,
      (sheet) => {
        draw(sheet);
        for (const b of sheet.querySelectorAll('[data-kind]')) {
          b.onclick = () => {
            kind = b.dataset.kind;
            for (const x of sheet.querySelectorAll('[data-kind]')) x.classList.toggle('on', x === b);
            draw(sheet);
          };
        }
        $('#cash-cancel').onclick = closeSheet;
        $('#cash-save').onclick = async () => {
          const amount = Math.round(parseFloat(String($('#cash-amount').value).replace(',', '.')) * 100);
          if (!amount || amount <= 0) return toast('Tutarı yaz.');
          const date = $('#cash-date').value || todayIso();
          db.addManual({
            date,
            description: $('#cash-desc').value.trim() || 'Nakit',
            amountKurus: kind === 'expense' ? -amount : amount,
            categoryId: Number($('#cash-cat').value),
          });
          await db.save();
          closeSheet();
          state.month = date.slice(0, 7);
          toast('Eklendi');
          render();
        };
      });
  }

  function confirmSheet(title, text, okLabel, onOk) {
    openSheet(`
      <h3>${esc(title)}</h3>
      <p class="muted">${esc(text)}</p>
      <div class="btn-row"><button class="btn ghost" id="c-no">Vazgeç</button><button class="btn" id="c-yes" style="background:var(--red)">${esc(okLabel)}</button></div>`,
      () => {
        $('#c-no').onclick = closeSheet;
        $('#c-yes').onclick = async () => { closeSheet(); await onOk(); };
      });
  }

  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- Start ----------

  async function start() {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
      const SQL = await initSqlJs({ locateFile: (file) => `lib/${file}` });
      db = await AppDB.Database.open(SQL);
      window.appDb = db; // handy for debugging in the browser console
    } catch (err) {
      console.error(err);
      $('#loading').textContent = 'Uygulama başlatılamadı: ' + err.message;
      return;
    }
    $('#loading').remove();

    for (const b of document.querySelectorAll('.tabbar button')) b.onclick = () => show(b.dataset.screen);
    $('#sheet-backdrop').onclick = closeSheet;
    // Any element with data-go="screen" works as a shortcut to that screen
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) show(go.dataset.go);
    });
    show('home');
  }

  start();
})();
