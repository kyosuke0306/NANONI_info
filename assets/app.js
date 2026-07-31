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

  var PROGRESS_KEY = 'nanoni.progress.v1';   // 旧・進捗だけの記録（読み込んで引き継ぐ）
  var SCHEDULE_KEY = 'nanoni.schedule.v1';  // 予定＋進捗
  var GH_TOKEN_KEY = 'nanoni.ghtoken.v1';   // 共有用の GitHub トークン
  var MYNAME_KEY   = 'nanoni.myname.v1';    // 共有したときに残す名前

  // 優先度。色だけに頼らないよう、丸の数でも表す
  var PRIORITIES = [
    { id: 'high', label: '高', dots: '●●●' },
    { id: 'mid',  label: '中', dots: '●●○' },
    { id: 'low',  label: '低', dots: '●○○' }
  ];
  var LOT2_KEY     = 'nanoni.lot2.v1';
  var APIKEY_KEY   = 'nanoni.apikey.v1';

  var STATUSES = [
    { id: 'todo',  label: '未着手' },
    { id: 'doing', label: '進行中' },
    { id: 'done',  label: '完了' }
  ];

  // 区分に選べる色。実際の色は style.css の --ph-* にある。
  // 6色すべての組み合わせで見分けやすさを検証済み（明・暗の両方）。
  var PHASE_COLORS = [
    { id: 'r', label: '赤' },
    { id: 'o', label: '橙' },
    { id: 'y', label: '黄' },
    { id: 'g', label: '緑' },
    { id: 'b', label: '青' },
    { id: 'p', label: '紫' }
  ];

  // 茶色の濃淡だった頃の記録を引き継ぐための対応表
  var OLD_PHASE_COLORS = { c1: 'o', c2: 'y', c3: 'r', c4: 'g', rev: 'b', unk: 'p' };

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

  function bytesToB64(bytes) {
    var out = '';
    // 一度に渡すと大きい配列でスタックが溢れるので小分けにする
    for (var i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }

  function deriveKey(password, salt, iterations, usages) {
    return crypto.subtle
      .importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          usages || ['decrypt']
        );
      });
  }

  // 共有する記録も本文と同じ方式で包む（公開リポジトリに平文を置かないため）
  var SHARE_ITERATIONS = 310000;

  function encryptText(password, text) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv   = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(password, salt, SHARE_ITERATIONS, ['encrypt'])
      .then(function (key) {
        return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key,
                                     new TextEncoder().encode(text));
      })
      .then(function (buf) {
        return { v: 1, iterations: SHARE_ITERATIONS, salt: bytesToB64(salt),
                 iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(buf)) };
      });
  }

  function decryptBlob(password, blob) {
    return deriveKey(password, b64ToBytes(blob.salt), blob.iterations, ['decrypt'])
      .then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(blob.iv) }, key,
                                     b64ToBytes(blob.ct));
      })
      .then(function (buf) { return new TextDecoder().decode(buf); });
  }

  function sessionPassword() {
    try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch (e) { return ''; }
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

    // 復号の失敗と、描画の失敗は分けて扱う。まとめて catch すると
    // ページ側の不具合まで「パスワードが違います」と出てしまい、原因が分からなくなる。
    return decrypt(password).then(
      function (html) {
        try { sessionStorage.setItem(SESSION_KEY, password); } catch (e) { /* 非対応環境は無視 */ }

        try {
          render(html);
        } catch (err) {
          if (window.console) console.error(err);
          gateBtn.disabled = false;
          gateMsg.textContent = 'パスワードは合っていますが、ページの組み立てに失敗しました。';
          return;
        }

        gate.hidden = true;
        app.hidden = false;
        document.body.style.overflow = '';
        gateMsg.textContent = '';
        gateBtn.disabled = false;
      },
      function () {
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
      }
    );
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
    if (MODE === 'schedule') initSchedule();
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

  /* --------------------------------------------------- 予定と進捗の記録 */

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

  function today() {
    var d = new Date();
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  // 数字も作業名も app.js には書かない。ひな形は本文側の data-schedule-preset から読む。
  function readSchedulePreset() {
    var el = docEl.querySelector('[data-schedule-preset]');
    if (!el) return null;
    return {
      share: {
        repo:   el.dataset.shareRepo   || '',
        path:   el.dataset.sharePath   || 'data/schedule.json',
        branch: el.dataset.shareBranch || 'main'
      },
      members: Array.prototype.map.call(el.querySelectorAll('[data-member]'), function (s) {
        return { id: s.dataset.member, name: s.dataset.name };
      }),
      tasks: Array.prototype.map.call(el.querySelectorAll('[data-task]'), function (s) {
        return {
          id: s.dataset.task, name: s.dataset.name, detail: s.dataset.detail || '',
          from: s.dataset.from, to: s.dataset.to,
          color: s.dataset.color, priority: s.dataset.priority || 'mid'
        };
      })
    };
  }

  // '2026-08' ←→ 通し月番号
  function mIndex(ym) {
    var m = /^(\d{4})-(\d{1,2})$/.exec(String(ym == null ? '' : ym));
    if (!m) return null;
    var mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return (+m[1]) * 12 + (mo - 1);
  }

  function mLabel(idx, withYear) {
    var y = Math.floor(idx / 12), mo = idx % 12 + 1;
    return (withYear ? String(y).slice(2) + '年' : '') + mo + '月';
  }

  function initSchedule() {
    var host = docEl.querySelector('[data-schedule-chart]');
    var preset = readSchedulePreset();
    if (!host || !preset) return;

    var now = function () { return Date.now(); };

    /* ================================================== 状態の形 ========= */

    // ひな形の更新時刻は 0（＝いちばん古い）。初めて開いた人のひな形が、
    // 共有されている本物の予定を上書きしてしまわないようにするため。
    function fromPreset() {
      return {
        members: preset.members.map(function (m) {
          return { id: m.id, name: m.name, updated: 0 };
        }),
        tasks: preset.tasks.map(function (t) {
          return { id: t.id, name: t.name, detail: t.detail, from: t.from, to: t.to,
                   color: toColor(t.color), assignee: '', priority: t.priority,
                   status: 'todo', at: '', subs: [], updated: 0 };
        }),
        graves: {}
      };
    }

    function emptyState() { return { members: [], tasks: [], graves: {} }; }

    function toColor(id) {
      if (PHASE_COLORS.some(function (c) { return c.id === id; })) return id;
      return OLD_PHASE_COLORS[id] || PHASE_COLORS[0].id;
    }
    function toPriority(id) {
      return PRIORITIES.some(function (p) { return p.id === id; }) ? id : 'mid';
    }

    function migrate(base) {
      var old = readStore(PROGRESS_KEY, null);
      if (!old) return base;
      base.tasks.forEach(function (t) {
        var rec = old[t.id];
        if (rec && rec.status) { t.status = rec.status; t.at = rec.at || ''; }
      });
      return base;
    }

    function normalize(next) {
      if (!next || typeof next !== 'object') return fromPreset();
      if (!Array.isArray(next.tasks)) {
        // 旧形式 { taskId: { status, at } } … 進捗だけを今の予定に重ねる
        var base = fromPreset();
        base.tasks.forEach(function (t) {
          var rec = next[t.id];
          if (rec && rec.status) { t.status = rec.status; t.at = rec.at || ''; }
        });
        return base;
      }

      var t0 = 1;   // 更新時刻が無い記録は、共有側より古い扱いにする

      // 区分があった頃の記録：区分の色を、その区分を使っていた作業へ移す
      var byPhase = {};
      if (Array.isArray(next.phases)) {
        next.phases.forEach(function (p) { if (p && p.id) byPhase[p.id] = toColor(p.color); });
      }

      var members = Array.isArray(next.members)
        ? next.members.filter(function (m) { return m && typeof m === 'object' && m.id; })
                      .map(function (m) {
            return { id: String(m.id), name: m.name == null ? '' : String(m.name),
                     updated: +m.updated || t0 };
          })
        : fromPreset().members;

      var knownM = {};
      members.forEach(function (m) { knownM[m.id] = 1; });

      var tasks = next.tasks.filter(function (t) { return t && typeof t === 'object'; })
                            .map(function (t, i) {
        return {
          id: t.id || ('t' + i + '-' + t0),
          name:   t.name   == null ? '' : String(t.name),
          detail: t.detail == null ? '' : String(t.detail),
          from:   t.from   == null ? '' : String(t.from),
          to:     t.to     == null ? '' : String(t.to),
          color: t.color ? toColor(t.color) : (byPhase[t.phase] || PHASE_COLORS[0].id),
          assignee: knownM[t.assignee] ? t.assignee : '',
          priority: toPriority(t.priority),
          status: t.status === 'doing' || t.status === 'done' ? t.status : 'todo',
          at: t.at == null ? '' : String(t.at),
          subs: Array.isArray(t.subs)
            ? t.subs.filter(function (x) { return x && typeof x === 'object'; })
                    .map(function (x, j) {
                return { id: x.id || ('s' + i + '-' + j + '-' + t0),
                         text:   x.text   == null ? '' : String(x.text),
                         detail: x.detail == null ? '' : String(x.detail),
                         from: x.from == null ? '' : String(x.from),
                         to:   x.to   == null ? '' : String(x.to),
                         done: !!x.done, updated: +x.updated || t0 };
              })
            : [],
          updated: +t.updated || t0
        };
      });

      var graves = (next.graves && typeof next.graves === 'object' && !Array.isArray(next.graves))
        ? next.graves : {};

      return { members: members, tasks: tasks, graves: graves };
    }

    /* ---------------------------------------------- 2つの記録を混ぜる ---- */

    function mergeList(mine, theirs, graves) {
      var byId = {}, order = [];
      theirs.forEach(function (r) { byId[r.id] = r; order.push(r.id); });
      mine.forEach(function (r) {
        var cur = byId[r.id];
        if (!cur) { byId[r.id] = r; order.push(r.id); return; }
        if ((r.updated || 0) > (cur.updated || 0)) byId[r.id] = r;
      });
      return order.map(function (id) { return byId[id]; })
                  .filter(function (r) {
                    var g = graves[r.id];
                    return !(g && g >= (r.updated || 0));
                  });
    }

    function mergeStates(mine, theirs) {
      var graves = {};
      [mine.graves || {}, theirs.graves || {}].forEach(function (g) {
        Object.keys(g).forEach(function (k) { graves[k] = Math.max(graves[k] || 0, g[k]); });
      });

      var tasks = mergeList(mine.tasks, theirs.tasks, graves);
      var mineById = {}, theirsById = {};
      mine.tasks.forEach(function (t) { mineById[t.id] = t; });
      theirs.tasks.forEach(function (t) { theirsById[t.id] = t; });
      tasks.forEach(function (t) {
        t.subs = mergeList((mineById[t.id] || {}).subs || [],
                           (theirsById[t.id] || {}).subs || [], graves);
      });

      var sorted = {};
      Object.keys(graves).sort().forEach(function (k) { sorted[k] = graves[k]; });

      return { members: mergeList(mine.members, theirs.members, graves),
               tasks: tasks, graves: sorted };
    }

    var stored = readStore(SCHEDULE_KEY, null);
    var state = stored ? normalize(stored) : migrate(fromPreset());

    /* ================================================== 画面の骨組み ===== */

    var view = document.createElement('div');
    view.innerHTML =
      '<h3 id="schedule-detail">作業の内容</h3>' +
      '<div class="table-scroll"><table class="tbl view-table"><thead><tr>' +
        '<th style="width:22%">項目名</th><th style="width:10%">担当</th>' +
        '<th style="width:9%">優先度</th><th style="width:12%">期間</th>' +
        '<th style="width:9%">状態</th><th>内容と小項目</th>' +
      '</tr></thead><tbody data-view-body></tbody></table></div>' +
      '<h3 id="schedule-by-member">担当者ごとの担当項目</h3>' +
      '<div data-by-member></div>';
    host.parentNode.insertBefore(view, host.nextSibling);

    var panel = document.createElement('section');
    panel.id = 'progress';
    panel.innerHTML =
      '<h2>編集</h2>' +
      '<div class="prog-summary">' +
        '<p class="prog-count"><b data-done>0</b> / <span data-total>0</span> 完了</p>' +
        '<div class="prog-meter"><span data-meter style="width:0%"></span></div>' +
      '</div>' +

      '<h3 id="schedule-tasks">作業</h3>' +
      '<table class="tbl tbl-edit prog-table"><thead><tr>' +
        '<th style="width:24%">項目名</th><th style="width:13%">開始</th><th style="width:13%">終了</th>' +
        '<th style="width:19%">色</th><th style="width:12%">担当</th>' +
        '<th style="width:9%">優先度</th><th style="width:9%">状態</th>' +
        '<th style="width:1%"><span class="visually-hidden">消す</span></th>' +
      '</tr></thead><tbody data-prog-body></tbody></table>' +
      '<div class="l2-actions">' +
        '<button type="button" data-add-task>作業を足す</button>' +
        '<button type="button" class="is-danger" data-clear-tasks>全て削除する</button>' +
      '</div>' +

      '<h3 id="schedule-split">作業の細分化</h3>' +
      '<p class="viz-note">作業を小さく分けて書けます。小項目にも年月を入れると、' +
        '図にその作業のぶら下がりとして出ます。</p>' +
      '<div data-split></div>' +

      '<h3 id="schedule-members">担当者</h3>' +
      '<table class="tbl tbl-edit member-table"><thead><tr>' +
        '<th style="width:60%">名前</th><th style="width:38%">受け持ち</th>' +
        '<th style="width:1%"><span class="visually-hidden">消す</span></th>' +
      '</tr></thead><tbody data-member-body></tbody></table>' +
      '<div class="l2-actions">' +
        '<button type="button" data-add-member>担当者を足す</button>' +
        '<button type="button" class="is-danger" data-clear-members>全て削除する</button>' +
      '</div>';

    docEl.querySelector('#schedule').appendChild(panel);

    // 共有は「押すもの」なので編集の側に置き、状態バーと設定を続けて並べる
    var share = buildShare();
    var summary = panel.querySelector('.prog-summary');
    panel.insertBefore(share.el, summary);
    panel.insertBefore(share.conf, summary);

    var io = ioPanel(function () { return state; },
                     function (next) { state = normalize(next); touch(); rebuild(); },
                     emptyState, '作業・内容・小項目・担当者・進捗');
    panel.appendChild(io);

    var tbody = panel.querySelector('[data-prog-body]');
    var mbody = panel.querySelector('[data-member-body]');
    var splitBox = panel.querySelector('[data-split]');
    var vbody = view.querySelector('[data-view-body]');

    function touch() {
      writeStore(SCHEDULE_KEY, state);
      share.queue();
      io.sync();
    }
    function bury(id) { state.graves[id] = now(); }

    /* ================================================== 参照 ============= */

    function memberName(id) {
      for (var i = 0; i < state.members.length; i++) {
        if (state.members[i].id === id) return state.members[i].name || '（名前なし）';
      }
      return '';
    }
    function priorityOf(id) {
      for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].id === id) return PRIORITIES[i];
      return PRIORITIES[1];
    }
    function statusLabel(id) {
      for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === id) return STATUSES[i].label;
      return '';
    }
    function heldBy(memberId) {
      return state.tasks.filter(function (t) { return t.assignee === memberId; }).length;
    }
    function freeColor() {
      var taken = {};
      state.tasks.forEach(function (t) { taken[t.color] = 1; });
      for (var i = 0; i < PHASE_COLORS.length; i++) {
        if (!taken[PHASE_COLORS[i].id]) return PHASE_COLORS[i].id;
      }
      return PHASE_COLORS[state.tasks.length % PHASE_COLORS.length].id;
    }
    function priChip(id) {
      var p = priorityOf(id);
      return '<span class="pri pri-' + p.id + '"><i aria-hidden="true">' + p.dots + '</i>' + p.label + '</span>';
    }
    function rangeOf(o) {
      var a = mIndex(o.from), b = mIndex(o.to);
      if (a === null || b === null || b < a) return null;
      return { a: a, b: b };
    }
    function rangeLabel(o) {
      var r = rangeOf(o);
      if (!r) return '';
      return r.a === r.b ? mLabel(r.a, true)
                         : mLabel(r.a, true) + '〜' + mLabel(r.b, Math.floor(r.a / 12) !== Math.floor(r.b / 12));
    }
    function subDone(t) {
      return t.subs.filter(function (s) { return s.done; }).length;
    }
    function swatches(sel, attr) {
      return '<div class="ph-swatches" role="group" aria-label="色">' +
        PHASE_COLORS.map(function (c) {
          return '<button type="button" class="ph-sw ph-' + c.id + (c.id === sel ? ' is-on' : '') +
                 '" ' + attr + ' data-color="' + c.id + '" title="' + c.label + '" aria-label="' + c.label + '"' +
                 (c.id === sel ? ' aria-pressed="true"' : ' aria-pressed="false"') + '></button>';
        }).join('') + '</div>';
    }

    /* ================================================== 表を組む ========= */

    function reconcile() {
      var knownM = {};
      state.members.forEach(function (m) { knownM[m.id] = 1; });
      state.tasks.forEach(function (t) {
        if (!knownM[t.assignee]) t.assignee = '';
        if (!Array.isArray(t.subs)) t.subs = [];
      });
    }

    function options(list, sel, blank) {
      return (blank ? '<option value=""' + (sel ? '' : ' selected') + '>' + blank + '</option>' : '') +
        list.map(function (o) {
          return '<option value="' + esc(o.id) + '"' + (o.id === sel ? ' selected' : '') + '>' +
                 esc(o.label) + '</option>';
        }).join('');
    }

    function rebuild() {
      reconcile();

      tbody.innerHTML = state.tasks.length
        ? state.tasks.map(function (t, i) {
            return '<tr data-i="' + i + '">' +
              '<td><input type="text" data-t="name" value="' + esc(t.name) + '" placeholder="項目名"></td>' +
              '<td><input type="month" data-t="from" value="' + esc(t.from) + '"></td>' +
              '<td><input type="month" data-t="to" value="' + esc(t.to) + '"></td>' +
              '<td>' + swatches(t.color, 'data-task-color') + '</td>' +
              '<td><select data-t="assignee"' + (state.members.length ? '' : ' disabled') + '>' +
                (state.members.length
                  ? options(state.members.map(function (m) {
                      return { id: m.id, label: m.name || '（名前なし）' }; }), t.assignee, '未割当')
                  : '<option value="">（担当者なし）</option>') +
              '</select></td>' +
              '<td><select data-t="priority" data-pri="' + esc(t.priority) + '" aria-label="優先度">' +
                options(PRIORITIES.map(function (p) { return { id: p.id, label: p.label }; }), t.priority, '') +
              '</select></td>' +
              '<td><select data-t="status">' +
                options(STATUSES.map(function (s) { return { id: s.id, label: s.label }; }), t.status, '') +
              '</select></td>' +
              '<td><button type="button" class="l2-del" data-del-task aria-label="この作業を消す">×</button></td>' +
            '</tr>';
          }).join('')
        : '<tr class="l2-none"><td colspan="8">作業がありません。「作業を足す」から入れてください。</td></tr>';

      splitBox.innerHTML = state.tasks.length
        ? state.tasks.map(function (t, i) {
            return '<div class="split-card" data-i="' + i + '">' +
              '<p class="split-head"><span class="split-dot ph-' + esc(t.color) + '"></span>' +
                '<b>' + esc(t.name || '（名前なし）') + '</b>' + priChip(t.priority) +
                (t.subs.length ? '<span class="split-count">小項目 ' + subDone(t) + ' / ' + t.subs.length + '</span>' : '') +
              '</p>' +
              '<label class="split-detail"><span>内容</span>' +
                '<textarea data-t="detail" rows="2" placeholder="くわしい中身・決めること・必要な材料など">' +
                esc(t.detail) + '</textarea></label>' +
              (t.subs.length
                ? '<div class="table-scroll"><table class="tbl tbl-edit sub-table"><thead><tr>' +
                    '<th style="width:4%"><span class="visually-hidden">完了</span></th>' +
                    '<th style="width:22%">小項目</th><th>内容</th>' +
                    '<th style="width:19%">開始</th><th style="width:19%">終了</th>' +
                    '<th style="width:1%"><span class="visually-hidden">消す</span></th>' +
                  '</tr></thead><tbody>' + t.subs.map(function (s, j) {
                    return '<tr data-j="' + j + '"' + (s.done ? ' class="is-done"' : '') + '>' +
                      '<td><input type="checkbox" data-s="done"' + (s.done ? ' checked' : '') +
                        ' aria-label="この小項目を完了にする"></td>' +
                      '<td><input type="text" data-s="text" value="' + esc(s.text) + '" placeholder="小さく分けた作業"></td>' +
                      '<td><textarea data-s="detail" rows="2" placeholder="くわしい中身">' +
                        esc(s.detail) + '</textarea></td>' +
                      '<td><input type="month" data-s="from" value="' + esc(s.from) + '"></td>' +
                      '<td><input type="month" data-s="to" value="' + esc(s.to) + '"></td>' +
                      '<td><button type="button" class="l2-del" data-del-sub aria-label="この小項目を消す">×</button></td>' +
                    '</tr>';
                  }).join('') + '</tbody></table></div>'
                : '') +
              '<div class="split-actions"><button type="button" data-add-sub>小項目を足す</button></div>' +
            '</div>';
          }).join('')
        : '<p class="l2-empty">作業を足すと、ここで細かく分けられます。</p>';

      mbody.innerHTML = state.members.length
        ? state.members.map(function (m, i) {
            return '<tr data-i="' + i + '">' +
              '<td><input type="text" data-m="name" value="' + esc(m.name) + '" placeholder="名前"></td>' +
              '<td class="ph-count">' + heldBy(m.id) + '件</td>' +
              '<td><button type="button" class="l2-del" data-del-member aria-label="この担当者を消す">×</button></td>' +
            '</tr>';
          }).join('')
        : '<tr class="l2-none"><td colspan="3">担当者がいません。' +
          '「担当者を足す」から登録すると、作業に割り当てられます。</td></tr>';

      paint();
    }

    /* ================================================== 表示（上）======== */

    function renderView() {
      vbody.innerHTML = state.tasks.length
        ? state.tasks.map(function (t) {
            var who = memberName(t.assignee);
            var range = rangeLabel(t);
            return '<tr class="is-' + t.status + '">' +
              '<td class="vt-name"><span class="split-dot ph-' + esc(t.color) + '"></span>' +
                esc(t.name || '（名前なし）') + '</td>' +
              '<td class="vt-who">' + (who ? esc(who) : '<span class="vt-none">未割当</span>') + '</td>' +
              '<td>' + priChip(t.priority) + '</td>' +
              '<td class="vt-when">' + (range ? esc(range) : '<span class="vt-none">未定</span>') + '</td>' +
              '<td><span class="st st-' + t.status + '">' + statusLabel(t.status) + '</span></td>' +
              '<td class="vt-body">' +
                (t.detail ? '<p class="vt-detail">' + esc(t.detail) + '</p>' : '') +
                (t.subs.length
                  ? '<p class="vt-subhead">小項目 ' + subDone(t) + ' / ' + t.subs.length + '</p>' +
                    '<ul class="vt-subs">' + t.subs.map(function (s) {
                      var r = rangeLabel(s);
                      return '<li class="' + (s.done ? 'is-done' : '') + '">' +
                             esc(s.text || '（空）') +
                             (r ? '<span class="vt-subwhen">' + esc(r) + '</span>' : '') +
                             (s.detail ? '<span class="vt-subdetail">' + esc(s.detail) + '</span>' : '') +
                             '</li>';
                    }).join('') + '</ul>'
                  : '') +
                (!t.detail && !t.subs.length ? '<span class="vt-none">—</span>' : '') +
              '</td>' +
            '</tr>';
          }).join('')
        : '<tr class="l2-none"><td colspan="6">作業がありません。下の「作業を足す」から入れてください。</td></tr>';
    }

    function renderByMember() {
      var box = view.querySelector('[data-by-member]');
      var groups = state.members.map(function (m) {
        return { key: m.id, name: m.name || '（名前なし）',
                 tasks: state.tasks.filter(function (t) { return t.assignee === m.id; }) };
      });
      var none = state.tasks.filter(function (t) { return !t.assignee; });
      if (none.length) groups.push({ key: '', name: '未割当', tasks: none });

      if (!groups.length) {
        box.innerHTML = '<p class="l2-empty">担当者を登録して作業に割り当てると、ここに一覧が出ます。</p>';
        return;
      }

      box.innerHTML = '<div class="by-member">' + groups.map(function (g) {
        var doneN = g.tasks.filter(function (t) { return t.status === 'done'; }).length;
        return '<div class="bm-card' + (g.key ? '' : ' is-none') + '">' +
          '<p class="bm-head"><b>' + esc(g.name) + '</b>' +
            '<span class="bm-count">' + g.tasks.length + '件' +
            (g.tasks.length ? '（完了 ' + doneN + '）' : '') + '</span></p>' +
          (g.tasks.length
            ? '<ul class="bm-list">' + g.tasks.map(function (t) {
                return '<li class="is-' + t.status + '">' + priChip(t.priority) +
                       '<span class="bm-name">' + esc(t.name || '（名前なし）') + '</span>' +
                       '<span class="bm-when">' + esc(rangeLabel(t) || '期間未定') +
                       (t.subs.length ? '／小項目 ' + subDone(t) + '/' + t.subs.length : '') + '</span></li>';
              }).join('') + '</ul>'
            : '<p class="bm-empty">受け持ちなし</p>') +
        '</div>';
      }).join('') + '</div>';
    }

    function paint() {
      var done = state.tasks.filter(function (t) { return t.status === 'done'; }).length;
      var total = state.tasks.length;
      panel.querySelector('[data-done]').textContent = done;
      panel.querySelector('[data-total]').textContent = total;
      panel.querySelector('[data-meter]').style.width = (total ? done / total * 100 : 0) + '%';

      mbody.querySelectorAll('tr[data-i]').forEach(function (tr) {
        var m = state.members[+tr.dataset.i];
        if (m) tr.querySelector('.ph-count').textContent = heldBy(m.id) + '件';
      });
      splitBox.querySelectorAll('.split-card').forEach(function (card) {
        var t = state.tasks[+card.dataset.i];
        if (!t) return;
        card.querySelector('.split-head b').textContent = t.name || '（名前なし）';
        card.querySelector('.split-dot').className = 'split-dot ph-' + t.color;
        card.querySelector('.pri').outerHTML = priChip(t.priority);
        var c = card.querySelector('.split-count');
        if (c) c.textContent = '小項目 ' + subDone(t) + ' / ' + t.subs.length;
      });

      renderView();
      renderByMember();
      renderGantt();
      io.sync();
    }

    /* ================================================== ガント図 ========= */

    // 作業と、年月が入っている小項目を1行ずつ並べる（小項目はぶら下げて描く）
    function ganttRows() {
      var rows = [];
      state.tasks.forEach(function (t) {
        rows.push({ kind: 'task', name: t.name || '（名前なし）', who: memberName(t.assignee),
                    color: t.color, status: t.status, range: rangeOf(t), label: rangeLabel(t),
                    pri: priorityOf(t.priority).label });
        t.subs.forEach(function (s) {
          var r = rangeOf(s);
          if (!r) return;   // 年月の無い小項目は図に出さない
          rows.push({ kind: 'sub', name: s.text || '（空）', who: '', color: t.color,
                      status: s.done ? 'done' : 'todo', range: r, label: rangeLabel(s),
                      pri: '', note: s.detail });
        });
      });
      return rows;
    }

    function renderGantt() {
      var rows = ganttRows();
      var dated = rows.filter(function (r) { return r.range; });

      if (!dated.length) {
        host.innerHTML = '<figure class="viz"><p class="l2-empty">' +
          '下の表に作業と「開始」「終了」の年月を入れると、ここにガント図が出ます。' +
          '（終了は開始と同じ月でもかまいません）</p></figure>';
        return;
      }

      var min = Math.min.apply(null, dated.map(function (r) { return r.range.a; }));
      var max = Math.max.apply(null, dated.map(function (r) { return r.range.b; }));
      var span = max - min + 1;
      var step = Math.max(1, Math.ceil(span / 4));

      var ticks = [], lastYear = null;
      function tick(i) {
        var idx = min + i;
        var year = Math.floor(idx / 12);
        ticks.push({ at: i / span * 100, text: mLabel(idx, year !== lastYear) });
        lastYear = year;
      }
      for (var i = 0; i <= span; i += step) tick(i);
      if (ticks[ticks.length - 1].at < 100) tick(span);

      var html = rows.map(function (r) {
        var cls = 'gt-row is-' + r.status + (r.kind === 'sub' ? ' is-sub' : '');
        var name = '<span class="gt-name">' + esc(r.name) +
                   (r.who ? '<small>' + esc(r.who) + '</small>' : '') + '</span>';

        if (!r.range) {
          return '<div class="' + cls + '">' + name +
                 '<span class="gt-track"><span class="gt-blank">年月を入れてください</span></span></div>';
        }
        var left  = (r.range.a - min) / span * 100;
        var width = (r.range.b - r.range.a + 1) / span * 100;
        var place = width >= 30 ? ' class="inside"' : (left + width > 62 ? ' class="before"' : '');

        return '<div class="' + cls + '">' + name +
          '<span class="gt-track"><span class="gt-bar ph-' + esc(r.color) + '" ' +
            'style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%" ' +
            'title="' + esc(r.name) + ' ' + r.label + (r.who ? '／担当 ' + esc(r.who) : '') +
            (r.pri ? '／優先度 ' + r.pri : '') + (r.note ? '\n' + esc(r.note) : '') + '"' +
            '><span' + place + '>' + r.label + '</span></span></span>' +
        '</div>';
      }).join('');

      host.innerHTML =
        '<figure class="viz">' +
          '<p class="viz-title">' + mLabel(min, true) + ' から ' + mLabel(max, true) + ' まで</p>' +
          '<div class="gantt" style="--gt-div:' + (step / span * 100).toFixed(3) + '%">' +
            '<div class="gt-head"><span></span><span class="gt-scale">' +
              ticks.map(function (t) {
                return '<span style="left:' + t.at.toFixed(2) + '%">' + t.text + '</span>';
              }).join('') +
            '</span></div>' + html +
          '</div>' +
        '</figure>';
    }

    /* ================================================== 入力 ============= */

    function applyInput(el) {
      var card = el.closest('.split-card');

      if (el.dataset.t) {
        var tr = el.closest('tr');
        var t = state.tasks[+(card ? card.dataset.i : tr.dataset.i)];
        if (!t) return;
        if (el.dataset.t === 'status' && el.value !== t.status) {
          t.at = el.value === 'todo' ? '' : today();
        }
        t[el.dataset.t] = el.value;
        t.updated = now();
        if (el.dataset.t === 'priority') el.dataset.pri = el.value;
        touch();
        paint();
        return;
      }

      if (el.dataset.s) {
        var row = el.closest('tr');
        var owner = card && state.tasks[+card.dataset.i];
        var sub = owner && owner.subs[+row.dataset.j];
        if (!sub) return;
        sub[el.dataset.s] = el.type === 'checkbox' ? el.checked : el.value;
        sub.updated = now();
        owner.updated = now();
        row.classList.toggle('is-done', !!sub.done);
        touch();
        paint();
        return;
      }

      if (el.dataset.m) {
        var mr = el.closest('tr');
        var m = state.members[+mr.dataset.i];
        if (!m) return;
        m[el.dataset.m] = el.value;
        m.updated = now();
        touch();
        tbody.querySelectorAll('[data-t="assignee"] option[value="' + m.id + '"]').forEach(function (o) {
          o.textContent = m.name || '（名前なし）';
        });
        paint();
      }
    }

    panel.addEventListener('input', function (e) { applyInput(e.target); });
    panel.addEventListener('change', function (e) {
      if (e.target.tagName === 'SELECT' || e.target.type === 'month' || e.target.type === 'checkbox') {
        applyInput(e.target);
      }
    });

    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;

      // 色見本は行を作り直さず、押した見本の印だけを付け替える
      if (btn.hasAttribute('data-task-color')) {
        var ct = state.tasks[+btn.closest('tr').dataset.i];
        if (!ct) return;
        ct.color = btn.dataset.color;
        ct.updated = now();
        btn.parentElement.querySelectorAll('.ph-sw').forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        touch();
        paint();
        return;
      }

      if (btn.hasAttribute('data-add-task')) {
        state.tasks.push({ id: 'task-' + now(), name: '', detail: '', from: '', to: '',
                           color: freeColor(), assignee: '', priority: 'mid',
                           status: 'todo', at: '', subs: [], updated: now() });
      } else if (btn.hasAttribute('data-del-task')) {
        var goneT = state.tasks[+btn.closest('tr').dataset.i];
        if (!goneT) return;
        bury(goneT.id);
        goneT.subs.forEach(function (s) { bury(s.id); });
        state.tasks = state.tasks.filter(function (t) { return t !== goneT; });
      } else if (btn.hasAttribute('data-add-sub')) {
        var owner = state.tasks[+btn.closest('.split-card').dataset.i];
        if (!owner) return;
        owner.subs.push({ id: 'sub-' + now(), text: '', detail: '', from: '', to: '',
                          done: false, updated: now() });
        owner.updated = now();
      } else if (btn.hasAttribute('data-del-sub')) {
        var srow = btn.closest('tr');
        var host2 = state.tasks[+btn.closest('.split-card').dataset.i];
        if (!host2) return;
        var goneS = host2.subs[+srow.dataset.j];
        if (goneS) bury(goneS.id);
        host2.subs = host2.subs.filter(function (s) { return s !== goneS; });
        host2.updated = now();
      } else if (btn.hasAttribute('data-add-member')) {
        state.members.push({ id: 'mem-' + now(), name: '', updated: now() });
      } else if (btn.hasAttribute('data-del-member')) {
        var goneM = state.members[+btn.closest('tr').dataset.i];
        if (!goneM) return;
        var held = heldBy(goneM.id);
        if (held && !confirm('「' + (goneM.name || '名前なし') + '」が受け持つ作業が' + held + '件あります。\n' +
                             'それらは未割当になります。\n\nよろしいですか？')) return;
        state.tasks.forEach(function (t) {
          if (t.assignee === goneM.id) { t.assignee = ''; t.updated = now(); }
        });
        bury(goneM.id);
        state.members = state.members.filter(function (m) { return m !== goneM; });
      } else if (btn.hasAttribute('data-clear-tasks')) {
        if (!state.tasks.length) return;
        if (!confirm('作業を' + state.tasks.length + '件すべて削除します。内容・小項目・進捗も消えます。\n' +
                     '（担当者は残ります）\n\nよろしいですか？')) return;
        state.tasks.forEach(function (t) {
          bury(t.id);
          t.subs.forEach(function (s) { bury(s.id); });
        });
        state.tasks = [];
      } else if (btn.hasAttribute('data-clear-members')) {
        if (!state.members.length) return;
        var knownM = {};
        state.members.forEach(function (m) { knownM[m.id] = 1; });
        var assigned = state.tasks.filter(function (t) { return knownM[t.assignee]; }).length;
        if (!confirm('担当者を' + state.members.length + '人すべて削除します。\n' +
                     (assigned ? '作業' + assigned + '件は未割当になります。\n' : '') +
                     '（作業そのものは消えません）\n\nよろしいですか？')) return;
        state.members.forEach(function (m) { bury(m.id); });
        state.members = [];
        state.tasks.forEach(function (t) { t.assignee = ''; t.updated = now(); });
      } else return;

      touch();
      rebuild();
    });

    /* ================================================== 共有 ============= */

    function buildShare() {
      var bar = document.createElement('div');
      bar.className = 'share';
      bar.innerHTML =
        '<div class="share-bar">' +
          '<span class="share-state" data-share-state>共有：確認中…</span>' +
          '<span class="share-btns"><button type="button" data-share-now>今すぐ同期</button></span>' +
        '</div>';

      var conf = document.createElement('details');
      conf.className = 'share-conf';
      conf.innerHTML =
        '<summary>共有の設定<span class="chat-key-state" data-share-conf-state>未設定</span></summary>' +
        '<p class="chat-key-note">' +
          '書き換えると<strong>自動で3人に反映されます</strong>（数秒後に送られ、' +
          '他の人の変更も定期的に取り込まれます）。' +
          '内容は GitHub のファイルに置きますが、サイトと同じパスワードで暗号化するので' +
          'リポジトリを見ても読めません。' +
          '<br><strong>書き込むにはアクセストークンが必要です。</strong>' +
          '無いときは自分の画面にだけ残ります（読み込みはトークン無しでもできます）。' +
        '</p>' +
        '<label class="share-field"><span>あなたの名前</span>' +
          '<input type="text" data-share-name placeholder="例）きょうすけ" spellcheck="false"></label>' +
        '<label class="share-field"><span>アクセストークン</span>' +
          '<input type="password" data-share-token placeholder="github_pat_… / ghp_…" spellcheck="false" autocomplete="off"></label>' +
        '<div class="prog-io-btns">' +
          '<button type="button" data-share-save>設定を保存</button>' +
          '<button type="button" data-share-clear>トークンを消す</button>' +
        '</div>' +
        '<p class="prog-io-msg" data-share-msg role="status" aria-live="polite"></p>';

      var stateEl = bar.querySelector('[data-share-state]');
      var msgEl   = conf.querySelector('[data-share-msg]');
      var nameEl  = conf.querySelector('[data-share-name]');
      var tokenEl = conf.querySelector('[data-share-token]');
      var confEl  = conf.querySelector('[data-share-conf-state]');

      var token = '', myName = '', sha = null, remote = null;
      var pushTimer = null, pullTimer = null, busy = false, pending = false;
      var lastSent = '';

      try {
        token  = localStorage.getItem(GH_TOKEN_KEY) || '';
        myName = localStorage.getItem(MYNAME_KEY) || '';
      } catch (e) {}
      tokenEl.value = token;
      nameEl.value = myName;

      function confState() {
        confEl.textContent = token ? '設定済み' : '未設定';
        confEl.className = 'chat-key-state' + (token ? ' is-on' : '');
      }
      confState();

      function msg(t) { msgEl.textContent = t; setTimeout(function () { msgEl.textContent = ''; }, 5000); }
      function say(t, kind) {
        stateEl.textContent = t;
        stateEl.className = 'share-state' + (kind ? ' is-' + kind : '');
      }
      function idle() {
        if (!token) { say('共有：トークン未設定 — この端末にだけ残ります', 'warn'); return; }
        say('共有：自動' + (remote ? '（' + (remote.savedBy ? remote.savedBy + 'さん ' : '') +
                                     remote.savedAt + ' に反映）' : ''), 'ok');
      }

      function headers(extra) {
        var h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        if (token) h.Authorization = 'Bearer ' + token;
        if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
        return h;
      }
      function apiUrl() {
        return 'https://api.github.com/repos/' + preset.share.repo + '/contents/' + preset.share.path;
      }
      function netError(err) {
        var m = err && err.message ? err.message : String(err);
        return /failed to fetch|networkerror|load failed/i.test(m)
          ? 'ネットにつながりません' : m;
      }
      function ghError(status) {
        if (status === 401) return 'トークンが正しくないようです（401）';
        if (status === 403) return 'このトークンでは書き込めません（403）';
        if (status === 404) return '共有ファイルがありません（404）';
        return 'GitHub でエラー（' + status + '）';
      }

      function fetchRemote() {
        return fetch(apiUrl() + '?ref=' + encodeURIComponent(preset.share.branch) + '&t=' + Date.now(),
                     { headers: headers(), cache: 'no-store' })
          .then(function (res) {
            if (res.status === 404) { sha = null; return null; }
            if (!res.ok) throw new Error(ghError(res.status));
            return res.json().then(function (j) {
              sha = j.sha;
              var raw = atob(String(j.content || '').replace(/\s/g, ''));
              var bytes = new Uint8Array(raw.length);
              for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
              var env = JSON.parse(new TextDecoder().decode(bytes));
              return decryptBlob(sessionPassword(), env).then(function (text) {
                return { savedBy: env.savedBy || '', savedAt: env.savedAt || '',
                         data: JSON.parse(text) };
              });
            });
          });
      }

      // 入力中に作り直すとカーソルが飛ぶので、手が止まるまで待って描き直す。
      // 待つのは「画面の作り直し」だけで、送受信そのものは止めない。
      var redrawTimer = null;
      function editing() {
        var a = document.activeElement;
        return !!(a && panel.contains(a) &&
                  /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox');
      }
      function safeRebuild() {
        clearTimeout(redrawTimer);
        if (editing()) { redrawTimer = setTimeout(safeRebuild, 800); return; }
        rebuild();
      }

      function sync(force) {
        if (busy) { pending = true; return Promise.resolve(); }
        busy = true;
        return fetchRemote()
          .then(function (r) {
            var theirs = r ? normalize(r.data) : null;
            // 相手の内容と自分の内容を突き合わせる（作業ごとに新しいほうを採る）
            var merged = theirs ? mergeStates(state, theirs) : state;

            var before = JSON.stringify(state);
            var after  = JSON.stringify(merged);

            if (after !== before) {
              state = merged;
              writeStore(SCHEDULE_KEY, state);
              safeRebuild();
            }

            // 混ぜた結果が相手のものと同じなら、送る必要はない
            if (theirs && after === JSON.stringify(theirs)) { lastSent = after; idle(); return; }
            if (!token) { idle(); return; }
            if (after === lastSent) { idle(); return; }
            return push(after);
          })
          .catch(function (err) { say('共有：' + netError(err), 'warn'); })
          .then(function () {
            busy = false;
            if (pending) { pending = false; setTimeout(function () { sync(false); }, 400); }
          });
      }

      function push(text) {
        var pw = sessionPassword();
        if (!pw) { say('共有：パスワードが取り出せません', 'warn'); return; }
        say('共有：送信中…');
        var stamp = stampNow();
        return encryptText(pw, text).then(function (blob) {
          blob.savedBy = myName || '（名前なし）';
          blob.savedAt = stamp;
          var body = { message: '予定を更新（' + blob.savedBy + '）',
                       content: utf8ToB64(JSON.stringify(blob)),
                       branch: preset.share.branch };
          if (sha) body.sha = sha;
          return fetch(apiUrl(), { method: 'PUT',
                                   headers: headers({ 'Content-Type': 'application/json' }),
                                   body: JSON.stringify(body) });
        }).then(function (res) {
          if (res.status === 409 || res.status === 422) {
            // ほかの人が先に保存していた。取り直して混ぜ、次の周回で送る
            pending = true;
            say('共有：ほかの人の変更を取り込んでいます…');
            return;
          }
          if (!res.ok) throw new Error(ghError(res.status));
          return res.json().then(function (j) {
            sha = j.content && j.content.sha;
            lastSent = text;
            remote = { savedBy: myName || '（名前なし）', savedAt: stamp };
            idle();
          });
        });
      }

      bar.querySelector('[data-share-now]').addEventListener('click', function () { sync(true); });

      conf.querySelector('[data-share-save]').addEventListener('click', function () {
        token = tokenEl.value.trim();
        myName = nameEl.value.trim();
        try {
          if (token) localStorage.setItem(GH_TOKEN_KEY, token); else localStorage.removeItem(GH_TOKEN_KEY);
          localStorage.setItem(MYNAME_KEY, myName);
        } catch (e) {}
        confState();
        msg('保存しました');
        sync(true);
      });

      conf.querySelector('[data-share-clear]').addEventListener('click', function () {
        token = '';
        tokenEl.value = '';
        try { localStorage.removeItem(GH_TOKEN_KEY); } catch (e) {}
        confState();
        msg('消しました');
        idle();
      });

      return {
        el: bar,
        conf: conf,
        // 書き換えのたびに呼ばれる。連打しても数秒に1回だけ送る
        queue: function () {
          say('共有：まもなく反映します…');
          clearTimeout(pushTimer);
          pushTimer = setTimeout(function () { sync(false); }, 2500);
        },
        start: function () {
          sync(true);
          pullTimer = setInterval(function () { sync(false); }, 25000);
          // タブに戻ってきたときも取り込む
          document.addEventListener('visibilitychange', function () {
            if (!document.hidden) sync(false);
          });
        }
      };
    }

    rebuild();
    share.start();
  }

  function stampNow() {
    var d = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) +
           ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
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

  // 「書き出し / 読み込み」のパネル。スケジュールも第2ロットも同じ形で共有する。
  //   emptyState … 「全て空欄にする」で戻す先。何も入っていない状態を返すこと
  //   whatClears … 確認ダイアログで「何が消えるか」を伝える文言
  function ioPanel(getState, setState, emptyState, whatClears) {
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
        '<button type="button" data-undo hidden>空欄にする前に戻す</button>' +
        '<button type="button" data-reset>全て空欄にする</button>' +
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

    // 押し間違え用の控え。空欄にする直前の内容をここに持っておく
    var undoSnapshot = null;
    var undoBtn = box.querySelector('[data-undo]');

    box.querySelector('[data-reset]').addEventListener('click', function () {
      var before = JSON.stringify(getState());
      if (!confirm((whatClears || '入力した内容') + 'をすべて消して、空欄の状態にします。\n' +
                   '押し間違えたときは「空欄にする前に戻す」で戻せます。\n\nよろしいですか？')) return;

      undoSnapshot = before;
      undoBtn.hidden = false;
      setState(emptyState());
      msg('空欄にしました');
    });

    undoBtn.addEventListener('click', function () {
      if (!undoSnapshot) return;
      setState(JSON.parse(undoSnapshot));
      undoSnapshot = null;
      undoBtn.hidden = true;
      msg('空欄にする前に戻しました');
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

    // 何も入っていない状態（図の案内文を出す empty(host, text) とは別物）
    function emptyState() {
      return { base: { cans: '', perCase: '', shops: '', price: '' }, costs: [], stock: [] };
    }

    // 初回に出す下書き。項目名だけ第1ロットから借りて、金額は空にしておく
    function scaffold() {
      var s = emptyState();
      s.costs = preset.costs.map(function (c) { return { item: c.item, unit: c.unit, amount: '' }; });
      return s;
    }

    var state = readStore(LOT2_KEY, null);
    if (!state || !Array.isArray(state.costs)) state = scaffold();
    if (!state.base) state.base = emptyState().base;
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
      '<table class="tbl tbl-edit l2-costs"><thead><tr>' +
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
      '<table class="tbl tbl-edit l2-stock"><thead><tr>' +
        '<th style="width:44%">出荷先</th><th style="width:26%">種別</th><th style="width:22%">本数</th>' +
        '<th style="width:1%"><span class="visually-hidden">消す</span></th>' +
      '</tr></thead><tbody data-stock-body></tbody></table>' +
      '<div class="l2-actions"><button type="button" data-add-stock>出荷先を足す</button></div>' +
      '<figure class="viz"><p class="viz-title">在庫の残り</p><div data-stock-chart></div></figure>';

    sec.appendChild(wrap);

    var io = ioPanel(function () { return state; },
                     function (next) { state = normalize(next); persist(); rebuild(); },
                     emptyState, '基本の数字・費用・在庫');
    sec.appendChild(io);

    function field(key, label, unit, ph, step) {
      return '<label class="l2-field"><span class="l2-field-label">' + label + '</span>' +
             '<input type="number" inputmode="decimal" min="0" step="' + step + '" ' +
             'data-base="' + key + '" placeholder="' + ph + '">' +
             '<em>' + unit + '</em></label>';
    }

    function normalize(next) {
      var b = emptyState();
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
      cb.innerHTML = state.costs.length
        ? state.costs.map(function (c, i) {
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
          }).join('')
        : '<tr class="l2-none"><td colspan="6">項目がありません。' +
          '「項目を足す」か「第1ロットの数字を入れる」を押してください。</td></tr>';

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
