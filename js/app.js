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
    span: 1, // how many months are shown, ending at `month` (1 or 3)
    bank: null, // filter on the list screen
    categoryId: null, // filter on the list screen (-1 = waiting for review)
    query: '', // search text on the list screen
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
  // "2026-10-21" → "21 Eki 2026"
  function shortDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
  }
  function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  // "2026-10" + (-2) → "2026-08"
  function addMonths(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // The months on screen: just `month`, or the 3 months ending at it
  function period() {
    return { from: addMonths(state.month, 1 - state.span), to: state.month };
  }
  // "Ağustos 2026", or "Ağu – Eki 2026" / "Kas 2025 – Oca 2026" for a range
  function periodLabel({ from, to }) {
    if (from === to) return monthLabel(to);
    const short = (ym) => MONTHS[Number(ym.slice(5)) - 1].slice(0, 3);
    return from.slice(0, 4) === to.slice(0, 4)
      ? `${short(from)} – ${short(to)} ${to.slice(0, 4)}`
      : `${short(from)} ${from.slice(0, 4)} – ${short(to)} ${to.slice(0, 4)}`;
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
    const field = amountKurus < 0 ? 'Alıcı' : '(?:Gönderen|Gönd)'; // Ziraat writes "Gönd:
    let t =
      (d.match(/Kurum Adı\s*:\s*([^,]+)/i) || [])[1] ||
      (/FAST|Para Transferi|HAVALE/i.test(d) && (d.match(new RegExp(field + '\\s*:\\s*([^,\\d]+)', 'i')) || [])[1]) ||
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

  // What people type on a Turkish keyboard: "45,5" · "1.250,75" · "1250.75" · "1 250" → kuruş (or null)
  function parseAmount(text) {
    let s = String(text).replace(/[\s₺TL]/gi, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // comma = decimal point, dots = thousands
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "1.250" = one thousand two hundred fifty
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const kurus = Math.round(parseFloat(s) * 100);
    return kurus > 0 ? kurus : null;
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
    const { from, to } = period();
    const s = db.summary(from, to);
    const pending = db.pendingInMonth(from, to);
    const cats = db.byCategory(from, to);
    const banks = db.byBank(from, to);
    const balance = s.income - s.expense;
    const maxBank = Math.max(1, ...banks.map((b) => b.expense));
    // Shares are taken over the categories shown (a category whose refunds exceed its spending is left out)
    const catTotal = cats.reduce((sum, c) => sum + c.total, 0);
    // Monthly view: compared with the month before (only when that month has data)
    const prevMonth = addMonths(state.month, -1);
    const prev = state.span === 1 && months.includes(prevMonth) ? db.summary(prevMonth) : null;
    // 3-month view: each month on its own, and the monthly average
    const monthRows = state.span === 1 ? [] : db.byMonth(from, to);
    const perMonth = state.span === 1 ? [] : Array.from({ length: state.span }, (_, k) => {
      const m = addMonths(from, k);
      return monthRows.find((r) => r.month === m) || { month: m, income: 0, expense: 0 };
    });
    const maxMonth = Math.max(1, ...perMonth.map((m) => m.expense));
    const avg = (kurus) => state.span > 1 ? `<div class="delta muted">ayda ${tlShort(kurus / state.span)}</div>` : '';
    const change = (now, before, goodWhenUp) => {
      if (!prev || !before) return '';
      const pct = Math.round(((now - before) / before) * 100);
      if (pct === 0) return '<div class="delta muted">= geçen ay</div>';
      const good = pct > 0 === goodWhenUp;
      return `<div class="delta ${good ? 'pos' : 'neg'}" title="${monthLabel(prevMonth)} ayına göre">${pct > 0 ? '▲' : '▼'} %${Math.abs(pct)} <span class="muted">· ${MONTHS[Number(prevMonth.slice(5)) - 1].slice(0, 3)}</span></div>`;
    };

    el.innerHTML = `
      <h1>Merhaba 👋</h1>
      <div class="segmented">
        <button class="${state.span === 1 ? 'on' : ''}" data-span="1">Aylık</button>
        <button class="${state.span === 3 ? 'on' : ''}" data-span="3">3 Aylık</button>
      </div>
      <div class="month-bar">
        <button class="icon-btn" id="prev-month" ${i >= months.length - 1 ? 'disabled' : ''} aria-label="Önceki ay">‹</button>
        <span>${periodLabel({ from, to })}</span>
        <button class="icon-btn" id="next-month" ${i <= 0 ? 'disabled' : ''} aria-label="Sonraki ay">›</button>
      </div>

      <div class="summary">
        <div class="card"><div class="label">Gelir</div><div class="value pos">${tlShort(s.income)}</div>${change(s.income, prev && prev.income, true)}${avg(s.income)}</div>
        <div class="card"><div class="label">Gider</div><div class="value neg">${tlShort(s.expense)}</div>${change(s.expense, prev && prev.expense, false)}${avg(s.expense)}</div>
        <div class="card"><div class="label">Kalan</div><div class="value">${tlShort(balance)}</div></div>
      </div>

      ${pending.n ? `
        <button class="banner" data-go="review">
          <span>🔍 ${pending.n} işlem seni bekliyor<small>Kategorisi belli olmayan işlemler toplamlara henüz dahil değil.</small></span>
          <span>İncele ›</span>
        </button>` : ''}

      ${perMonth.length ? `
        <h2>Aylara göre</h2>
        <div class="card">
          ${perMonth.map((m) => `
            <button class="bar-row" data-homemonth="${m.month}">
              <div class="top"><span>${monthLabel(m.month)}</span><b>${tl(-m.expense)}</b></div>
              <div class="bar"><i style="width:${(m.expense / maxMonth) * 100}%"></i></div>
              <div class="small muted" style="margin-top:4px">Gelen: ${tl(m.income)} · Kalan: ${tl(m.income - m.expense)}</div>
            </button>`).join('')}
        </div>` : ''}

      <h2>Harcamalar</h2>
      <div class="card">
        ${cats.length ? `
          <div class="donut-center">${donutSvg(cats, catTotal)}</div>
          ${cats.map((c) => `
            <button class="cat-line" data-homecat="${c.id}">
              <span class="dot" style="background:${c.color}"></span>
              <span class="name">${esc(c.name)}</span>
              <span class="pct">%${Math.round((c.total / catTotal) * 100)}</span>
              <b>${tl(c.total)}</b>
              <span class="chev">›</span>
            </button>`).join('')}
` : `<p class="muted">${state.span === 1 ? 'Bu ay' : 'Bu dönemde'} kategorilenmiş harcama yok.</p>`}
      </div>

      <h2>Bankalara göre</h2>
      <div class="card">
        ${banks.map((b) => `
          <button class="bar-row" data-homebank="${esc(b.bank)}">
            <div class="top"><span>${esc(b.bank)}</span><b>${tl(-b.expense)}</b></div>
            <div class="bar"><i style="width:${(b.expense / maxBank) * 100}%"></i></div>
            ${b.income ? `<div class="small muted" style="margin-top:4px">Gelen: ${tl(b.income)}</div>` : ''}
          </button>`).join('')}
      </div>`;

    $('#prev-month').onclick = () => { state.month = months[i + 1]; render(); };
    $('#next-month').onclick = () => { state.month = months[i - 1]; render(); };
    for (const b of el.querySelectorAll('[data-span]')) b.onclick = () => { state.span = Number(b.dataset.span); render(); };
    // Tap a month in the 3-month view → that month on its own
    for (const b of el.querySelectorAll('[data-homemonth]')) b.onclick = () => { Object.assign(state, { month: b.dataset.homemonth, span: 1 }); render(); };
    // Tap a category or a bank → its transactions for the months on screen
    for (const b of el.querySelectorAll('[data-homecat]')) {
      b.onclick = () => { Object.assign(state, { categoryId: Number(b.dataset.homecat), bank: null, query: '' }); show('list'); };
    }
    for (const b of el.querySelectorAll('[data-homebank]')) {
      b.onclick = () => { Object.assign(state, { bank: b.dataset.homebank, categoryId: null, query: '' }); show('list'); };
    }
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
    const { from, to } = period();
    const rows = months.length ? db.transactions({ month: from, to, bank: state.bank, categoryId: state.categoryId }) : [];
    const group = (kind, label) => {
      const list = cats.filter((c) => c.kind === kind);
      return `<optgroup label="${label}">${list.map((c) => `<option value="${c.id}" ${state.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`;
    };

    el.innerHTML = `
      <div class="title-row"><h1>İşlemler</h1><button class="add-btn" id="add-cash">+ Nakit</button></div>
      ${months.length ? `
      <div class="field">
        <select id="list-month">${state.span > 1 ? `<option value="" selected>${state.span} ay: ${periodLabel({ from, to })}</option>` : ''}${months.map((m) => `<option value="${m}" ${state.span === 1 && m === state.month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select>
      </div>` : ''}
      <div class="chips">
        <button class="chip ${!state.bank ? 'on' : ''}" data-bank="">Tümü</button>
        ${banks.map((b) => `<button class="chip ${state.bank === b ? 'on' : ''}" data-bank="${esc(b)}">${esc(b)}</button>`).join('')}
      </div>
      <div class="field">
        <select id="list-cat">
          <option value="">Kategori: Hepsi</option>
          <option value="-1" ${state.categoryId === -1 ? 'selected' : ''}>❓ İncelenecekler</option>
          ${group('expense', 'Gider')}${group('income', 'Gelir')}${group('excluded', 'Toplama katılmayan')}
        </select>
      </div>
      ${rows.length ? `<div class="field"><input type="search" id="list-search" placeholder="🔎 Ara: açıklama veya tutar" value="${esc(state.query)}" autocomplete="off"></div>` : ''}
      <div id="list-body"></div>
`;
    const body = $('#list-body');
    const drawRows = () => {
      // Search in the description (with or without Turkish letters) and in the amount ("75,25")
      const q = AppDB.normalize(state.query);
      const shown = !q ? rows : rows.filter((r) =>
        AppDB.normalize(r.description + ' ' + shortTitle(r.description, r.amount_kurus)).includes(q) ||
        money.format(Math.abs(r.amount_kurus) / 100).includes(state.query.trim()));
      const groups = [];
      for (const r of shown) {
        if (!groups.length || groups[groups.length - 1].date !== r.date) groups.push({ date: r.date, rows: [] });
        groups[groups.length - 1].rows.push(r);
      }
      const inSum = shown.filter((r) => r.amount_kurus > 0).reduce((t, r) => t + r.amount_kurus, 0);
      const outSum = shown.filter((r) => r.amount_kurus < 0).reduce((t, r) => t + r.amount_kurus, 0);
      body.innerHTML = !shown.length
        ? `<div class="card empty"><p class="muted">${rows.length ? 'Aramaya uyan işlem yok.' : 'Gösterilecek işlem yok.'}</p></div>`
        : `<div class="list-total small muted">${shown.length} işlem${inSum ? ` · <span class="pos">Giren ${tl(inSum)}</span>` : ''}${outSum ? ` · <span class="neg">Çıkan ${tl(-outSum)}</span>` : ''}</div>
           ${groups.map((g) => `<div class="day">${dayLabel(g.date)}</div><div class="tx-group">${g.rows.map(txRow).join('')}</div>`).join('')}`;
      for (const row of body.querySelectorAll('[data-tx]')) row.onclick = () => openCategorySheet(Number(row.dataset.tx));
    };
    drawRows();
    const search = $('#list-search');
    if (search) search.oninput = () => { state.query = search.value; drawRows(); };

    const monthSel = $('#list-month');
    if (monthSel) monthSel.onchange = (e) => { if (e.target.value) Object.assign(state, { month: e.target.value, span: 1 }); render(); };
    $('#list-cat').onchange = (e) => { state.categoryId = e.target.value === '' ? null : Number(e.target.value); render(); };
    for (const chip of el.querySelectorAll('[data-bank]')) chip.onclick = () => { state.bank = chip.dataset.bank || null; render(); };
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
    const imports = db.imports();
    const customCats = db.customCategories();
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

      <h2>Yüklenen ekstreler</h2>
      <div class="card">
        ${imports.length ? imports.map((x) => `
          <div class="rule-row">
            <span>
              <b>${esc(x.bank)}</b> · ${esc(x.file_name)}
              <small class="muted" style="display:block;margin-top:2px">
                ${x.n ? `${x.n} işlem · ${shortDate(x.first_date)} – ${shortDate(x.last_date)}` : '0 işlem (hepsi önceden yüklenmişti)'}
              </small>
            </span>
            <button class="link-btn" data-import="${x.id}">Sil</button>
          </div>`).join('') : '<p class="muted small" style="margin:0">Henüz ekstre yüklenmedi.</p>'}
      </div>

      <h2>Kategorilerim</h2>
      <div class="card">
        ${customCats.length ? customCats.map((c) => `
          <div class="rule-row">
            <span><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${c.color};margin-right:7px"></span><b>${esc(c.name)}</b>
              <small class="muted"> · ${c.kind === 'income' ? 'Gelir' : 'Gider'} · ${c.n} işlem</small></span>
            <button class="link-btn" data-delcat="${c.id}">Sil</button>
          </div>`).join('') : '<p class="muted small" style="margin:0 0 10px">Kendi kategorilerini ekleyebilirsin (örn. Yurt ücreti, Spor salonu).</p>'}
        <button class="btn ghost" id="add-category" style="margin-top:8px">+ Yeni kategori</button>
      </div>

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
    for (const b of el.querySelectorAll('[data-import]')) {
      b.onclick = () => {
        const x = imports.find((i) => i.id === Number(b.dataset.import));
        confirmSheet(
          'Ekstre silinsin mi?',
          `${x.bank} · ${x.file_name}: bu ekstreden gelen ${x.n} işlem silinecek. Öğrenilen kuralların kalır. İstersen ekstreyi sonra tekrar yükleyebilirsin.`,
          'Evet, sil',
          async () => {
            const n = db.deleteImport(x.id);
            await db.save();
            state.lastImport = null;
            state.month = null;
            toast(`Ekstre silindi · ${n} işlem kaldırıldı`);
            render();
          }
        );
      };
    }
    $('#add-category').onclick = () => openNewCategorySheet('expense');
    for (const b of el.querySelectorAll('[data-delcat]')) {
      b.onclick = () => {
        const c = customCats.find((x) => x.id === Number(b.dataset.delcat));
        confirmSheet('Kategori silinsin mi?', `"${c.name}" silinecek. İçindeki ${c.n} işlem tekrar inceleme kutusuna düşer; bu kategoriye bağlı kurallar da silinir.`, 'Evet, sil', async () => {
          db.deleteCategory(c.id);
          await db.save();
          toast('Kategori silindi');
          render();
        });
      };
    }
    for (const b of el.querySelectorAll('[data-rule]')) b.onclick = async () => { db.deleteRule(Number(b.dataset.rule)); await db.save(); render(); };
    $('#backup').onclick = downloadBackup;
    $('#restore-input').onchange = (e) => { restoreBackup(e.target.files[0]); e.target.value = ''; };
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
        ${r.ocr ? `<p class="small muted" style="margin:4px 0 6px">📷 Fotoğraf PDF'ti, yazılar OCR ile okundu.${r.uncertain ? ` ${r.uncertain} satırın tutarı bakiyeyle tutmadı; inceleme kutusunda kontrol et.` : ' Tutarlar bakiyeyle kontrol edildi.'}</p>` : ''}
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
        const status = (text) => ($('#import-result').innerHTML = `<div class="card" style="margin-top:12px">${esc(file.name)}: ${esc(text)}</div>`);
        status('okunuyor…');
        const ocrReader = (d, password) => ImageStatement.readImageStatement(pdfjsLib, d, status, password);
        // Some banks lock the PDF with a password: ask for it (again if it was wrong) and retry
        let password;
        let parsed = null;
        while (!parsed) {
          try {
            parsed = await Parsers.parseStatement(pdfjsLib, data, { ocr: ocrReader, password });
          } catch (err) {
            if (!err || err.name !== 'PasswordException') throw err;
            password = await askPassword(file.name, err.code === 2 /* INCORRECT_PASSWORD */);
            if (password == null) throw new Error('PDF şifreli; şifre girilmediği için okunmadı.');
            status('okunuyor…');
          }
        }
        const { bank, rows, ocr } = parsed;
        const bankName = Parsers.BANK_NAMES[bank];
        const res = db.importStatement(bankName, rows, file.name);
        results.push({ file: file.name, bank: bankName, ocr, uncertain: rows.filter((r) => r.uncertain).length, ...res });
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

  // A small panel that asks for a PDF's password. Resolves with the text, or null if cancelled.
  function askPassword(fileName, wrong) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if (done) return; done = true; window.removeEventListener('popstate', onBack); resolve(value); };
      const onBack = () => finish(null);
      openSheet(`
        <h3>🔒 Şifreli PDF</h3>
        <p class="muted small" style="margin-top:0">${esc(fileName)} şifreyle korunuyor. Banka genelde şifreyi SMS ile gönderir ya da T.C. kimlik numaranın / doğum tarihinin bir kısmıdır.</p>
        ${wrong ? '<p class="small" style="color:var(--red);margin:0 0 6px">Şifre yanlış, tekrar dene.</p>' : ''}
        <div class="field"><input type="password" id="pdf-pass" autocomplete="off" placeholder="PDF şifresi"></div>
        <div class="btn-row"><button class="btn ghost" id="pass-cancel">Vazgeç</button><button class="btn" id="pass-ok">Aç</button></div>`,
        (sheet) => {
          window.addEventListener('popstate', onBack);
          const input = $('#pdf-pass', sheet);
          input.focus();
          const ok = () => { const v = input.value; closeSheet(); finish(v); };
          $('#pass-ok').onclick = ok;
          input.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
          $('#pass-cancel').onclick = () => { closeSheet(); finish(null); };
          $('#sheet-backdrop').addEventListener('click', onBack, { once: true });
        });
    });
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
    const suggestion = AppDB.suggestKeyword(tx.description, tx.amount_kurus);

    el.innerHTML = `
      <h1>Bu ne? 🤔</h1>
      <div class="muted small">${state.reviewIndex + 1} / ${queue.length}</div>
      <div class="progress"><i style="width:${((state.reviewIndex + 1) / queue.length) * 100}%"></i></div>

      <div class="card review-card">
        <div class="muted small">${dayLabel(tx.date)} · ${esc(tx.bank)}</div>
        <div class="desc">${esc(tx.description)}</div>
        <div class="big ${tx.amount_kurus > 0 ? 'pos' : ''}">${tl(tx.amount_kurus, { sign: true })}</div>
        ${tx.ocr ? `<p class="small" style="margin:8px 0 6px;color:#8a6100">📷 Bu satırın tutarı bakiyeyle tutmadı. Ekstreyle karşılaştır; yanlışsa düzelt.</p>
          <button class="btn ghost" id="fix-from-review">Tutarı düzelt</button>` : ''}
      </div>

      <h2>Hangi kategori?</h2>
      <div id="review-cats">${categoryGrid(tx.amount_kurus, null)}</div>

      <label class="remember"><input type="checkbox" id="remember" ${suggestion ? 'checked' : ''}>
        <span>Bundan sonra bu kelimeyi içeren işlemleri hep bu kategoriye koy:</span></label>
      <input type="text" id="keyword" class="kw-input" value="${esc(suggestion)}" placeholder="Örn. DAVUTPASA CARSI">

      <div class="btn-row">
        <button class="btn ghost" id="skip">Atla</button>
        <button class="btn" id="save" disabled>Kaydet</button>
      </div>`;

    let chosen = state.preselect || tx.category_id || null;
    state.preselect = null;
    el.querySelector('[data-newcat]').onclick = () =>
      openNewCategorySheet(tx.amount_kurus < 0 ? 'expense' : 'income', (id) => {
        state.preselect = id; // come back with the new category already selected
        render();
      });
    if (chosen) {
      const pre = el.querySelector(`[data-cat="${chosen}"]`);
      if (pre) pre.classList.add('on');
      $('#save').disabled = false;
    }
    for (const b of el.querySelectorAll('[data-cat]')) {
      b.onclick = () => {
        chosen = Number(b.dataset.cat);
        for (const x of el.querySelectorAll('[data-cat]')) x.classList.toggle('on', x === b);
        $('#save').disabled = false;
      };
    }
    if ($('#fix-from-review')) $('#fix-from-review').onclick = () => openCategorySheet(tx.id);
    $('#skip').onclick = () => { state.reviewIndex = (state.reviewIndex + 1) % queue.length; render(); };
    $('#save').onclick = async () => {
      const keyword = $('#remember').checked ? $('#keyword').value : '';
      const others = db.setCategory(tx.id, chosen, keyword);
      await db.save();
      toast(others ? `Kaydedildi · ${others} benzer işlem de kategorilendi` : 'Kaydedildi');
      render();
    };
  }

  // The category buttons for a transaction, in groups:
  //  money out → expense categories; money in → income categories, then expense categories
  //  (a refund, "İADE", lowers that category's spending); transfers fit both and come last.
  function categoryGrid(amountKurus, selectedId) {
    const hasCard = db.one("SELECT COUNT(*) AS n FROM accounts WHERE type = 'credit_card'").n > 0;
    const all = db.categories().filter((c) => hasCard || c.name !== 'Kredi kartı ödemesi'); // only useful once a card statement exists
    const btn = (c) => `<button class="cat-btn ${c.id === selectedId ? 'on' : ''}" data-cat="${c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`;
    const section = (title, list) => list.length ? `<div class="cat-sec">${title}</div>${list.map(btn).join('')}` : '';
    const of = (kind) => all.filter((c) => c.kind === kind);
    const newBtn = '<button class="cat-btn cat-new" data-newcat="1"><span class="dot plus">+</span>Yeni kategori</button>';
    return amountKurus < 0
      ? `<div class="cat-grid">${of('expense').map(btn).join('')}${newBtn}${section('Toplama katılmaz', of('excluded'))}</div>`
      : `<div class="cat-grid">${of('income').map(btn).join('')}${newBtn}${section('Toplama katılmaz', of('excluded'))}</div>
         <details class="refund" ${of('expense').some((c) => c.id === selectedId) ? 'open' : ''}>
           <summary>İade mi? Harcama kategorisi seç (o harcamadan düşülür)</summary>
           <div class="cat-grid">${of('expense').map(btn).join('')}</div>
         </details>`;
  }

  // ---------- Sheets (pop-up panels) ----------

  // The phone's back button closes an open panel instead of leaving the app:
  // opening a panel adds a history entry, going back removes it.
  function openSheet(html, onReady) {
    if ($('#sheet').hidden && !(history.state && history.state.sheet)) history.pushState({ sheet: true }, '');
    $('#sheet').innerHTML = html;
    $('#sheet').hidden = false;
    $('#sheet-backdrop').hidden = false;
    $('#sheet').scrollTop = 0;
    onReady && onReady($('#sheet'));
  }
  function hideSheet() {
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
  }
  function closeSheet() {
    hideSheet();
    if (history.state && history.state.sheet) history.back();
  }

  // Tap on a transaction → change its category
  function openCategorySheet(txId) {
    const tx = db.one(
      `SELECT t.*, a.bank FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = :id`,
      { ':id': txId }
    );
    openSheet(`
      <h3>${esc(shortTitle(tx.description, tx.amount_kurus))}</h3>
      <div class="muted small">${dayLabel(tx.date)} · ${esc(tx.bank)} · <b>${tl(tx.amount_kurus, { sign: true })}</b></div>
      <p class="small" style="word-break:break-word">${esc(tx.description)}</p>
      ${categoryGrid(tx.amount_kurus, tx.category_id)}
      <label class="remember"><input type="checkbox" id="sheet-remember">
        <span>Benzerlerini de hatırla:</span></label>
      <input type="text" id="sheet-keyword" class="kw-input" value="${esc(AppDB.suggestKeyword(tx.description, tx.amount_kurus))}">
      <details class="fix-amount" ${tx.ocr ? 'open' : ''}>
        <summary>Tutar yanlış mı? Düzelt</summary>
        <div class="seg" style="margin-top:10px">
          <button data-sign="-1" class="${tx.amount_kurus < 0 ? 'on' : ''}">Giden (−)</button>
          <button data-sign="1" class="${tx.amount_kurus > 0 ? 'on' : ''}">Gelen (+)</button>
        </div>
        <div class="field"><input type="text" id="fix-amount" inputmode="decimal" autocomplete="off" value="${money.format(Math.abs(tx.amount_kurus) / 100)}"></div>
        <button class="btn ghost" id="fix-save" style="margin-bottom:10px">Tutarı kaydet</button>
      </details>
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
        sheet.querySelector('[data-newcat]').onclick = () => {
          const keyword = $('#sheet-remember').checked ? $('#sheet-keyword').value : '';
          openNewCategorySheet(tx.amount_kurus < 0 ? 'expense' : 'income', async (id) => {
            const others = db.setCategory(txId, id, keyword);
            await db.save();
            toast(others ? `Kategori eklendi · ${others} benzer işlem de` : 'Kategori eklendi ve işleme atandı');
            render();
          });
        };
        let sign = tx.amount_kurus < 0 ? -1 : 1;
        for (const b of sheet.querySelectorAll('[data-sign]')) {
          b.onclick = () => {
            sign = Number(b.dataset.sign);
            for (const x of sheet.querySelectorAll('[data-sign]')) x.classList.toggle('on', x === b);
          };
        }
        $('#fix-save').onclick = async () => {
          const value = parseAmount($('#fix-amount').value);
          if (!value) return toast('Tutarı yaz (örn. 125,50).');
          const flipped = db.updateAmount(txId, sign * value);
          await db.save();
          closeSheet();
          toast(flipped ? 'Tutar düzeltildi · kategorisini inceleme kutusunda seç' : 'Tutar düzeltildi');
          render();
        };
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
      <div class="field"><label>Tutar (₺)</label><input type="text" id="cash-amount" inputmode="decimal" autocomplete="off" placeholder="0,00"></div>
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
          const amount = parseAmount($('#cash-amount').value);
          if (!amount) return toast('Tutarı yaz (örn. 45,50).');
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

  // "+ Yeni kategori" → name, type and color; onCreated(id) runs after saving
  const PALETTE = ['#e07a5f', '#f2a65a', '#e9c46a', '#2a9d8f', '#00b4a6', '#5fa8d3', '#3d5a80', '#9b5de5', '#f15bb5', '#8d6e63', '#52b788', '#6c757d'];
  function openNewCategorySheet(kind, onCreated) {
    let color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    openSheet(`
      <h3>Yeni kategori</h3>
      <div class="field"><label>İsim</label><input type="text" id="nc-name" maxlength="30" placeholder="Örn. Yurt ücreti"></div>
      <div class="field"><label>Türü</label>
        <div class="seg"><button data-kind="expense" class="${kind === 'expense' ? 'on' : ''}">Gider</button><button data-kind="income" class="${kind === 'income' ? 'on' : ''}">Gelir</button></div>
      </div>
      <div class="field"><label>Renk</label>
        <div class="swatches">${PALETTE.map((c) => `<button class="swatch ${c === color ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Renk"></button>`).join('')}</div>
      </div>
      <div class="btn-row"><button class="btn ghost" id="nc-cancel">Vazgeç</button><button class="btn" id="nc-save">Ekle</button></div>`,
      (sheet) => {
        $('#nc-name').focus();
        for (const b of sheet.querySelectorAll('[data-kind]')) {
          b.onclick = () => { kind = b.dataset.kind; for (const x of sheet.querySelectorAll('[data-kind]')) x.classList.toggle('on', x === b); };
        }
        for (const b of sheet.querySelectorAll('[data-color]')) {
          b.onclick = () => { color = b.dataset.color; for (const x of sheet.querySelectorAll('[data-color]')) x.classList.toggle('on', x === b); };
        }
        $('#nc-cancel').onclick = closeSheet;
        $('#nc-save').onclick = async () => {
          try {
            const id = db.addCategory($('#nc-name').value, kind, color);
            await db.save();
            closeSheet();
            if (onCreated) await onCreated(id);
            else { toast('Kategori eklendi'); render(); }
          } catch (err) {
            toast(err.message);
          }
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
    window.addEventListener('popstate', hideSheet);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
    // Any element with data-go="screen" works as a shortcut to that screen
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) show(go.dataset.go);
    });

    const shared = await takeSharedFiles();
    if (shared.length) {
      show('upload');
      await importFiles(shared);
    } else {
      show('home');
    }
  }

  // Files shared from a bank app ("Paylaş" → Cep Bütçe).
  // The service worker (sw.js) received them and put them in a cache; we pick them up here.
  async function takeSharedFiles() {
    if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return [];
    history.replaceState(null, '', location.pathname); // clean the address so a refresh does not re-import
    const cache = await caches.open('shared-files');
    const files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'ekstre.pdf');
      files.push(new File([await res.blob()], name));
      await cache.delete(req);
    }
    return files;
  }

  start();
})();
