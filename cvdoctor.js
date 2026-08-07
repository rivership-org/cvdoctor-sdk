/**
 * CVDoctor - CVR最適化SDK（Cookieレス・同意ファースト）
 * バニラJS / ビルド不要 / IIFE / gzip < 20KB 目標
 *
 * 設置スニペット:
 *   <script async src="https://cvdoctor.io/sdk/cvdoctor.js" data-site-id="ORG_ID"></script>
 *
 * グローバルAPI:
 *   window.cvdoctor.init(config)      … 任意の上書き設定
 *   window.cvdoctor.track(event)      … 任意イベント送信 {type:'impression'|'click'|'conversion', ...}
 *   window.cvdoctor.setConsent(bool)  … 外部同意UI連携（data-consent="external"時）
 *   ※ identify は提供しない（PII回避のため）
 *
 * プライバシー方針:
 *   - Cookie不使用（localStorage / メモリのみ）
 *   - 指紋採取しない
 *   - 入力値・氏名・メール全体・電話番号は一切送信/保存しない
 *   - 同意前はイベントをバッファに溜め、analytics同意後にのみ送信
 *
 * ライセンス: MIT (c) 2026 Rivership
 * ソース: https://github.com/ryo-kawafune/cvdoctor-sdk
 *   何を送っていて何を送っていないかは、このコードで検証できます。
 */
