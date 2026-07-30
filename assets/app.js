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

  // 3つのページで同じ payload.js を使い、復号後に必要な部分だけを残す。
  // （本文を二重に持たないため）
  //   full     … 通常版。スケジュールの章だけ外す
  //   simple   … 簡易版。図だけを残す
  //   schedule … スケジュール。その章だけを残し、進捗の記録UIを足す
  var MODES = { full: 1, simple: 1, schedule: 1 };
  var MODE = MODES[document.documentElement.dataset.mode] ? document.documentElement.dataset.mode : 'full';

  var PROGRESS_KEY = 'nanoni.progress.v1';
  var STATUSES = [
    { id: 'todo',  label: '未着手' },
    { id: 'doing', label: '進行中' },
    { id: 'done',  label: '完了' }
  ];

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
    routePages();
    if (MODE === 'simple') simplify();
    if (MODE === 'schedule') initProgress();
    stampBuildDate();
    wrapWideTables();
    buildToc();
    initScrollSpy();
    initSearch();
    initToTop();
    initNav();
  }

  /* ------------------------------------------------- ページの振り分け */

  // data-page="schedule" が付いた章はスケジュールページ専用。
  function routePages() {
    if (MODE === 'schedule') {
      docEl.querySelectorAll('section:not([data-page="schedule"])').forEach(function (s) { s.remove(); });
      var lede = docEl.querySelector('.lede');
      if (lede) lede.remove();
    } else {
      docEl.querySelectorAll('[data-page="schedule"]').forEach(function (s) { s.remove(); });
    }
  }

  /* ------------------------------------------------------- 進捗の記録 */

  function loadProgress() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function saveProgress(data) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  }

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
      '</tr></thead><tbody data-prog-body></tbody></table>' +
      '<details class="prog-io"><summary>記録の書き出し / 読み込み</summary>' +
        '<p class="prog-io-note">下の文字列をコピーして渡すと、相手の画面でも同じ進捗になります。' +
        '受け取った文字列を貼り付けて「読み込む」を押してください。</p>' +
        '<textarea data-io rows="3" spellcheck="false"></textarea>' +
        '<div class="prog-io-btns">' +
          '<button type="button" data-copy>コピーする</button>' +
          '<button type="button" data-load>読み込む</button>' +
          '<button type="button" data-reset>すべて未着手に戻す</button>' +
        '</div>' +
        '<p class="prog-io-msg" data-io-msg role="status" aria-live="polite"></p>' +
      '</details>';

    docEl.querySelector('#schedule').appendChild(panel);

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
      panel.querySelector('[data-io]').value = JSON.stringify(state);
    }

    tbody.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-set]');
      if (!btn) return;
      var id = btn.closest('tr').dataset.task;
      var st = btn.dataset.set;
      if (st === 'todo') delete state[id];
      else state[id] = { status: st, at: today() };
      if (!saveProgress(state)) msg('保存できませんでした（ブラウザの設定を確認してください）');
      paint();
    });

    var ioMsg = panel.querySelector('[data-io-msg]');
    function msg(t) { ioMsg.textContent = t; setTimeout(function () { ioMsg.textContent = ''; }, 4000); }

    panel.querySelector('[data-copy]').addEventListener('click', function () {
      var ta = panel.querySelector('[data-io]');
      ta.select();
      navigator.clipboard ? navigator.clipboard.writeText(ta.value).then(function () { msg('コピーしました'); },
                                                                        function () { msg('コピーできませんでした。手動で選択してください'); })
                          : msg('手動で選択してコピーしてください');
    });

    panel.querySelector('[data-load]').addEventListener('click', function () {
      var raw = panel.querySelector('[data-io]').value.trim();
      if (!raw) { msg('貼り付けてから押してください'); return; }
      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { msg('読み込めませんでした（形式が違います）'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { msg('読み込めませんでした（形式が違います）'); return; }
      state = parsed;
      saveProgress(state);
      paint();
      msg('読み込みました');
    });

    panel.querySelector('[data-reset]').addEventListener('click', function () {
      if (!confirm('記録をすべて未着手に戻します。よろしいですか？')) return;
      state = {};
      saveProgress(state);
      paint();
      msg('未着手に戻しました');
    });

    paint();
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
