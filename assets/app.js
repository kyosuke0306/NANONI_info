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
  var LOT2_KEY     = 'nanoni.lot2.v1';
  var APIKEY_KEY   = 'nanoni.apikey.v1';

  var STATUSES = [
    { id: 'todo',  label: '未着手' },
    { id: 'doing', label: '進行中' },
    { id: 'done',  label: '完了' }
  ];

  // 区分に選べる色。色の見分けやすさを確かめた組み合わせだけを出す
  // （赤と茶は暗い画面で見分けにくいので、赤は入れていない）
  var PHASE_COLORS = [
    { id: 'c1',  label: '濃い茶' },
    { id: 'c2',  label: '茶' },
    { id: 'c3',  label: '薄い茶' },
    { id: 'c4',  label: 'ごく薄い茶' },
    { id: 'rev', label: '青' },
    { id: 'unk', label: '灰' }
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
      phases: Array.prototype.map.call(el.querySelectorAll('[data-phase-def]'), function (s) {
        return { id: s.dataset.phaseDef, label: s.dataset.label, color: s.dataset.color };
      }),
      tasks: Array.prototype.map.call(el.querySelectorAll('[data-task]'), function (s) {
        return {
          id: s.dataset.task, name: s.dataset.name,
          from: s.dataset.from, to: s.dataset.to,
          phase: s.dataset.phase, status: 'todo', at: ''
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

    function fromPreset() {
      return {
        phases: preset.phases.map(function (p) {
          return { id: p.id, label: p.label, color: p.color };
        }),
        tasks: preset.tasks.map(function (t) {
          return { id: t.id, name: t.name, from: t.from, to: t.to, phase: t.phase, status: 'todo', at: '' };
        })
      };
    }

    // 何も入っていない状態。区分は選択肢として1つだけ残す（0個だと作業を足せない）
    function emptyState() {
      return {
        phases: [{ id: 'ph-' + Date.now(), label: '', color: PHASE_COLORS[0].id }],
        tasks: []
      };
    }

    function isColor(id) {
      return PHASE_COLORS.some(function (c) { return c.id === id; });
    }

    // 状態だけを持っていた古い記録（進捗のみ）を引き継ぐ
    function migrate(base) {
      var old = readStore(PROGRESS_KEY, null);
      if (!old) return base;
      base.tasks.forEach(function (t) {
        var rec = old[t.id];
        if (rec && rec.status) { t.status = rec.status; t.at = rec.at || ''; }
      });
      return base;
    }

    // 受け取った JSON を整える。作業だけの古い形式も読めるようにしておく
    function normalize(next) {
      if (!next || typeof next !== 'object') return fromPreset();

      if (Array.isArray(next.tasks)) {
        // 区分を持っていない記録（区分が編集できなかった頃のもの）はひな形の区分を使う
        var phases = (Array.isArray(next.phases) && next.phases.length)
          ? next.phases.filter(function (p) { return p && typeof p === 'object' && p.id; })
                       .map(function (p) {
              return {
                id: String(p.id),
                label: p.label == null ? '' : String(p.label),
                color: isColor(p.color) ? p.color : PHASE_COLORS[0].id
              };
            })
          : fromPreset().phases;

        if (!phases.length) phases = fromPreset().phases;

        var known = {};
        phases.forEach(function (p) { known[p.id] = 1; });

        return {
          phases: phases,
          tasks: next.tasks.filter(function (t) { return t && typeof t === 'object'; })
                           .map(function (t, i) {
            return {
              id: t.id || ('t' + i + '-' + Date.now()),
              name: t.name == null ? '' : String(t.name),
              from: t.from == null ? '' : String(t.from),
              to:   t.to   == null ? '' : String(t.to),
              // 無くなった区分を指している作業は先頭の区分に寄せる
              phase: known[t.phase] ? t.phase : phases[0].id,
              status: t.status === 'doing' || t.status === 'done' ? t.status : 'todo',
              at: t.at == null ? '' : String(t.at)
            };
          })
        };
      }

      // 旧形式 { taskId: { status, at } } … 進捗だけを今の予定に重ねる
      var base = fromPreset();
      base.tasks.forEach(function (t) {
        var rec = next[t.id];
        if (rec && rec.status) { t.status = rec.status; t.at = rec.at || ''; }
      });
      return base;
    }

    var stored = readStore(SCHEDULE_KEY, null);
    var state = stored ? normalize(stored) : migrate(fromPreset());

    var panel = document.createElement('section');
    panel.id = 'progress';
    panel.innerHTML =
      '<h2>予定と進捗の記録</h2>' +
      '<div class="callout callout-note">' +
        '<p class="callout-title">この端末にだけ保存されます</p>' +
        '<p>書き換えた予定と進捗はブラウザの中に保存されるため、<strong>ほかの人の画面には出ません</strong>。' +
        '共有したいときは下の「記録の書き出し / 読み込み」でコピーして渡し、相手が「読み込む」に貼り付けてください。</p>' +
      '</div>' +
      '<div class="prog-summary">' +
        '<p class="prog-count"><b data-done>0</b> / <span data-total>0</span> 完了</p>' +
        '<div class="prog-meter"><span data-meter style="width:0%"></span></div>' +
      '</div>' +
      '<h3 id="schedule-tasks">作業</h3>' +
      '<table class="tbl tbl-edit prog-table"><thead><tr>' +
        '<th style="width:28%">作業</th><th style="width:16%">開始</th><th style="width:16%">終了</th>' +
        '<th style="width:22%">区分</th><th style="width:16%">状態</th>' +
        '<th style="width:1%"><span class="visually-hidden">消す</span></th>' +
      '</tr></thead><tbody data-prog-body></tbody></table>' +
      '<div class="l2-actions">' +
        '<button type="button" data-add-task>作業を足す</button>' +
        '<button type="button" class="is-danger" data-clear-tasks>全て削除する</button>' +
      '</div>' +

      '<h3 id="schedule-phases">区分（バーの色）</h3>' +
      '<p class="viz-note">作業のまとまりに名前と色を付けます。図の凡例もここから作られます。</p>' +
      '<table class="tbl tbl-edit phase-table"><thead><tr>' +
        '<th style="width:36%">名前</th><th style="width:48%">色</th><th style="width:15%">使っている作業</th>' +
        '<th style="width:1%"><span class="visually-hidden">消す</span></th>' +
      '</tr></thead><tbody data-phase-body></tbody></table>' +
      '<div class="l2-actions">' +
        '<button type="button" data-add-phase>区分を足す</button>' +
      '</div>';

    docEl.querySelector('#schedule').appendChild(panel);

    var io = ioPanel(function () { return state; },
                     function (next) { state = normalize(next); persist(); rebuild(); },
                     emptyState, '作業・区分・進捗');
    panel.appendChild(io);

    var tbody = panel.querySelector('[data-prog-body]');
    var pbody = panel.querySelector('[data-phase-body]');

    function persist() {
      writeStore(SCHEDULE_KEY, state);
      io.sync();
    }

    function phaseOf(id) {
      for (var i = 0; i < state.phases.length; i++) {
        if (state.phases[i].id === id) return state.phases[i];
      }
      return state.phases[0];
    }

    function usedBy(phaseId) {
      return state.tasks.filter(function (t) { return t.phase === phaseId; }).length;
    }

    // 区分を足すときは、まだ使っていない色から選ぶ（全部使っていたら順に回す）
    function freeColor() {
      var taken = {};
      state.phases.forEach(function (p) { taken[p.color] = 1; });
      for (var i = 0; i < PHASE_COLORS.length; i++) {
        if (!taken[PHASE_COLORS[i].id]) return PHASE_COLORS[i].id;
      }
      return PHASE_COLORS[state.phases.length % PHASE_COLORS.length].id;
    }

    /* ---- 表 ---- */

    function rebuild() {
      tbody.innerHTML = state.tasks.length
        ? state.tasks.map(function (t, i) {
            return '<tr data-i="' + i + '">' +
              '<td><input type="text" data-t="name" value="' + esc(t.name) + '" placeholder="作業の名前"></td>' +
              '<td><input type="month" data-t="from" value="' + esc(t.from) + '"></td>' +
              '<td><input type="month" data-t="to" value="' + esc(t.to) + '"></td>' +
              '<td><select data-t="phase">' + state.phases.map(function (p) {
                return '<option value="' + esc(p.id) + '"' + (p.id === t.phase ? ' selected' : '') + '>' +
                       esc(p.label || '（名前なし）') + '</option>';
              }).join('') + '</select></td>' +
              '<td><select data-t="status">' + STATUSES.map(function (s) {
                return '<option value="' + s.id + '"' + (s.id === t.status ? ' selected' : '') + '>' +
                       s.label + '</option>';
              }).join('') + '</select></td>' +
              '<td><button type="button" class="l2-del" data-del-task aria-label="この作業を消す">×</button></td>' +
            '</tr>';
          }).join('')
        : '<tr class="l2-none"><td colspan="6">作業がありません。「作業を足す」から入れてください。</td></tr>';

      pbody.innerHTML = state.phases.map(function (p, i) {
        var n = usedBy(p.id);
        return '<tr data-i="' + i + '">' +
          '<td><input type="text" data-ph="label" value="' + esc(p.label) + '" placeholder="区分の名前"></td>' +
          '<td><div class="ph-swatches" role="group" aria-label="' + esc(p.label) + ' の色">' +
            PHASE_COLORS.map(function (c) {
              return '<button type="button" class="ph-sw ph-' + c.id + (c.id === p.color ? ' is-on' : '') +
                     '" data-color="' + c.id + '" title="' + c.label + '" aria-label="' + c.label + '"' +
                     (c.id === p.color ? ' aria-pressed="true"' : ' aria-pressed="false"') + '></button>';
            }).join('') +
          '</div></td>' +
          '<td class="ph-count">' + n + '件</td>' +
          '<td><button type="button" class="l2-del" data-del-phase aria-label="この区分を消す"' +
            (state.phases.length < 2 ? ' disabled title="区分は1つ以上必要です"' : '') + '>×</button></td>' +
        '</tr>';
      }).join('');

      paint();
    }

    function paint() {
      var done = state.tasks.filter(function (t) { return t.status === 'done'; }).length;
      var total = state.tasks.length;
      panel.querySelector('[data-done]').textContent = done;
      panel.querySelector('[data-total]').textContent = total;
      panel.querySelector('[data-meter]').style.width = (total ? done / total * 100 : 0) + '%';

      pbody.querySelectorAll('tr').forEach(function (tr) {
        var p = state.phases[+tr.dataset.i];
        if (p) tr.querySelector('.ph-count').textContent = usedBy(p.id) + '件';
      });

      renderGantt();
      io.sync();
    }

    /* ---- ガント図 ---- */

    function renderGantt() {
      var ok = state.tasks.filter(function (t) {
        return mIndex(t.from) !== null && mIndex(t.to) !== null && mIndex(t.to) >= mIndex(t.from);
      });

      if (!ok.length) {
        host.innerHTML = '<figure class="viz"><p class="l2-empty">' +
          '下の表に作業と「開始」「終了」の年月を入れると、ここにガント図が出ます。' +
          '（終了は開始と同じ月でもかまいません）</p></figure>';
        return;
      }

      var min = Math.min.apply(null, ok.map(function (t) { return mIndex(t.from); }));
      var max = Math.max.apply(null, ok.map(function (t) { return mIndex(t.to); }));
      var span = max - min + 1;
      var step = Math.max(1, Math.ceil(span / 4));

      // 目盛り。年が変わったときだけ「26年」を付ける
      var ticks = [], lastYear = null;
      function tick(i) {
        var idx = min + i;
        var year = Math.floor(idx / 12);
        ticks.push({ at: i / span * 100, text: mLabel(idx, year !== lastYear) });
        lastYear = year;
      }
      for (var i = 0; i <= span; i += step) tick(i);
      // 右端に必ず目盛りを置く（最後の1つは右揃えで描くため、100%でないとずれる）
      if (ticks[ticks.length - 1].at < 100) tick(span);

      var rows = state.tasks.map(function (t) {
        var a = mIndex(t.from), b = mIndex(t.to);
        if (a === null || b === null || b < a) {
          return '<div class="gt-row is-' + t.status + '">' +
                 '<span class="gt-name">' + esc(t.name || '（名前なし）') + '</span>' +
                 '<span class="gt-track"><span class="gt-blank">年月を入れてください</span></span></div>';
        }
        var left  = (a - min) / span * 100;
        var width = (b - a + 1) / span * 100;
        var label = a === b ? mLabel(a, true) : mLabel(a, true) + '〜' + mLabel(b, Math.floor(a / 12) !== Math.floor(b / 12));

        // 幅が足りないラベルはバーの外へ。右端に寄るものは左側に出す
        var place = width >= 30 ? ' class="inside"' : (left + width > 62 ? ' class="before"' : '');

        return '<div class="gt-row is-' + t.status + '">' +
          '<span class="gt-name">' + esc(t.name || '（名前なし）') + '</span>' +
          '<span class="gt-track"><span class="gt-bar ph-' + esc(phaseOf(t.phase).color) + '" ' +
            'style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%" ' +
            'title="' + esc(t.name) + ' ' + label + '"><span' + place + '>' + label + '</span></span></span>' +
        '</div>';
      }).join('');

      // 使っている区分だけを凡例に出す
      var used = {};
      state.tasks.forEach(function (t) { used[t.phase] = 1; });

      host.innerHTML =
        '<figure class="viz">' +
          '<p class="viz-title">' + mLabel(min, true) + ' から ' + mLabel(max, true) + ' まで</p>' +
          '<div class="gantt" style="--gt-div:' + (step / span * 100).toFixed(3) + '%">' +
            '<div class="gt-head"><span></span><span class="gt-scale">' +
              ticks.map(function (t) {
                return '<span style="left:' + t.at.toFixed(2) + '%">' + t.text + '</span>';
              }).join('') +
            '</span></div>' + rows +
          '</div>' +
          '<ul class="viz-legend">' + state.phases.filter(function (p) { return used[p.id]; })
            .map(function (p) {
              return '<li><span class="sw ph-' + esc(p.color) + '"></span>' +
                     esc(p.label || '（名前なし）') + '</li>';
            }).join('') + '</ul>' +
        '</figure>';
    }

    /* ---- 入力の受け取り ---- */

    function applyInput(el) {
      var row = el.closest('tr');
      if (!row) return;

      if (el.dataset.t) {
        var t = state.tasks[+row.dataset.i];
        if (!t) return;
        if (el.dataset.t === 'status' && el.value !== t.status) {
          t.at = el.value === 'todo' ? '' : today();
        }
        t[el.dataset.t] = el.value;
        persist();
        paint();
        return;
      }

      if (el.dataset.ph) {
        var p = state.phases[+row.dataset.i];
        if (!p) return;
        p[el.dataset.ph] = el.value;
        persist();
        // 区分名は作業側の選択肢にも出るので、そちらも書き換える
        tbody.querySelectorAll('[data-t="phase"] option[value="' + p.id + '"]').forEach(function (o) {
          o.textContent = p.label || '（名前なし）';
        });
        paint();
      }
    }

    panel.addEventListener('input', function (e) { applyInput(e.target); });
    panel.addEventListener('change', function (e) {
      if (e.target.tagName === 'SELECT' || e.target.type === 'month') applyInput(e.target);
    });

    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;

      // 色見本は行を作り直さず、押した見本の印だけを付け替える
      if (btn.classList.contains('ph-sw')) {
        var ph = state.phases[+btn.closest('tr').dataset.i];
        if (!ph) return;
        ph.color = btn.dataset.color;
        btn.parentElement.querySelectorAll('.ph-sw').forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        persist();
        paint();
        return;
      }

      if (btn.hasAttribute('data-add-task')) {
        state.tasks.push({ id: 'task-' + Date.now(), name: '', from: '', to: '',
                           phase: state.phases[0].id, status: 'todo', at: '' });
      } else if (btn.hasAttribute('data-del-task')) {
        state.tasks.splice(+btn.closest('tr').dataset.i, 1);
      } else if (btn.hasAttribute('data-add-phase')) {
        state.phases.push({ id: 'ph-' + Date.now(), label: '', color: freeColor() });
      } else if (btn.hasAttribute('data-del-phase')) {
        if (state.phases.length < 2) return;
        var gone = state.phases[+btn.closest('tr').dataset.i];
        var n = usedBy(gone.id);
        var next = state.phases.filter(function (p) { return p !== gone; })[0];
        if (n && !confirm('「' + (gone.label || '名前なし') + '」を使っている作業が' + n + '件あります。' +
                          'それらは「' + (next.label || '名前なし') + '」に変わります。よろしいですか？')) return;
        state.tasks.forEach(function (t) { if (t.phase === gone.id) t.phase = next.id; });
        state.phases = state.phases.filter(function (p) { return p !== gone; });
      } else if (btn.hasAttribute('data-clear-tasks')) {
        if (!state.tasks.length) return;
        if (!confirm('作業を' + state.tasks.length + '件すべて削除します。進捗も消えます。\n' +
                     '（区分は残ります）\n\nよろしいですか？')) return;
        state.tasks = [];
      } else return;

      persist();
      rebuild();
    });

    rebuild();
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