(function () {
  "use strict";

  // 二重初期化防止
  if (window.__cvdoctor_initialized) return;
  window.__cvdoctor_initialized = true;

  // ─── 設定読み取り（data属性） ───────────────────────────
  var script =
    document.currentScript ||
    document.querySelector("script[data-site-id]") ||
    document.querySelector("script[data-cvdoctor]");
  if (!script) return;

  var SITE_ID =
    script.getAttribute("data-site-id") || script.getAttribute("data-cvdoctor");
  if (!SITE_ID) return;

  // API_BASE は data-api 優先、無ければ script.src から導出
  var API_BASE =
    script.getAttribute("data-api") ||
    (script.src ? script.src.replace(/\/sdk\/cvdoctor\.js.*$/, "") : "");
  // API_BASE が導出できない（インライン設置等）場合は起動しない。
  // 空のまま進むと相対パスで顧客サイト自身の /api/* に POST して 404 ノイズになる。
  if (!API_BASE) return;

  // 外部同意UI使用フラグ（自前バナーを出さずsetConsent()に委ねる）
  var EXTERNAL_CONSENT =
    script.getAttribute("data-consent") === "external";

  var config = { siteId: SITE_ID, apiBase: API_BASE };

  // ─── ストレージ抽象（localStorage優先・不可時メモリ） ─────
  var memStore = {};
  var lsOk = (function () {
    try {
      var k = "__cvdoctor_t";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  })();
  function storeGet(key) {
    if (lsOk) {
      try { return window.localStorage.getItem(key); } catch (e) {}
    }
    return key in memStore ? memStore[key] : null;
  }
  function storeSet(key, val) {
    if (lsOk) {
      try { window.localStorage.setItem(key, val); return; } catch (e) {}
    }
    memStore[key] = val;
  }

  // ─── Cookieレス visitorId / sessionId ─────────────────────
  function genId() {
    return (
      "c_" +
      Math.random().toString(36).slice(2, 14) +
      Date.now().toString(36)
    );
  }
  var VID_KEY = "cvdoctor_vid";
  var SID_KEY = "cvdoctor_sid";

  // 同意前は visitorId を localStorage に永続化せずメモリのみで保持する
  // （「同意前は端末に識別子を残さない」というプライバシー方針の担保）。
  // 同意成立時に promoteVisitorId() で永続化に昇格する。
  var memVid = null;
  function getVisitorId() {
    var stored = storeGet(VID_KEY);
    if (stored) return stored;
    if (!memVid) memVid = genId();
    // 同意済みなら永続化、それ以外はメモリのまま
    if (hasConsent()) storeSet(VID_KEY, memVid);
    return memVid;
  }
  function promoteVisitorId() {
    if (memVid && !storeGet(VID_KEY)) storeSet(VID_KEY, memVid);
  }
  // sessionId: sessionStorage優先（タブ単位）。不可時はvisitorと同じstoreへ。
  var ssOk = (function () {
    try {
      window.sessionStorage.setItem("__cvdoctor_s", "1");
      window.sessionStorage.removeItem("__cvdoctor_s");
      return true;
    } catch (e) {
      return false;
    }
  })();
  function getSessionId() {
    if (ssOk) {
      try {
        var s = window.sessionStorage.getItem(SID_KEY);
        if (!s) {
          s = genId();
          window.sessionStorage.setItem(SID_KEY, s);
        }
        return s;
      } catch (e) {}
    }
    var id = storeGet(SID_KEY);
    if (!id) {
      id = genId();
      storeSet(SID_KEY, id);
    }
    return id;
  }

  // ─── 同意状態管理 ─────────────────────────────────────────
  var CONSENT_KEY = "cvdoctor_consent"; // "granted" | "denied"
  function consentState() {
    return storeGet(CONSENT_KEY); // null = 未決
  }
  function hasConsent() {
    return consentState() === "granted";
  }

  // 同意前イベントバッファ
  var eventBuffer = [];
  var MAX_BUFFER = 50;

  // ─── 送信ヘルパ（sendBeacon優先・fallback fetch keepalive） ─
  // 全体を try/catch で覆う: JSON.stringify は track() 経由でユーザーが渡した
  // 循環参照 metadata 等で throw しうる。例外を顧客サイトのコードへ絶対に
  // 漏らさない（送信失敗は握りつぶし・リトライもしない）。
  function postBeacon(path, payload) {
    try {
      var url = config.apiBase + path;
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        try {
          var ok = navigator.sendBeacon(
            url,
            new Blob([body], { type: "application/json" })
          );
          if (ok) return;
        } catch (e) {}
      }
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
        mode: "cors",
      }).catch(function () {});
    } catch (e) {}
  }

  // ─── URL 正規化（プライバシー） ───────────────────────────
  // フラグメント(#...)は OAuth implicit の access_token 等の秘匿情報が
  // 乗ることがあるため送信前に必ず除去し、長さも制限する。
  function safeHref() {
    try {
      return String(location.href).split("#")[0].slice(0, 2048);
    } catch (e) {
      return "";
    }
  }

  // ─── イベント送信（impression/click/conversion → /api/sdk/page-events） ─
  // /api/sdk/page-events は eventType を小文字（impression/click/conversion）で受け、
  // PageEvent テーブルへ保存する公開エンドポイント。同意ゲート(enqueueOrSend)
  // 経由でのみ呼ばれる。campaignId は廃止（ページ単位の汎用イベントのため）。
  function normalizeEventType(t) {
    var lc = String(t).toLowerCase();
    if (lc === "impression" || lc === "click" || lc === "conversion") return lc;
    return null;
  }

  // 簡易UA判定（指紋採取ではなく mobile/desktop/tablet の3分類のみ）
  function deviceType() {
    var ua = (navigator.userAgent || "").toLowerCase();
    if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(ua)) {
      return "tablet";
    }
    if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/.test(ua)) {
      return "mobile";
    }
    return "desktop";
  }

  function sendEvent(evt) {
    var etype = normalizeEventType(evt.type);
    if (!etype) return;
    var payload = {
      siteId: config.siteId,
      pageUrl: safeHref(),
      eventType: etype,
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
      referrer: document.referrer || undefined,
      device: deviceType(),
      metadata: Object.assign({ source: "cvdoctor" }, evt.metadata || {}),
    };
    postBeacon("/api/sdk/page-events", payload);
  }

  // 同意ゲート付きの共通入口
  function enqueueOrSend(evt) {
    if (hasConsent()) {
      evt.fn(evt.data);
    } else if (consentState() === "denied") {
      // 拒否時は計測しない
      return;
    } else {
      // 未決: バッファ
      if (eventBuffer.length < MAX_BUFFER) eventBuffer.push(evt);
    }
  }

  function track(evt) {
    if (!evt || !evt.type) return;
    enqueueOrSend({ fn: sendEvent, data: evt });
  }

  // ─── バッファフラッシュ ───────────────────────────────────
  function flushBuffer() {
    if (!hasConsent()) return;
    var items = eventBuffer.splice(0, eventBuffer.length);
    for (var i = 0; i < items.length; i++) {
      try { items[i].fn(items[i].data); } catch (e) {}
    }
  }

  // ─── 同意の確定処理 ───────────────────────────────────────
  function applyConsent(granted) {
    storeSet(CONSENT_KEY, granted ? "granted" : "denied");
    if (granted) {
      // メモリ保持していた visitorId を永続化に昇格
      promoteVisitorId();
      // サーバへ同意記録 → 受理後にバッファをフラッシュ
      postBeacon("/api/consent", {
        siteId: config.siteId,
        visitorId: getVisitorId(),
        analytics: true,
      });
      flushBuffer();
      // 同意前に保留していた A/B バリアントの取得・適用をここで実行
      applyVariants();
    } else {
      // 拒否: 拒否の事実のみサーバへ記録（イベント計測はしない）。
      // 検証CVRの「非同意依存の分母」（同意判断者数 = granted + denied）に使う。
      // visitorId はメモリ保持のランダムIDのまま永続化せず、イベントとも紐付かない。
      postBeacon("/api/consent", {
        siteId: config.siteId,
        visitorId: getVisitorId(),
        analytics: false,
      });
      // バッファ破棄・以後計測停止
      eventBuffer.length = 0;
    }
  }

  // ─── 同意バナー（自前・下部バー） ─────────────────────────
  function showConsentBanner() {
    if (document.getElementById("cvdoctor-consent-bar")) return;
    var bar = document.createElement("div");
    bar.id = "cvdoctor-consent-bar";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-live", "polite");
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483645;" +
      "background:#1f2937;color:#f9fafb;padding:14px 18px;" +
      "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;" +
      "display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;" +
      "box-shadow:0 -2px 12px rgba(0,0,0,0.2);";

    var msg = document.createElement("span");
    msg.textContent = "サイト改善のための計測に同意しますか？";
    msg.style.cssText = "line-height:1.5;";
    bar.appendChild(msg);

    var btnWrap = document.createElement("span");
    btnWrap.style.cssText = "display:inline-flex;gap:8px;";

    var agree = document.createElement("button");
    agree.textContent = "同意する";
    agree.style.cssText =
      "padding:8px 18px;border:none;border-radius:6px;cursor:pointer;" +
      "background:#2563eb;color:#fff;font-size:14px;font-weight:600;";
    agree.onclick = function () {
      applyConsent(true);
      removeBanner();
    };

    var deny = document.createElement("button");
    deny.textContent = "拒否";
    deny.style.cssText =
      "padding:8px 18px;border:1px solid #6b7280;border-radius:6px;cursor:pointer;" +
      "background:transparent;color:#f9fafb;font-size:14px;";
    deny.onclick = function () {
      applyConsent(false);
      removeBanner();
    };

    btnWrap.appendChild(agree);
    btnWrap.appendChild(deny);
    bar.appendChild(btnWrap);

    function removeBanner() {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }

    (document.body || document.documentElement).appendChild(bar);
  }

  function initConsent() {
    var st = consentState();
    if (st === "granted") {
      // 既に同意済み: 何もせず（送信は都度実行）
      return;
    }
    if (st === "denied") {
      return; // 拒否済み: 計測しない
    }
    // 未決
    if (EXTERNAL_CONSENT) {
      return; // 外部UIに委ねる（setConsentを待つ）
    }
    showConsentBanner();
  }

  // ─── A/B variant 適用（FOUC回避のため早期実行） ───────────
  // /api/sdk/site-tests から稼働中SiteTestを取得し、visitorId基準で安定割当。
  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  function pickVariant(test) {
    var variants = test.variants || [];
    if (variants.length === 0) return null;
    // 既存割当があれば維持（安定性）
    var key = "cvdoctor_st_" + test.id;
    var storedId = storeGet(key);
    if (storedId) {
      for (var i = 0; i < variants.length; i++) {
        if (variants[i].id === storedId) return variants[i];
      }
    }
    // visitorId + testId ハッシュで重み付き安定割当
    var total = 0;
    for (var j = 0; j < variants.length; j++) {
      total += variants[j].trafficPercent || 0;
    }
    // 全 variant の trafficPercent が未設定/0 のときだけ均等割り当てにする。
    var useEqual = total <= 0;
    if (useEqual) total = variants.length;
    var bucket = hashStr(getVisitorId() + ":" + test.id) % total;
    var cum = 0;
    var chosen = variants[0];
    for (var k = 0; k < variants.length; k++) {
      // 均等モード時は各 1、通常時は実 trafficPercent（0 は 0 のまま加算しない）。
      // これにより trafficPercent=0（配信停止）の variant には割り当てが飛ばない。
      cum += useEqual ? 1 : variants[k].trafficPercent || 0;
      if (bucket < cum) {
        chosen = variants[k];
        break;
      }
    }
    storeSet(key, chosen.id);
    return chosen;
  }

  function applyChange(change) {
    if (!change || !change.selector) return;
    var nodes;
    try {
      nodes = document.querySelectorAll(change.selector);
    } catch (e) {
      return; // 不正セレクタは無視
    }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // 安全な変更タイプのみ処理（text / attribute / style）。
      // html / image / hide は XSS リスクのため非対応。サーバ側 sanitizeChanges
      // に加え、クライアント側でも検証してXSSを二重に防ぐ（defense in depth）。
      // ノード単位で try/catch: 不正な属性名（空白等）による
      // setAttribute の InvalidCharacterError などが後続の変更適用や
      // 呼び出し元を巻き込まないようにする。
      try {
        switch (change.type) {
          case "text":
            el.textContent = change.value;
            break;
          case "attribute":
            if (change.property && attrChangeIsSafe(change.property, change.value)) {
              el.setAttribute(change.property, change.value);
            }
            break;
          case "style":
            if (change.property && !hasCssDanger(String(change.value))) {
              el.style[change.property] = change.value;
            }
            break;
        }
      } catch (e) {}
    }
  }

  // attribute 変更が安全か検証する。イベントハンドラ属性・srcdoc・
  // javascript:/data: スキーム・style属性のurl()注入を拒否する。
  function attrChangeIsSafe(name, value) {
    var n = String(name).toLowerCase().replace(/[\x00-\x20]/g, "");
    if (n.indexOf("on") === 0) return false; // onclick 等のイベントハンドラ
    if (n === "srcdoc") return false; // iframe srcdoc での任意HTML
    if (n === "style") return !hasCssDanger(String(value));
    if (n === "href" || n === "src" || n === "xlink:href" || n === "formaction" || n === "action") {
      // 制御文字・空白を除去してからスキーム判定（java\tscript: 等の分割回避）
      var v = String(value).replace(/[\x00-\x20]/g, "").toLowerCase();
      if (/^(javascript|data|vbscript):/.test(v)) return false;
    }
    // 属性名 allowlist に依存しない全値スキャン（poster/srcset 等の
    // URL系属性の取りこぼし対策。サーバ側 valueHasDanger のミラー）。
    var all = String(value).replace(/[\x00-\x20]/g, "").toLowerCase();
    if (all.indexOf("javascript:") !== -1 || all.indexOf("vbscript:") !== -1) return false;
    return true;
  }

  function hasCssDanger(v) {
    var s = v.replace(/[\x00-\x20]/g, "").toLowerCase();
    return s.indexOf("url(") !== -1 || s.indexOf("expression(") !== -1 || s.indexOf("javascript:") !== -1;
  }

  var variantsApplied = false;
  function applyVariants() {
    // 同意ファースト: 同意が granted になるまで A/B の取得・適用・識別子永続化を
    // 行わない（未決・denied では 1 リクエストも送らない）。granted 化時に
    // applyConsent から再呼び出しされる。
    if (!hasConsent()) return;
    if (variantsApplied) return;
    variantsApplied = true;
    var url =
      config.apiBase +
      "/api/sdk/site-tests?siteId=" +
      encodeURIComponent(config.siteId) +
      "&url=" +
      encodeURIComponent(safeHref());
    // fetch 自体の同期 throw（fetch 未定義の旧環境等）も封じる。
    // 非同期エラー・非200（429含む）は .catch / Array.isArray ガードで
    // 静かに握りつぶし、リトライはしない。
    try {
    fetch(url, { mode: "cors" })
      .then(function (r) { return r.json(); })
      .then(function (tests) {
        if (!Array.isArray(tests)) return;
        tests.forEach(function (test) {
          var variant = pickVariant(test);
          if (!variant) return;
          var changes = variant.changes || [];
          for (var i = 0; i < changes.length; i++) applyChange(changes[i]);
          // 表示記録（同意ゲートを通す）
          track({
            type: "impression",
            metadata: { siteTestId: test.id, variantId: variant.id },
          });
          // SiteTest集計（views）。同意必須ではない集計だが、計測なので同意に従う。
          if (hasConsent()) {
            postBeacon("/api/sdk/site-test-events", {
              testId: test.id,
              variantId: variant.id,
              type: "view",
            });
          }
        });
      })
      .catch(function () {});
    } catch (e) {}
  }

  // ─── フォーム解析（reached / abandoned。値は送らない） ─────
  var FREE_EMAIL_DOMAINS = {
    "gmail.com": 1,
    "yahoo.com": 1,
    "yahoo.co.jp": 1,
    "ymail.com": 1,
    "outlook.com": 1,
    "outlook.jp": 1,
    "hotmail.com": 1,
    "hotmail.co.jp": 1,
    "live.com": 1,
    "icloud.com": 1,
    "me.com": 1,
    "aol.com": 1,
    "proton.me": 1,
    "protonmail.com": 1,
    "ezweb.ne.jp": 1,
    "docomo.ne.jp": 1,
    "softbank.ne.jp": 1,
    "i.softbank.jp": 1,
  };

  function normalizeFieldName(field, index) {
    var n = field.getAttribute("name") || field.id || "";
    if (!n) n = "field_" + index;
    // 正規化: 英数とアンダースコアのみ・小文字化
    return String(n).toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 64);
  }

  function formIdOf(form, index) {
    var fid = form.id || form.getAttribute("name") || "";
    if (!fid) fid = "form_" + index;
    return String(fid).slice(0, 64);
  }

  // メールドメイン種別判定（ドメイン部のみ参照・ローカルパート破棄）
  function emailDomainType(value) {
    if (!value || value.indexOf("@") === -1) return "unknown";
    var domain = value.split("@").pop();
    if (!domain) return "unknown";
    domain = domain.trim().toLowerCase();
    if (!domain || domain.indexOf(".") === -1) return "unknown";
    return FREE_EMAIL_DOMAINS[domain] ? "free" : "corporate";
  }

  function isCompanyField(field) {
    var n = (
      (field.getAttribute("name") || "") +
      " " +
      (field.id || "") +
      " " +
      (field.getAttribute("placeholder") || "") +
      " " +
      (field.getAttribute("autocomplete") || "")
    ).toLowerCase();
    return /company|organization|organisation|corp|会社|法人|企業|団体/.test(n);
  }

  function isEmailField(field) {
    var t = (field.getAttribute("type") || "").toLowerCase();
    if (t === "email") return true;
    var n = (
      (field.getAttribute("name") || "") +
      " " +
      (field.id || "") +
      " " +
      (field.getAttribute("autocomplete") || "")
    ).toLowerCase();
    return /e-?mail|メール/.test(n);
  }

  function sendFormStep(form, field, fieldName, reached, abandoned) {
    // /api/forms（FormStepEvent形状）。入力値は一切含めない。
    var payload = {
      siteId: config.siteId,
      pageUrl: safeHref(),
      formId: form.__cvdoctor_formId,
      fieldName: fieldName,
      step: field.__cvdoctor_step,
      reached: !!reached,
      abandoned: !!abandoned,
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
    };
    postBeacon("/api/forms", payload);
  }

  function setupForm(form, formIndex) {
    form.__cvdoctor_formId = formIdOf(form, formIndex);
    form.__cvdoctor_submitted = false;
    form.__cvdoctor_firstFocusAt = 0;

    var fields = form.querySelectorAll("input, textarea, select");
    var trackable = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var type = (f.getAttribute("type") || "").toLowerCase();
      // 非入力系は除外
      if (type === "hidden" || type === "submit" || type === "button" || type === "reset") {
        continue;
      }
      f.__cvdoctor_step = trackable.length;
      f.__cvdoctor_fieldName = normalizeFieldName(f, trackable.length);
      f.__cvdoctor_reached = false;
      f.__cvdoctor_touched = false; // focusされたか
      f.__cvdoctor_filled = false; // 値が入ったか
      trackable.push(f);
      bindField(form, f);
    }
    form.__cvdoctor_fields = trackable;

    form.addEventListener("submit", function () {
      form.__cvdoctor_submitted = true;
      sendLeadSignals(form);
    });
  }

  function bindField(form, field) {
    field.addEventListener(
      "focus",
      function () {
        if (!form.__cvdoctor_firstFocusAt) form.__cvdoctor_firstFocusAt = Date.now();
        field.__cvdoctor_touched = true;
        if (!field.__cvdoctor_reached) {
          field.__cvdoctor_reached = true;
          // 到達（同意ゲート対象だが /api/forms は計測なので同意に従う）
          if (hasConsent()) {
            sendFormStep(form, field, field.__cvdoctor_fieldName, true, false);
          }
        }
      },
      true
    );
    field.addEventListener(
      "input",
      function () {
        // 値そのものは見ず、空かどうかだけ判定
        var hasVal =
          field.type === "checkbox" || field.type === "radio"
            ? field.checked
            : !!(field.value && String(field.value).length > 0);
        field.__cvdoctor_filled = hasVal;
      },
      true
    );
    field.addEventListener(
      "blur",
      function () {
        // 離脱(abandoned): focusしたが未入力 かつ フォーム未送信
        if (
          field.__cvdoctor_touched &&
          !field.__cvdoctor_filled &&
          !form.__cvdoctor_submitted
        ) {
          if (hasConsent()) {
            sendFormStep(form, field, field.__cvdoctor_fieldName, true, true);
          }
        }
      },
      true
    );
  }

  // ─── リード品質シグナル（PII非送信） → /api/leads ─────────
  function sendLeadSignals(form) {
    if (!hasConsent()) return;
    var fields = form.__cvdoctor_fields || [];
    var filledFields = 0;
    var domainType = "unknown";
    var hasCompany = false;

    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var hasVal =
        f.type === "checkbox" || f.type === "radio"
          ? f.checked
          : !!(f.value && String(f.value).length > 0);
      if (hasVal) filledFields++;
      if (isCompanyField(f)) hasCompany = true;
      if (isEmailField(f) && hasVal && domainType === "unknown") {
        // ドメイン部のみ判定。ローカルパートは破棄され送信しない。
        domainType = emailDomainType(String(f.value));
      }
    }

    var interactionMs = form.__cvdoctor_firstFocusAt
      ? Math.max(0, Date.now() - form.__cvdoctor_firstFocusAt)
      : 0;

    // PII（氏名/メール全体/電話）は一切含めない。集計済み非PIIのみ。
    var payload = {
      siteId: config.siteId,
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
      signals: {
        filledFields: filledFields,
        emailDomainType: domainType,
        hasCompanyField: hasCompany,
        interactionMs: interactionMs,
      },
    };
    postBeacon("/api/leads", payload);

    // フォーム送信=コンバージョン扱いで計測（同意ゲート経由）
    track({ type: "conversion", metadata: { formId: form.__cvdoctor_formId } });
  }

  function setupForms() {
    var forms = document.querySelectorAll("form");
    for (var i = 0; i < forms.length; i++) {
      if (forms[i].__cvdoctor_bound) continue;
      forms[i].__cvdoctor_bound = true;
      setupForm(forms[i], i);
    }
  }

  // ─── グローバルAPI ────────────────────────────────────────
  // 公開APIは顧客サイトのコードから直接呼ばれるため、いかなる引数・状態でも
  // 例外を呼び出し元へ漏らさない（顧客サイトのJSを壊さない）。
  window.cvdoctor = {
    init: function (cfg) {
      try {
        if (cfg && typeof cfg === "object") {
          if (cfg.siteId) config.siteId = cfg.siteId;
          if (cfg.apiBase) config.apiBase = cfg.apiBase;
        }
      } catch (e) {}
    },
    track: function (evt) {
      try { track(evt); } catch (e) {}
    },
    setConsent: function (granted) {
      try { applyConsent(!!granted); } catch (e) {}
    },
  };

  // ─── 起動 ─────────────────────────────────────────────────
  // variant適用はFOUC回避のため可能な限り早期に実行。
  // 起動系は全て try/catch: 途中で throw しても顧客サイトのコンソールを
  // エラーで汚さず、SDK 内で完結させる。
  try { applyVariants(); } catch (e) {}
  try { initConsent(); } catch (e) {}

  // SPA 対応: 動的に追加されるフォームを監視して計測をバインドする。
  function observeForms() {
    if (!window.MutationObserver) return;
    // DOM変異は連発するため debounce（200ms）でフォーム再スキャンをまとめる。
    var pending = null;
    var obs = new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () {
        pending = null;
        try { setupForms(); } catch (e) {}
      }, 200);
    });
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  // SPA 対応: pushState/replaceState/popstate でページ遷移を検知し、
  // 遷移ごとにページビュー impression とフォーム再スキャンを行う。
  var lastPath = location.pathname + location.search;
  function onRouteChange() {
    try {
      var cur = location.pathname + location.search;
      if (cur === lastPath) return;
      lastPath = cur;
      setupForms();
      track({ type: "impression", metadata: { source: "cvdoctor", view: "page" } });
    } catch (e) {}
  }
  function hookHistory() {
    try {
      var wrap = function (name) {
        var orig = history[name];
        if (typeof orig !== "function") return;
        history[name] = function () {
          var r = orig.apply(this, arguments);
          try { onRouteChange(); } catch (e) {}
          return r;
        };
      };
      wrap("pushState");
      wrap("replaceState");
      window.addEventListener("popstate", onRouteChange);
    } catch (e) {}
  }

  function onReady() {
    try {
      setupForms();
      observeForms();
      hookHistory();
      // ページ表示 impression を1回送る（同意ゲート経由。未同意ならバッファ）。
      track({ type: "impression", metadata: { source: "cvdoctor", view: "page" } });
      // 既存同意済みなら溜まったバッファをフラッシュ
      if (hasConsent()) flushBuffer();
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})();
