/* ==========================================================================
   NANONI / 24CLUB 関係者限定サイト — 解錠とビューア
   --------------------------------------------------------------------------
   本文は AES-256-GCM で暗号化して payload.js に埋め込んである。
   パスワードから PBKDF2-SHA256 で鍵を導出し、ブラウザ内で復号する。
   → 正しいパスワードなしでは、ページのソースを見ても本文は読めない。
   ========================================================================== */

(function () {
  'use strict';

  var SESSION_KEY = 'nanoni.unlocked.v1';

  // 5つのページで同じ payload.js を使い、復号後に必要な部分だけを残す。
  // （本文を二重に持たないため）
  //   full     … 通常版。専用ページの章を外す
  //   simple   … 簡易版。図だけを残す
  //   schedule … スケジュール。その章だけを残し、進捗の記録UIを足す
  //   lot2     … 第2ロット。その章だけを残し、入力・計算UIを足す
  //   chat     … AIに質問。その章だけを残し、チャットUIを足す
  var MODES = { full: 1, simple: 1, schedule: 1, lot2: 1, chat: 1 };
  var MODE = MODES[document.documentElement.dataset.mode] ? document.documentElement.dataset.mode : 'full';

  // 自分の章だけを表示する専用ページ（data-page の値と一致させる）
  var SOLO_PAGES = { schedule: 1, lot2: 1, chat: 1 };

  var PROGRESS_KEY = 'nanoni.progress.v1';
  var LOT2_KEY     = 'nanoni.lot2.v1';
  var APIKEY_KEY   = 'nanoni.apikey.v1';

  var STATUSES = [
    { id: 'todo',  label: '未着手' },
    { id: 'doing', label: '進行中' },
    { id: 'done',  label: '完了' }
  ];

  // 費用の単位。lot2 ページの計算はすべてここを見る
  var UNITS = [
    { id: 'can',  label: '1缶ごと' },
    { id: 'case', label: '1ケースごと' },
    { id: 'shop', label: '1店舗ごと' },
    { id: 'lot',  label: '一式' }
  ];

  // 復号した本文をテキストにしたもの（chat ページの前提知識）
  var CONTEXT_TEXT = '';

  var gate     = document.getElementById('gate');
  var gateForm = document.getElementById('gate-form');
  var gateInput= document.getElementById('gate-input');
  var gateBtn  = document.getElementById('gate-btn');
  var gateMsg  = document.getElementById('gate-msg');
  var gateCard = document.querySelector('.gate-card');
  var app      = document.getElementById('app');
  var docEl    = document.getElementById('doc');

  /* ---------------------------------------------------------------- 暗号 */

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function deriveKey(password, salt, iterations) {
    return crypto.subtle
      .importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
      });
  }

  function decrypt(password) {
    var p = window.NANONI_PAYLOAD;
    return deriveKey(password, b64ToBytes(p.salt), p.iterations)
      .then(function (key) {
        return crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64ToBytes(p.iv) },
          key,
          b64ToBytes(p.ct)
        );
      })
      .then(function (buf) {
        return new TextDecoder().decode(buf);
      });
  }

  /* ------------------------------------------------------------ 解錠処理 */

  function unlock(password, fromSession) {
    gateBtn.disabled = true;
    gateMsg.textContent = '復号中…';

    return decrypt(password)
      .then(function (html) {
        try { sessionStorage.setItem(SESSION_KEY, password); } catch (e) { /* 非対応環境は無視 */ }
        render(html);
        gate.hidden = true;
        app.hidden = false;
        document.body.style.overflow = '';
        gateMsg.textContent = '';
        gateBtn.disabled = false;
      })
      .catch(function () {
        // GCM の認証タグ検証に失敗 = パスワードが違う
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
        gateBtn.disabled = false;
        gateInput.value = '';
        if (fromSession) { gateMsg.textContent = ''; return; }
        gateMsg.textContent = 'パスワードが違います。';
        gateCard.classList.remove('shake');
        void gateCard.offsetWidth;
        gateCard.classList.add('shake');
        gateInput.focus();
      });
  }

  function relock() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    location.reload();
  }

  /* -------------------------------------------------------------- 描画 */

  function render(html) {
    docEl.innerHTML = html;
    // 章を捨てる前に、本文ぜんぶをテキストにしておく（AIに渡す前提知識）
    if (MODE === 'chat') CONTEXT_TEXT = htmlToText(html);
    routePages();
    if (MODE === 'simple')   simplify();
    if (MODE === 'schedule') initProgress();
    if (MODE === 'lot2')     initLot2();
    if (MODE === 'chat')     initChat();
    stampBuildDate();
    wrapWideTables();
    buildToc();
    initScrollSpy();
    initSearch();
    initToTop();
    initNav();
  }

  /* ------------------------------------------------- ページの振り分け */

  // data-page="…" が付いた章は、その名前の専用ページにだけ出す。
  function routePages() {
    if (SOLO_PAGES[MODE]) {
      docEl.querySelectorAll('section:not([data-page="' + MODE + '"])').forEach(function (s) { s.remove(); });
      var lede = docEl.querySelector('.lede');
      if (lede) lede.remove();
    } else {
      docEl.querySelectorAll('section[data-page]').forEach(function (s) { s.remove(); });
    }
  }

  /* ------------------------------------------------------- 進捗の記録 */

  // 記録はどのページも同じ形で扱う（localStorage に JSON で1件）
  function readStore(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return (v && typeof v === 'object') ? v : fallback;
    } catch (e) { return fallback; }
  }

  function writeStore(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  }

  function loadProgress() { return readStore(PROGRESS_KEY, {}); }
  function saveProgress(data) { return writeStore(PROGRESS_KEY, data); }

  function today() {
    var d = new Date();
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function initProgress() {
    var gantt = docEl.querySelector('[data-gantt]');
    if (!gantt) return;

    var rows = Array.prototype.slice.call(gantt.querySelectorAll('.gt-row[data-task]'));
    if (!rows.length) return;

    var state = loadProgress();

    var panel = document.createElement('section');
    panel.id = 'progress';
    panel.innerHTML =
      '<h2>進捗の記録</h2>' +
      '<div class="callout callout-note">' +
        '<p class="callout-title">この端末にだけ保存されます</p>' +
        '<p>記録はブラウザの中に保存されるため、<strong>ほかの人の画面には出ません</strong>。' +
        '共有したいときは下の「記録を書き出す」でコピーして渡し、相手が「読み込む」に貼り付けてください。</p>' +
      '</div>' +
      '<div class="prog-summary">' +
        '<p class="prog-count"><b data-done>0</b> / <span data-total>0</span> 完了</p>' +
        '<div class="prog-meter"><span data-meter style="width:0%"></span></div>' +
      '</div>' +
      '<table class="tbl prog-table"><thead><tr>' +
        '<th>作業</th><th style="width:44%">状態</th><th style="width:16%">更新日</th>' +
      '</tr></thead><tbody data-prog-body></tbody></table>';

    docEl.querySelector('#schedule').appendChild(panel);

    var io = ioPanel(function () { return state; },
                     function (next) { state = next; saveProgress(state); paint(); },
                     function () { return {}; });
    io.querySelector('[data-reset]').textContent = 'すべて未着手に戻す';
    panel.appendChild(io);

    var tbody = panel.querySelector('[data-prog-body]');

    rows.forEach(function (row) {
      var id = row.dataset.task;
      var name = row.querySelector('.gt-name').textContent.trim();
      var bar = row.querySelector('.gt-bar > span');
      var when = bar ? bar.textContent.trim() : '';

      var tr = document.createElement('tr');
      tr.dataset.task = id;
      tr.innerHTML =
        '<td>' + name + (when ? '<span class="sub"> ／ ' + when + '</span>' : '') + '</td>' +
        '<td><div class="prog-btns" role="group" aria-label="' + name + ' の状態">' +
          STATUSES.map(function (s) {
            return '<button type="button" data-set="' + s.id + '">' + s.label + '</button>';
          }).join('') +
        '</div></td>' +
        '<td class="prog-at"></td>';
      tbody.appendChild(tr);
    });

    // 状態の反映
    function paint() {
      var done = 0;
      rows.forEach(function (row) {
        var id = row.dataset.task;
        var rec = state[id] || {};
        var st = rec.status || 'todo';
        if (st === 'done') done++;

        row.classList.remove('is-todo', 'is-doing', 'is-done');
        row.classList.add('is-' + st);

        var tr = tbody.querySelector('tr[data-task="' + id + '"]');
        tr.querySelectorAll('[data-set]').forEach(function (b) {
          b.classList.toggle('is-on', b.dataset.set === st);
        });
        tr.querySelector('.prog-at').textContent = st === 'todo' ? '' : (rec.at || '');
      });

      panel.querySelector('[data-done]').textContent = done;
      panel.querySelector('[data-total]').textContent = rows.length;
      panel.querySelector('[data-meter]').style.width = (done / rows.length * 100) + '%';
      io.sync();
    }

    tbody.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-set]');
      if (!btn) return;
      var id = btn.closest('tr').dataset.task;
      var st = btn.dataset.set;
      if (st === 'todo') delete state[id];
      else state[id] = { status: st, at: today() };
      saveProgress(state);
      paint();
    });

    paint();
  }

  /* ----------------------------------------------------- 小さな道具 */

  function num(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[,\s円本缶店]/g, ''));
    return isFinite(n) ? n : 0;
  }

  function fmt(n, digits) {
    if (!isFinite(n)) return '—';
    return n.toLocaleString('ja-JP', { maximumFractionDigits: digits == null ? 0 : digits });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // 「書き出し / 読み込み」のパネル。進捗も第2ロットも同じ形で共有する。
  function ioPanel(getState, setState, blankState) {
    var box = document.createElement('details');
    box.className = 'prog-io';
    box.innerHTML =
      '<summary>記録の書き出し / 読み込み</summary>' +
      '<p class="prog-io-note">下の文字列をコピーして渡すと、相手の画面でも同じ内容になります。' +
      '受け取った文字列を貼り付けて「読み込む」を押してください。</p>' +
      '<textarea data-io rows="3" spellcheck="false"></textarea>' +
      '<div class="prog-io-btns">' +
        '<button type="button" data-copy>コピーする</button>' +
        '<button type="button" data-load>読み込む</button>' +
        '<button type="button" data-reset>すべて消す</button>' +
      '</div>' +
      '<p class="prog-io-msg" data-io-msg role="status" aria-live="polite"></p>';

    var ta = box.querySelector('[data-io]');
    var out = box.querySelector('[data-io-msg]');

    function msg(t) { out.textContent = t; setTimeout(function () { out.textContent = ''; }, 4000); }

    box.querySelector('[data-copy]').addEventListener('click', function () {
      ta.select();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(ta.value).then(
          function () { msg('コピーしました'); },
          function () { msg('コピーできませんでした。手動で選択してください'); });
      } else { msg('手動で選択してコピーしてください'); }
    });

    box.querySelector('[data-load]').addEventListener('click', function () {
      var raw = ta.value.trim();
      if (!raw) { msg('貼り付けてから押してください'); return; }
      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { msg('読み込めませんでした（形式が違います）'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        msg('読み込めませんでした（形式が違います）'); return;
      }
      setState(parsed);
      msg('読み込みました');
    });

    box.querySelector('[data-reset]').addEventListener('click', function () {
      if (!confirm('入力した内容をすべて消します。よろしいですか？')) return;
      setState(blankState());
      msg('消しました');
    });

    box.sync = function () { ta.value = JSON.stringify(getState()); };
    return box;
  }

  /* --------------------------------------------------------- 第2ロット */

  // 数字は app.js に書かない。第1ロットの実績は本文側の data-lot2-preset から読む。
  function readPreset() {
    var el = docEl.querySelector('[data-lot2-preset]');
    if (!el) return null;
    return {
      base: {
        cans:    el.dataset.cans    || '',
        perCase: el.dataset.perCase || '',
        shops:   el.dataset.shops   || '',
        price:   el.dataset.price   || ''
      },
      costs: Array.prototype.map.call(el.querySelectorAll('[data-item]'), function (s) {
        return { item: s.dataset.item, unit: s.dataset.unit, amount: s.dataset.amount };
      })
    };
  }

  function initLot2() {
    var sec = docEl.querySelector('#lot2');
    var preset = readPreset();
    if (!sec || !preset) return;

    function blank() {
      return {
        base: { cans: '', perCase: '', shops: '', price: '' },
        costs: preset.costs.map(function (c) { return { item: c.item, unit: c.unit, amount: '' }; }),
        stock: []
      };
    }

    var state = readStore(LOT2_KEY, null);
    if (!state || !Array.isArray(state.costs)) state = blank();
    if (!state.base) state.base = blank().base;
    if (!Array.isArray(state.stock)) state.stock = [];

    var wrap = document.createElement('div');
    wrap.className = 'lot2';
    wrap.innerHTML =
      '<h3 id="lot2-base">1. 基本の数字</h3>' +
      '<div class="l2-fields">' +
        field('cans',    '作る本数',   '缶', '例）200',    '1') +
        field('perCase', '1ケースの本数', '缶', '例）20',   '1') +
        field('shops',   '卸すお店の数', '店', '例）4',     '1') +
        field('price',   'お店に売る値段<span class="gloss">（税抜・1缶）</span>', '円', '例）909.09', '0.01') +
      '</div>' +

      '<h3 id="lot2-cost">2. かかるお金</h3>' +
      '<table class="tbl l2-costs"><thead><tr>' +
        '<th style="width:28%">項目</th><th style="width:20%">単位</th><th style="width:18%">単価（円）</th>' +
        '<th style="width:17%">合計</th><th style="width:15%">1缶あたり</th><th style="width:1%"><span class="visually-hidden">消す</span></th>' +
      '</tr></thead><tbody data-cost-body></tbody>' +
      '<tfoot><tr class="tr-total"><td>合計</td><td></td><td></td>' +
        '<td class="num" data-cost-total>—</td><td class="num" data-cost-percan>—</td><td></td></tr></tfoot></table>' +
      '<div class="l2-actions">' +
        '<button type="button" data-add-cost>項目を足す</button>' +
        '<button type="button" data-fill>第1ロットの数字を入れる</button>' +
      '</div>' +

      '<figure class="viz"><p class="viz-title">何にいくらかかるか</p><div data-cost-chart></div>' +
        '<p class="viz-note">ケースの数は <strong>作る本数 ÷ 1ケースの本数</strong> を切り上げて計算しています。</p></figure>' +

      '<h3 id="lot2-unit">3. 1缶あたりの計算</h3>' +
      '<div class="kpi-grid" data-kpi></div>' +
      '<figure class="viz"><p class="viz-title">売る値段と、かかるお金</p><div data-unit-chart></div></figure>' +

      '<h3 id="lot2-stock">4. 在庫の行き先</h3>' +
      '<table class="tbl l2-stock"><thead><tr>' +
        '<th style="width:44%">出荷先</th><th style="width:26%">種別</th><th style="width:22%">本数</th>' +
        '<th style="width:1%"><span class="visually-hidden">消す</span></th>' +
      '</tr></thead><tbody data-stock-body></tbody></table>' +
      '<div class="l2-actions"><button type="button" data-add-stock>出荷先を足す</button></div>' +
      '<figure class="viz"><p class="viz-title">在庫の残り</p><div data-stock-chart></div></figure>';

    sec.appendChild(wrap);

    var io = ioPanel(function () { return state; },
                     function (next) { state = normalize(next); persist(); rebuild(); },
                     blank);
    sec.appendChild(io);

    function field(key, label, unit, ph, step) {
      return '<label class="l2-field"><span class="l2-field-label">' + label + '</span>' +
             '<input type="number" inputmode="decimal" min="0" step="' + step + '" ' +
             'data-base="' + key + '" placeholder="' + ph + '">' +
             '<em>' + unit + '</em></label>';
    }

    function normalize(next) {
      var b = blank();
      if (!next || typeof next !== 'object') return b;
      return {
        base:  (next.base && typeof next.base === 'object') ? next.base : b.base,
        costs: Array.isArray(next.costs) ? next.costs : b.costs,
        stock: Array.isArray(next.stock) ? next.stock : []
      };
    }

    function persist() {
      if (!writeStore(LOT2_KEY, state)) {
        wrap.querySelector('[data-kpi]').setAttribute('data-warn', '保存できませんでした');
      }
      io.sync();
    }

    /* ---- 計算 ---- */

    function calc() {
      var cans    = num(state.base.cans);
      var perCase = num(state.base.perCase);
      var shops   = num(state.base.shops);
      var price   = num(state.base.price);
      var cases   = perCase > 0 ? Math.ceil(cans / perCase) : 0;

      var rows = state.costs.map(function (c) {
        var a = num(c.amount), total;
        if (c.unit === 'can')       total = a * cans;
        else if (c.unit === 'case') total = a * cases;
        else if (c.unit === 'shop') total = a * shops;
        else                        total = a;
        return { item: c.item, total: total, perCan: cans > 0 ? total / cans : 0 };
      });

      var total = rows.reduce(function (s, r) { return s + r.total; }, 0);
      var perCan = cans > 0 ? total / cans : 0;

      var paid = 0, free = 0;
      state.stock.forEach(function (s) {
        var q = num(s.qty);
        if (s.kind === 'free') free += q; else paid += q;
      });

      return {
        cans: cans, cases: cases, price: price,
        rows: rows, total: total, perCan: perCan,
        margin: price - perCan,
        breakEven: price > 0 ? Math.ceil(total / price) : 0,
        paid: paid, free: free, left: cans - paid - free
      };
    }

    /* ---- 行の組み立て（入力中に作り直すとカーソルが飛ぶので、増減のときだけ） ---- */

    function rebuild() {
      var cb = wrap.querySelector('[data-cost-body]');
      cb.innerHTML = state.costs.map(function (c, i) {
        return '<tr data-i="' + i + '">' +
          '<td><input type="text" data-c="item" value="' + esc(c.item) + '" placeholder="項目名"></td>' +
          '<td><select data-c="unit">' + UNITS.map(function (u) {
            return '<option value="' + u.id + '"' + (u.id === c.unit ? ' selected' : '') + '>' + u.label + '</option>';
          }).join('') + '</select></td>' +
          '<td><input type="number" inputmode="decimal" min="0" step="0.01" data-c="amount" ' +
            'value="' + esc(c.amount) + '" placeholder="—"></td>' +
          '<td class="num" data-c-total>—</td><td class="num" data-c-percan>—</td>' +
          '<td><button type="button" class="l2-del" data-del-cost aria-label="この行を消す">×</button></td>' +
        '</tr>';
      }).join('');

      var sb = wrap.querySelector('[data-stock-body]');
      sb.innerHTML = state.stock.length
        ? state.stock.map(function (s, i) {
            return '<tr data-i="' + i + '">' +
              '<td><input type="text" data-s="to" value="' + esc(s.to) + '" placeholder="お店の名前など"></td>' +
              '<td><select data-s="kind">' +
                '<option value="paid"' + (s.kind !== 'free' ? ' selected' : '') + '>売る（有償）</option>' +
                '<option value="free"' + (s.kind === 'free' ? ' selected' : '') + '>渡す（無償）</option>' +
              '</select></td>' +
              '<td><input type="number" inputmode="numeric" min="0" step="1" data-s="qty" ' +
                'value="' + esc(s.qty) + '" placeholder="—"></td>' +
              '<td><button type="button" class="l2-del" data-del-stock aria-label="この行を消す">×</button></td>' +
            '</tr>';
          }).join('')
        : '<tr class="l2-none"><td colspan="4">まだ1件もありません。「出荷先を足す」から入れてください。</td></tr>';

      wrap.querySelectorAll('[data-base]').forEach(function (i) {
        i.value = state.base[i.dataset.base] == null ? '' : state.base[i.dataset.base];
      });

      paint();
    }

    /* ---- 計算結果の描画 ---- */

    function paint() {
      var d = calc();

      wrap.querySelectorAll('[data-cost-body] tr').forEach(function (tr, i) {
        var r = d.rows[i];
        if (!r) return;
        tr.querySelector('[data-c-total]').textContent  = r.total ? fmt(r.total) + '円' : '—';
        tr.querySelector('[data-c-percan]').textContent = r.perCan ? fmt(r.perCan, 1) + '円' : '—';
      });
      wrap.querySelector('[data-cost-total]').textContent  = d.total ? fmt(d.total) + '円' : '—';
      wrap.querySelector('[data-cost-percan]').textContent = d.perCan ? fmt(d.perCan, 1) + '円' : '—';

      paintKpi(d);
      paintCostChart(d);
      paintUnitChart(d);
      paintStockChart(d);
      io.sync();
    }

    function kpi(label, gloss, value, unit, foot) {
      return '<div class="kpi">' +
        '<p class="kpi-label">' + label + (gloss ? '<span class="gloss">' + gloss + '</span>' : '') + '</p>' +
        '<p class="kpi-value">' + value + (unit ? '<span class="kpi-unit">' + unit + '</span>' : '') + '</p>' +
        '<p class="kpi-foot">' + foot + '</p></div>';
    }

    function paintKpi(d) {
      var sign = d.margin < 0 ? '▲' : '';
      wrap.querySelector('[data-kpi]').innerHTML =
        kpi('かかるお金の合計', '', d.total ? fmt(d.total) : '—', d.total ? '円' : '',
            d.cans ? d.cans + '缶ぶん' : '本数を入れてください') +
        kpi('1缶を作るのにかかるお金', '（原価）', d.perCan ? fmt(d.perCan, 1) : '—', d.perCan ? '円' : '',
            d.price ? '売る値段の' + (d.price ? (d.perCan / d.price * 100).toFixed(0) : '—') + '%' : '値段を入れてください') +
        kpi('1缶売って残るお金', '（粗利）',
            (d.price && d.perCan) ? sign + fmt(Math.abs(d.margin), 1) : '—',
            (d.price && d.perCan) ? '円' : '',
            (d.price && d.perCan)
              ? (d.margin < 0 ? '売るほど赤字になります' : '売る値段の' + (d.margin / d.price * 100).toFixed(0) + '%')
              : '—') +
        kpi('かかったお金を取り戻すのに必要な本数', '', d.breakEven ? fmt(d.breakEven) : '—',
            d.breakEven ? '缶' : '',
            (d.breakEven && d.cans)
              ? (d.breakEven > d.cans ? '作る本数を超えています' : '作る本数の' + (d.breakEven / d.cans * 100).toFixed(0) + '%')
              : '—');
    }

    function empty(host, text) {
      host.innerHTML = '<p class="l2-empty">' + text + '</p>';
    }

    function paintCostChart(d) {
      var host = wrap.querySelector('[data-cost-chart]');
      var rows = d.rows.filter(function (r) { return r.total > 0; })
                       .sort(function (a, b) { return b.total - a.total; });
      if (!rows.length) { empty(host, '基本の数字と単価を入れると、ここに内訳が出ます。'); return; }

      var max = rows[0].total;
      host.innerHTML = '<div class="barchart">' + rows.map(function (r) {
        var pct = (r.total / max * 100).toFixed(1);
        var share = (r.total / d.total * 100).toFixed(1);
        return '<div class="bar-row">' +
          '<span class="bar-name">' + esc(r.item) + '</span>' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%" ' +
            'title="' + esc(r.item) + ' ' + fmt(r.total) + '円（' + share + '%）"></span></span>' +
          '<span class="bar-val">' + fmt(r.total) + '円<small>' + share + '%</small></span>' +
        '</div>';
      }).join('') + '</div>';
    }

    function paintUnitChart(d) {
      var host = wrap.querySelector('[data-unit-chart]');
      if (!(d.price > 0 && d.perCan > 0)) {
        empty(host, '売る値段と単価を入れると、ここに比較が出ます。');
        return;
      }
      var max = Math.max(d.price, d.perCan);
      var neg = d.margin < 0;

      host.innerHTML =
        '<div class="balance">' +
          '<div class="balance-row"><span class="balance-label">お店に売る値段<small>1缶・税抜</small></span>' +
            '<span class="balance-bar"><span class="fill is-rev" style="width:' +
              (d.price / max * 100).toFixed(1) + '%"></span>' +
            '<span class="amt">' + fmt(d.price, 1) + '円</span></span></div>' +
          '<div class="balance-row"><span class="balance-label">かかるお金<small>1缶あたり</small></span>' +
            '<span class="balance-bar"><span class="fill" style="width:' +
              (d.perCan / max * 100).toFixed(1) + '%"></span>' +
            '<span class="amt">' + fmt(d.perCan, 1) + '円</span></span></div>' +
          '<div class="balance-result' + (neg ? '' : ' is-pos') + '">' +
            '<span class="r-label">1缶で残るお金</span>' +
            '<span class="r-value">' + (neg ? '▲' : '＋') + fmt(Math.abs(d.margin), 1) + '円</span>' +
            '<span class="r-note">' + (neg
              ? '1缶売るごとに' + fmt(Math.abs(d.margin), 1) + '円ずつ減ります。'
              : d.cans ? '全部売れれば ' + fmt(d.margin * d.cans) + '円 残ります（無償で渡すぶんを除く）。' : '') +
            '</span>' +
          '</div>' +
        '</div>' +
        '<ul class="viz-legend">' +
          '<li><span class="sw" style="background:var(--v-rev)"></span>売る値段</li>' +
          '<li><span class="sw" style="background:var(--v-cost)"></span>かかるお金（原価）</li>' +
        '</ul>';
    }

    function paintStockChart(d) {
      var host = wrap.querySelector('[data-stock-chart]');
      if (!d.cans) { empty(host, '作る本数を入れると、ここに在庫の残りが出ます。'); return; }

      var left = Math.max(0, d.left);
      var over = d.left < 0;
      var base = over ? (d.paid + d.free) : d.cans;
      var seg = [
        { cls: 'seg-rev', label: '売る',   n: d.paid },
        { cls: 'seg-2',   label: '無償',   n: d.free },
        { cls: 'seg-4',   label: '残り',   n: left }
      ].filter(function (s) { return s.n > 0; });

      host.innerHTML =
        (seg.length
          ? '<div class="stack">' + seg.map(function (s) {
              var p = (s.n / base * 100).toFixed(1);
              return '<span class="' + s.cls + '" style="width:' + p + '%" title="' +
                     s.label + ' ' + s.n + '缶（' + p + '%）"></span>';
            }).join('') + '</div>' +
            '<div class="stack-labels">' + seg.map(function (s) {
              return '<span style="width:' + (s.n / base * 100).toFixed(1) + '%">' + s.label +
                     '<b>' + fmt(s.n) + '缶</b><em>' + (s.n / base * 100).toFixed(0) + '%</em></span>';
            }).join('') + '</div>'
          : '<p class="l2-empty">出荷先を入れると、ここに残りが出ます。</p>') +
        (over
          ? '<p class="viz-note"><strong>作る本数を' + fmt(-d.left) + '缶 超えています。</strong>' +
            '本数か出荷先を見直してください。</p>'
          : '<p class="viz-note">残り <strong>' + fmt(left) + '缶</strong>。' +
            '無償で渡すぶんは売上になりません。</p>');
    }

    /* ---- 入力の受け取り ---- */

    function applyInput(t) {
      if (t.dataset.base) { state.base[t.dataset.base] = t.value; }
      else if (t.dataset.c) { state.costs[+t.closest('tr').dataset.i][t.dataset.c] = t.value; }
      else if (t.dataset.s) { state.stock[+t.closest('tr').dataset.i][t.dataset.s] = t.value; }
      else return;
      persist();
      paint();
    }

    wrap.addEventListener('input', function (e) { applyInput(e.target); });
    // select で input を出さないブラウザのための保険（二重に呼んでも結果は同じ）
    wrap.addEventListener('change', function (e) {
      if (e.target.tagName === 'SELECT') applyInput(e.target);
    });

    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;

      if (btn.hasAttribute('data-add-cost')) {
        state.costs.push({ item: '', unit: 'lot', amount: '' });
      } else if (btn.hasAttribute('data-del-cost')) {
        state.costs.splice(+btn.closest('tr').dataset.i, 1);
      } else if (btn.hasAttribute('data-add-stock')) {
        state.stock.push({ to: '', kind: 'paid', qty: '' });
      } else if (btn.hasAttribute('data-del-stock')) {
        state.stock.splice(+btn.closest('tr').dataset.i, 1);
      } else if (btn.hasAttribute('data-fill')) {
        if (!confirm('第1ロットの数字をひな形として入れます。今の入力は上書きされます。よろしいですか？')) return;
        state.base = {
          cans: preset.base.cans, perCase: preset.base.perCase,
          shops: preset.base.shops, price: preset.base.price
        };
        state.costs = preset.costs.map(function (c) {
          return { item: c.item, unit: c.unit, amount: c.amount };
        });
      } else return;

      persist();
      rebuild();
    });

    rebuild();
  }

  /* ------------------------------------------------------ AIに質問 */

  // 本文（HTML）を、AIに渡せるテキストにする。表はセルを | でつなぐ。
  function htmlToText(html) {
    var root = document.createElement('div');
    root.innerHTML = html;
    root.querySelectorAll('.waffle').forEach(function (w) { w.textContent = '（1マス＝1缶の図）'; });
    // このページ自身の説明は資料ではないので渡さない
    root.querySelectorAll('section[data-page="chat"], script, style, svg, [hidden]')
        .forEach(function (e) { e.remove(); });

    var built = root.querySelector('[data-build-date]');
    if (built && window.NANONI_PAYLOAD.built) built.textContent = window.NANONI_PAYLOAD.built;

    var out = [];
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var c = node.childNodes[i];
        if (c.nodeType === 3) { out.push(c.nodeValue.replace(/\s+/g, ' ')); continue; }
        if (c.nodeType !== 1) continue;

        var tag = c.tagName;
        if (tag === 'TD' || tag === 'TH') { walk(c); out.push(' | '); }
        else if (tag === 'TR') { walk(c); out.push('\n'); }
        else if (/^H[1-4]$/.test(tag)) { out.push('\n\n## '); walk(c); out.push('\n'); }
        else if (/^(P|DIV|LI|SECTION|FIGURE|FIGCAPTION|HEADER|FOOTER|ARTICLE|TABLE|UL|OL|DL|DT|DD|BR)$/.test(tag)) {
          out.push('\n'); walk(c); out.push('\n');
        } else { walk(c); }
      }
    })(root);

    return out.join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function initChat() {
    var sec = docEl.querySelector('#chat');
    if (!sec) return;

    var key = '';
    try { key = localStorage.getItem(APIKEY_KEY) || ''; } catch (e) {}

    var history = [];   // { role, text }
    var busy = false;
    var abort = null;

    var wrap = document.createElement('div');
    wrap.className = 'chat';
    wrap.innerHTML =
      '<details class="chat-key"' + (key ? '' : ' open') + '>' +
        '<summary>APIキーの設定<span class="chat-key-state" data-key-state></span></summary>' +
        '<p class="chat-key-note">' +
          'キーはこの端末のブラウザにだけ保存されます。ほかの人には渡りません。' +
          '共有パソコンで使ったときは、終わったら「消す」を押してください。' +
        '</p>' +
        '<div class="chat-key-row">' +
          '<input type="password" data-key placeholder="sk-ant-…" spellcheck="false" autocomplete="off">' +
          '<button type="button" data-key-save>保存</button>' +
          '<button type="button" data-key-clear>消す</button>' +
        '</div>' +
        '<p class="prog-io-msg" data-key-msg role="status" aria-live="polite"></p>' +
      '</details>' +

      '<div class="chat-log" data-log aria-live="polite"></div>' +

      '<div class="chat-chips" data-chips></div>' +

      '<form class="chat-form" data-form>' +
        '<textarea data-input rows="2" placeholder="質問を入力（Enterで送信・Shift+Enterで改行）" ' +
          'spellcheck="false"></textarea>' +
        '<div class="chat-form-btns">' +
          '<button type="submit" data-send>送る</button>' +
          '<button type="button" data-stop hidden>止める</button>' +
          '<button type="button" data-clear-log>やりとりを消す</button>' +
        '</div>' +
      '</form>' +

      '<p class="chat-foot">' +
        'モデルは Claude Opus 5。答えはこのサイトに書かれている内容だけを元にしています。' +
        'やりとりは保存されず、ページを離れると消えます。' +
      '</p>';

    sec.appendChild(wrap);

    var logEl   = wrap.querySelector('[data-log]');
    var inputEl = wrap.querySelector('[data-input]');
    var keyEl   = wrap.querySelector('[data-key]');
    var keyMsg  = wrap.querySelector('[data-key-msg]');
    var sendBtn = wrap.querySelector('[data-send]');
    var stopBtn = wrap.querySelector('[data-stop]');

    keyEl.value = key;
    paintKeyState();

    // 質問の例。押すとそのまま入力欄に入る
    var CHIPS = [
      '1缶で残るお金が少ないのはなぜ？',
      'いちばん減らせる費用はどれ？',
      '第2ロットを300本にしたら、いくらかかる？',
      '赤字になっているお店はどこ？',
      'まだ分かっていないことを箇条書きにして',
      '免許を取ると何が変わる？'
    ];
    wrap.querySelector('[data-chips]').innerHTML = CHIPS.map(function (c) {
      return '<button type="button" class="chat-chip">' + esc(c) + '</button>';
    }).join('');

    function paintKeyState() {
      wrap.querySelector('[data-key-state]').textContent = key ? '設定済み' : '未設定';
      wrap.querySelector('[data-key-state]').className = 'chat-key-state' + (key ? ' is-on' : '');
    }

    function keyNote(t) {
      keyMsg.textContent = t;
      setTimeout(function () { keyMsg.textContent = ''; }, 4000);
    }

    wrap.querySelector('[data-key-save]').addEventListener('click', function () {
      var v = keyEl.value.trim();
      if (!v) { keyNote('キーを入力してください'); return; }
      key = v;
      try { localStorage.setItem(APIKEY_KEY, key); } catch (e) { keyNote('保存できませんでした（このまま使えます）'); }
      paintKeyState();
      keyNote('保存しました');
      wrap.querySelector('.chat-key').open = false;
      inputEl.focus();
    });

    wrap.querySelector('[data-key-clear]').addEventListener('click', function () {
      key = '';
      keyEl.value = '';
      try { localStorage.removeItem(APIKEY_KEY); } catch (e) {}
      paintKeyState();
      keyNote('消しました');
    });

    wrap.querySelector('[data-chips]').addEventListener('click', function (e) {
      var chip = e.target.closest('.chat-chip');
      if (!chip) return;
      inputEl.value = chip.textContent;
      inputEl.focus();
    });

    wrap.querySelector('[data-clear-log]').addEventListener('click', function () {
      if (busy) return;
      history = [];
      logEl.innerHTML = '';
    });

    stopBtn.addEventListener('click', function () { if (abort) abort.abort(); });

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        wrap.querySelector('[data-form]').requestSubmit();
      }
    });

    wrap.querySelector('[data-form]').addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var q = inputEl.value.trim();
      if (!q) return;
      if (!key) {
        wrap.querySelector('.chat-key').open = true;
        keyNote('先にAPIキーを設定してください');
        keyEl.focus();
        return;
      }
      inputEl.value = '';
      ask(q);
    });

    /* ---- 表示 ---- */

    function bubble(role) {
      var el = document.createElement('div');
      el.className = 'chat-msg is-' + role;
      el.innerHTML = '<p class="chat-who">' + (role === 'user' ? 'あなた' : 'AI') + '</p>' +
                     '<div class="chat-body"></div>';
      logEl.appendChild(el);
      el.scrollIntoView({ block: 'nearest' });
      return el.querySelector('.chat-body');
    }

    // 見出し・箇条書き・太字だけの、ごく軽いMarkdown表示
    function toHtml(text) {
      var lines = String(text).split('\n');
      var out = [], list = false;

      function inline(s) {
        return esc(s)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
      }
      lines.forEach(function (raw) {
        var l = raw.trim();
        var m = l.match(/^[-*・]\s+(.*)$/);
        if (m) {
          if (!list) { out.push('<ul>'); list = true; }
          out.push('<li>' + inline(m[1]) + '</li>');
          return;
        }
        if (list) { out.push('</ul>'); list = false; }
        if (!l) return;
        var h = l.match(/^#{1,4}\s+(.*)$/);
        out.push(h ? '<p class="chat-h">' + inline(h[1]) + '</p>' : '<p>' + inline(l) + '</p>');
      });
      if (list) out.push('</ul>');
      return out.join('');
    }

    function setBusy(on) {
      busy = on;
      sendBtn.disabled = on;
      sendBtn.textContent = on ? '答えています…' : '送る';
      stopBtn.hidden = !on;
    }

    /* ---- API 呼び出し（ブラウザから直接） ---- */

    function systemBlocks() {
      var blocks = [{
        type: 'text',
        text:
          'あなたは NANONI / 24CLUB（愛知県蟹江町のクラフト発泡酒ブランド）の事業について、' +
          '関係者3人の質問に日本語で答えるアシスタントです。\n\n' +
          '守ること:\n' +
          '- 下の資料に書かれている数字だけを使う。書かれていない数字を作らない。\n' +
          '- 資料にないことを聞かれたら「資料には書かれていません」とはっきり言う。\n' +
          '- 計算するときは、途中の式を短く示す。\n' +
          '- 専門用語（粗利・損益分岐点など）を使うときは、かっこで意味を添える。\n' +
          '- 答えは短くまとめる。長い一覧は箇条書きにする。\n\n' +
          '=== 資料ここから ===\n' + CONTEXT_TEXT + '\n=== 資料ここまで ===',
        cache_control: { type: 'ephemeral' }
      }];

      // 第2ロットのページに入力があれば、それも渡す
      var lot2 = readStore(LOT2_KEY, null);
      if (lot2) {
        blocks.push({
          type: 'text',
          text: '第2ロットのページに入力されている内容（まだ検討中の数字）:\n' + JSON.stringify(lot2)
        });
      }
      return blocks;
    }

    function ask(question) {
      bubble('user').innerHTML = toHtml(question);
      history.push({ role: 'user', text: question });

      var body = bubble('ai');
      body.innerHTML = '<p class="chat-wait">考えています…</p>';
      setBusy(true);

      abort = new AbortController();
      var text = '';

      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: abort.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          // ブラウザから直接呼ぶには、この指定が要る
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 16000,
          stream: true,
          thinking: { type: 'adaptive' },
          system: systemBlocks(),
          messages: history.map(function (m) {
            return { role: m.role, content: [{ type: 'text', text: m.text }] };
          })
        })
      })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) { throw new Error(apiError(res.status, t)); });
        }
        return readStream(res, function (chunk) {
          text += chunk;
          body.innerHTML = toHtml(text);
          body.scrollIntoView({ block: 'nearest' });
        });
      })
      .then(function (info) {
        if (info && info.stop === 'refusal') {
          body.innerHTML = '<p class="chat-err">この質問には答えられませんでした。' +
                           '聞き方を変えてもう一度お試しください。</p>';
          history.pop();
          return;
        }
        if (!text.trim()) {
          body.innerHTML = '<p class="chat-err">答えが返りませんでした。もう一度お試しください。</p>';
          history.pop();
          return;
        }
        history.push({ role: 'assistant', text: text });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          if (!text.trim()) { body.innerHTML = '<p class="chat-err">止めました。</p>'; history.pop(); }
          else history.push({ role: 'assistant', text: text });
          return;
        }
        body.innerHTML = '<p class="chat-err">' + esc(err.message || '通信に失敗しました。') + '</p>';
        history.pop();
      })
      .then(function () { setBusy(false); abort = null; });
    }

    function apiError(status, raw) {
      var msg = '';
      try { msg = (JSON.parse(raw).error || {}).message || ''; } catch (e) {}
      if (status === 401) return 'APIキーが正しくないようです（401）。設定を確認してください。';
      if (status === 403) return 'このAPIキーでは使えませんでした（403）。' + msg;
      if (status === 429) return '短時間に送りすぎです（429）。少し待ってからもう一度お試しください。';
      if (status >= 500)  return 'Anthropic側で一時的な問題が起きています（' + status + '）。少し待ってお試しください。';
      return 'エラー（' + status + '）' + (msg ? '：' + msg : '');
    }

    // SSE を読みながら、本文の差分だけを渡す
    function readStream(res, onText) {
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var info = { stop: null };

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return info;
          buf += dec.decode(r.value, { stream: true });

          var parts = buf.split('\n\n');
          buf = parts.pop();

          parts.forEach(function (block) {
            block.split('\n').forEach(function (line) {
              if (line.indexOf('data:') !== 0) return;
              var payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') return;
              var ev;
              try { ev = JSON.parse(payload); } catch (e) { return; }

              if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
                onText(ev.delta.text);
              } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
                info.stop = ev.delta.stop_reason;
              } else if (ev.type === 'error') {
                throw new Error((ev.error && ev.error.message) || 'エラーが返りました。');
              }
            });
          });
          return pump();
        });
      }
      return pump();
    }
  }

  /* ---------------------------------------------------------- 簡易版 */

  // 図（figure.viz）と見出しだけを残し、文章・表・カード類を落とす。
  //
  // 個別に出し分けたいものは本文側で指定する（app.js に文言を書かない）。
  //   data-simple="hide"          … 簡易版では表示しない章・図
  //   data-simple-title="…"       … 簡易版でだけ使う見出し
  function simplify() {
    var lede = docEl.querySelector('.lede');
    if (lede) lede.remove();

    // 本文側で「簡易版では出さない」と指定されたものを先に落とす
    docEl.querySelectorAll('[data-simple="hide"]').forEach(function (el) { el.remove(); });

    Array.prototype.slice.call(docEl.querySelectorAll('section')).forEach(function (sec) {
      var figures = sec.querySelectorAll(':scope > figure.viz');

      // 図が1つも無いセクションはまるごと落とす
      if (!figures.length) { sec.remove(); return; }

      var keep = [];
      var h2 = sec.querySelector(':scope > h2');
      if (h2) {
        // 通常版と番号がとびとびになるため、見出しの連番は外す
        h2.textContent = h2.dataset.simpleTitle ||
                         h2.textContent.replace(/^\s*\d+\.\s*/, '');
        keep.push(h2);
      }
      Array.prototype.forEach.call(figures, function (f) { keep.push(f); });

      Array.prototype.slice.call(sec.children).forEach(function (el) {
        if (keep.indexOf(el) === -1) el.remove();
      });
    });

    // 図に添えた注記も文章なので落とす
    docEl.querySelectorAll('.viz-note').forEach(function (n) { n.remove(); });
  }

  function stampBuildDate() {
    var el = docEl.querySelector('[data-build-date]');
    if (el && window.NANONI_PAYLOAD.built) el.textContent = window.NANONI_PAYLOAD.built;
  }

  // 横に長いテーブルはスクロールコンテナに入れて、ページ全体が横スクロールしないようにする
  function wrapWideTables() {
    docEl.querySelectorAll('table.tbl').forEach(function (t) {
      if (t.parentElement.classList.contains('table-scroll')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
  }

  /* ---------------------------------------------------------------- 目次 */

  var tocLinks = [];
  var headings = [];

  function buildToc() {
    var toc = document.getElementById('toc');
    toc.innerHTML = '';
    tocLinks = [];
    headings = [];

    docEl.querySelectorAll('section').forEach(function (sec) {
      var h2 = sec.querySelector('h2');
      if (!h2) return;
      if (!sec.id) sec.id = slug(h2.textContent);
      toc.appendChild(tocItem(sec.id, h2.textContent, 2));
      headings.push({ id: sec.id, el: sec });

      sec.querySelectorAll('h3').forEach(function (h3) {
        if (!h3.id) h3.id = slug(h3.textContent);
        toc.appendChild(tocItem(h3.id, h3.textContent, 3));
        headings.push({ id: h3.id, el: h3 });
      });
    });
  }

  function tocItem(id, text, level) {
    var li = document.createElement('li');
    li.className = 'lvl-' + level;
    li.dataset.section = level === 2 ? id : '';
    var a = document.createElement('a');
    a.href = '#' + id;
    a.textContent = text.replace(/\s*——.*$/, '').trim();
    a.dataset.target = id;
    li.appendChild(a);
    tocLinks.push(a);
    return li;
  }

  function slug(text) {
    return 'h-' + text.trim().replace(/\s+/g, '-').replace(/[^\w\-　-鿿＀-￯]/g, '').slice(0, 40);
  }

  /* ------------------------------------------------------ スクロール連動 */

  function initScrollSpy() {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = entry.target.id;
        var active = null;
        tocLinks.forEach(function (a) {
          var on = a.dataset.target === id;
          a.classList.toggle('is-active', on);
          if (on) active = a;
        });
        if (active) revealInToc(active);
      });
    }, { rootMargin: '-12% 0px -78% 0px', threshold: 0 });

    headings.forEach(function (h) { observer.observe(h.el); });
  }

  // 目次が縦に収まりきらないので、現在位置の項目を目次内スクロールで見える位置に送る。
  // scrollIntoView はページ側も動かしてしまうため、nav.scrollTop を直接操作する。
  function revealInToc(link) {
    var nav = link.closest('nav');
    if (!nav || nav.scrollHeight <= nav.clientHeight) return;

    var top = link.offsetTop;
    var bottom = top + link.offsetHeight;
    var pad = 48;

    if (top < nav.scrollTop + pad) {
      nav.scrollTop = Math.max(0, top - pad);
    } else if (bottom > nav.scrollTop + nav.clientHeight - pad) {
      nav.scrollTop = bottom - nav.clientHeight + pad;
    }
  }

  /* ---------------------------------------------------------------- 検索 */

  function initSearch() {
    var input  = document.getElementById('search');
    var status = document.getElementById('filter-status');
    if (!input) return;

    var sections = Array.prototype.slice.call(docEl.querySelectorAll('section'));
    var timer;

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { apply(input.value.trim()); }, 140);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; apply(''); }
    });

    function apply(q) {
      clearMarks();

      if (!q) {
        sections.forEach(function (s) { s.classList.remove('filtered-out'); });
        tocLinks.forEach(function (a) { a.parentElement.classList.remove('is-hidden'); });
        removeEmptyNote();
        status.hidden = true;
        return;
      }

      var needle = q.toLowerCase();
      var matched = 0;

      sections.forEach(function (s) {
        var hit = s.textContent.toLowerCase().indexOf(needle) !== -1;
        s.classList.toggle('filtered-out', !hit);
        if (hit) { matched++; highlight(s, q); }
      });

      var visibleIds = sections
        .filter(function (s) { return !s.classList.contains('filtered-out'); })
        .map(function (s) { return s.id; });

      tocLinks.forEach(function (a) {
        var sec = a.closest('li').dataset.section || sectionOf(a.dataset.target);
        a.parentElement.classList.toggle('is-hidden', visibleIds.indexOf(sec) === -1);
      });

      matched === 0 ? showEmptyNote() : removeEmptyNote();

      status.hidden = false;
      status.textContent = matched === 0
        ? '「' + q + '」に一致するセクションはありません。'
        : '「' + q + '」に一致：' + matched + 'セクション（Escで解除）';
    }

    function sectionOf(id) {
      var el = document.getElementById(id);
      var sec = el && el.closest('section');
      return sec ? sec.id : '';
    }

    function showEmptyNote() {
      if (document.getElementById('toc-empty')) return;
      var li = document.createElement('li');
      li.id = 'toc-empty';
      li.className = 'toc-empty';
      li.textContent = '該当なし';
      document.getElementById('toc').appendChild(li);
    }

    function removeEmptyNote() {
      var el = document.getElementById('toc-empty');
      if (el) el.remove();
    }
  }

  function highlight(root, q) {
    var needle = q.toLowerCase();
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var tag = node.parentElement && node.parentElement.tagName;
        if (tag === 'MARK' || tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        return node.nodeValue.toLowerCase().indexOf(needle) !== -1
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });

    var targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);

    targets.forEach(function (node) {
      var text = node.nodeValue;
      var frag = document.createDocumentFragment();
      var from = 0;
      var at;

      while ((at = text.toLowerCase().indexOf(needle, from)) !== -1) {
        if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)));
        var mark = document.createElement('mark');
        mark.className = 'hit';
        mark.textContent = text.slice(at, at + q.length);
        frag.appendChild(mark);
        from = at + q.length;
      }
      if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  function clearMarks() {
    docEl.querySelectorAll('mark.hit').forEach(function (m) {
      var parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  /* ------------------------------------------------------- ナビ・その他 */

  function initNav() {
    var side   = document.getElementById('side');
    var scrim  = document.getElementById('scrim');
    var toggle = document.getElementById('nav-toggle');

    function close() { side.classList.remove('open'); scrim.classList.remove('show'); }

    if (toggle) {
      toggle.addEventListener('click', function () {
        side.classList.toggle('open');
        scrim.classList.toggle('show', side.classList.contains('open'));
      });
    }
    if (scrim) scrim.addEventListener('click', close);

    side.addEventListener('click', function (e) {
      if (e.target.closest('#toc a')) close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
      // "/" で検索欄にフォーカス（簡易版には検索欄が無いので存在確認する）
      var search = document.getElementById('search');
      if (e.key === '/' && search && document.activeElement !== search) {
        e.preventDefault();
        search.focus();
      }
    });

    document.getElementById('btn-print').addEventListener('click', function () { window.print(); });
    document.getElementById('btn-lock').addEventListener('click', relock);
  }

  function initToTop() {
    var btn = document.getElementById('totop');
    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    window.addEventListener('scroll', function () {
      btn.classList.toggle('show', window.scrollY > 520);
    }, { passive: true });
  }

  /* ------------------------------------------------------------ 起動 */

  if (!window.crypto || !window.crypto.subtle) {
    gateMsg.textContent = 'このブラウザは復号に対応していません（HTTPS環境の最新ブラウザで開いてください）。';
    gateBtn.disabled = true;
    return;
  }

  gateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = gateInput.value;
    if (!v) return;
    unlock(v, false);
  });

  // 同じタブ内ではリロードしても再入力を求めない
  var saved = null;
  try { saved = sessionStorage.getItem(SESSION_KEY); } catch (e) {}

  if (saved) {
    unlock(saved, true);
  } else {
    gateInput.focus();
  }
})();
