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
    stampBuildDate();
    wrapWideTables();
    buildToc();
    initScrollSpy();
    initSearch();
    initToTop();
    initNav();
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
      // "/" で検索欄にフォーカス
      if (e.key === '/' && document.activeElement !== document.getElementById('search')) {
        e.preventDefault();
        document.getElementById('search').focus();
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
