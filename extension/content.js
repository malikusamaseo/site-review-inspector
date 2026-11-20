// Site Review Inspector — content script (runs on web pages).
// Draws the floating review button, the inspect overlay, the hover/selected highlights,
// the comment panel and the numbered pins for existing comments. All UI lives in a closed
// shadow root so the website's CSS can't touch it and ours can't leak into the page.
(() => {
  if (window.__siteReviewInspector) return;
  window.__siteReviewInspector = true;

  /* ----------------------------------------------------------------- messaging */
  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: 'No response' });
      });
    } catch {
      resolve({ ok: false, error: 'The extension was updated. Reload this page to keep reviewing.' });
    }
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ----------------------------------------------------------------- state */
  let auth = { loggedIn: false, user: null, enabled: true };
  let active = false;            // review mode on/off
  let hoverEl = null;
  let selectedEl = null;
  let pins = [];                 // [{ comment, el }]
  let openPinId = null;
  let lastHref = location.href;
  let loopId = 0;
  let submitting = false;

  /* ----------------------------------------------------------------- UI */
  const ICON = {
    target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  };
  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui { font: 13.5px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #17181c; -webkit-font-smoothing: antialiased; }
    .hidden { display: none !important; }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    button { font: inherit; color: inherit; cursor: pointer; }

    .tint { position: fixed; inset: 0; background: rgba(250, 196, 0, .10); pointer-events: none; }
    .box { position: fixed; left: 0; top: 0; pointer-events: none; border-radius: 3px; transition: transform .05s linear, width .05s linear, height .05s linear; }
    .box.hover { border: 2px dashed #f5b400; background: rgba(255, 204, 0, .10); }
    .box.selected { border: 2px solid #f5b400; background: rgba(255, 204, 0, .16); box-shadow: 0 0 0 4px rgba(245, 180, 0, .18); }
    .tag { position: absolute; left: -2px; bottom: calc(100% + 4px); background: #17181c; color: #ffd24d; font: 600 11.5px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      padding: 5px 7px; border-radius: 5px; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .tag b { color: #fff; font-weight: 600; }
    .tag i { color: #a9acb5; font-style: normal; margin-left: 6px; }
    .tag.inside { bottom: auto; top: 4px; left: 4px; }

    .banner { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); background: #ffc400; color: #241a00; font-weight: 600; padding: 9px 18px;
      border-radius: 99px; box-shadow: 0 6px 24px rgba(0, 0, 0, .22); white-space: nowrap; pointer-events: none; }
    kbd { font: 600 11px ui-monospace, Menlo, monospace; background: rgba(0, 0, 0, .1); border-radius: 4px; padding: 1px 5px; margin: 0 2px; }

    .launcher { position: fixed; left: 18px; bottom: 18px; width: 58px; height: 58px; border-radius: 50%; border: 3px solid #f5b400; background: #fff;
      display: grid; place-items: center; box-shadow: 0 6px 20px rgba(0, 0, 0, .28); padding: 0; transition: transform .15s; }
    .launcher:hover { transform: scale(1.06); }
    .launcher img { width: 32px; height: 32px; display: block; }
    .launcher svg { width: 22px; height: 22px; color: #ffc400; stroke-width: 2.6; }
    .launcher.on { background: #17181c; }
    .badge { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 99px; background: #d64040; color: #fff;
      font: 700 11px/20px system-ui, sans-serif; text-align: center; border: 2px solid #fff; }

    .panel { position: fixed; left: 18px; bottom: 90px; width: 350px; max-width: calc(100vw - 36px); max-height: calc(100vh - 110px); overflow-y: auto;
      background: #fff; border-radius: 16px; box-shadow: 0 18px 50px rgba(0, 0, 0, .32), 0 0 0 1px rgba(0, 0, 0, .04); padding: 18px 18px 16px; }
    .p-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
    .eyebrow { color: #e0820b; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    .p-title { font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
    .x { border: 0; background: none; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: #4a4d55; margin: -2px -6px 0 0; }
    .x:hover { background: #f1efe9; }
    .chip { display: flex; align-items: center; gap: 10px; background: #fff8e1; border: 1px solid #f3dd94; border-radius: 10px; padding: 9px 10px; }
    .chip > svg { color: #e0820b; }
    .chip-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .chip-sel { font: 600 12px ui-monospace, Menlo, Consolas, monospace; color: #17181c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip-sub { font-size: 11.5px; color: #6b6e76; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .linkbtn { border: 0; background: none; color: #c2410c; font-weight: 600; font-size: 12.5px; padding: 4px; border-radius: 6px; flex: none; }
    .linkbtn:hover { background: rgba(194, 65, 12, .08); }
    .tools { display: flex; gap: 6px; margin: 8px 0 14px; }
    .mini { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #e6e4dd; background: #fff; border-radius: 7px; padding: 4px 8px; font-size: 12px; font-weight: 550; color: #4a4d55; }
    .mini:hover { background: #f7f6f2; }
    .mini svg { width: 13px; height: 13px; }
    .mini.open svg { transform: rotate(180deg); }
    .details { border: 1px solid #ecebe5; border-radius: 10px; margin: -6px 0 14px; overflow: hidden; font-size: 12px; }
    .details div { display: grid; grid-template-columns: 82px 1fr; border-bottom: 1px solid #f1efe9; }
    .details div:last-child { border-bottom: 0; }
    .details span { padding: 6px 9px; overflow-wrap: anywhere; min-width: 0; }
    .details span:first-child { color: #868a94; background: #fbfaf7; }
    .details code { font: 11.5px ui-monospace, Menlo, Consolas, monospace; }
    .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; border: 1px solid rgba(0, 0, 0, .2); vertical-align: -1px; margin-right: 5px; }
    label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 12px; }
    input, textarea { display: block; width: 100%; margin-top: 6px; border: 1px solid #e0ded6; border-radius: 10px; padding: 10px 12px; font: inherit; font-weight: 400;
      color: #17181c; background: #f7f6f2; outline: none; }
    textarea { min-height: 96px; resize: vertical; }
    input:focus, textarea:focus { border-color: #f5b400; background: #fff; box-shadow: 0 0 0 3px rgba(245, 180, 0, .22); }
    .err { color: #d64040; font-size: 12.5px; margin: -4px 0 10px; }
    .err:empty { display: none; }
    .p-foot { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
    .cancel { border: 0; background: none; padding: 10px 14px; border-radius: 99px; font-weight: 550; color: #4a4d55; }
    .cancel:hover { background: #f1efe9; }
    .submit { display: inline-flex; align-items: center; gap: 8px; border: 0; background: #17181c; color: #fff; padding: 11px 18px; border-radius: 99px; font-weight: 600; }
    .submit:hover { background: #2c2e35; }
    .submit:disabled { opacity: .6; cursor: default; }
    .who { font-size: 11.5px; color: #868a94; margin-top: 10px; text-align: left; }

    .pin { position: fixed; left: 0; top: 0; width: 26px; height: 26px; border-radius: 50% 50% 50% 4px; background: #ffc400; color: #241a00; border: 2px solid #fff;
      font: 700 11.5px/22px system-ui, sans-serif; text-align: center; box-shadow: 0 3px 10px rgba(0, 0, 0, .3); padding: 0; }
    .pin.mine { background: #17181c; color: #ffc400; }
    .pin:hover { transform: scale(1.12); }
    .pop { position: fixed; width: 280px; background: #fff; border-radius: 12px; padding: 12px 14px; box-shadow: 0 14px 40px rgba(0, 0, 0, .28); }
    .pop-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #868a94; margin-bottom: 6px; }
    .pop-head b { color: #17181c; }
    .pop p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; }

    .toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); background: #17181c; color: #fff; padding: 10px 16px; border-radius: 10px;
      font-weight: 550; box-shadow: 0 8px 26px rgba(0, 0, 0, .3); max-width: calc(100vw - 40px); }
    .toast.bad { background: #d64040; }
  `;

  let host, root, ui;
  function build() {
    host = document.createElement('site-review-inspector');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;display:block;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${STYLES}</style>
      <div class="ui">
        <div class="tint hidden"></div>
        <div class="pins hidden"></div>
        <div class="box hover hidden"><span class="tag"></span></div>
        <div class="box selected hidden"></div>
        <div class="banner hidden">Click any element to comment · <kbd>Esc</kbd> to cancel</div>
        <div class="pop hidden"></div>
        <form class="panel hidden" novalidate>
          <div class="p-head"><div><div class="eyebrow">Review mode</div><div class="p-title">Add a comment</div></div>
            <button type="button" class="x" data-act="close" title="Close">${ICON.close}</button></div>
          <div class="chip">${ICON.target}<div class="chip-text"><span class="chip-sel"></span><span class="chip-sub"></span></div>
            <button type="button" class="linkbtn" data-act="reselect">Reselect</button></div>
          <div class="tools">
            <button type="button" class="mini" data-act="parent">${ICON.up}Parent element</button>
            <button type="button" class="mini" data-act="details">Element details ${ICON.chevron}</button>
          </div>
          <div class="details hidden"></div>
          <label>Name<input class="f-name" maxlength="100" placeholder="Your name" autocomplete="name"></label>
          <label>Description<textarea class="f-desc" maxlength="5000" placeholder="What should change here?"></textarea></label>
          <div class="err"></div>
          <div class="p-foot"><button type="button" class="cancel" data-act="close">Cancel</button>
            <button type="submit" class="submit">Submit comment ${ICON.send}</button></div>
          <div class="who"></div>
        </form>
        <button class="launcher hidden" title="Review mode"><img alt="" src="${chrome.runtime.getURL('icons/icon48.png')}"><span class="badge hidden"></span></button>
        <div class="toast hidden"></div>
      </div>`;
    const q = (s) => root.querySelector(s);
    ui = {
      tint: q('.tint'), pins: q('.pins'), hover: q('.box.hover'), tag: q('.tag'), selected: q('.box.selected'), banner: q('.banner'),
      pop: q('.pop'), panel: q('.panel'), chipSel: q('.chip-sel'), chipSub: q('.chip-sub'), details: q('.details'), detailsBtn: q('[data-act=details]'),
      name: q('.f-name'), desc: q('.f-desc'), err: q('.err'), submit: q('.submit'), who: q('.who'), launcher: q('.launcher'), badge: q('.badge'), toast: q('.toast'),
    };

    ui.launcher.addEventListener('click', () => (active ? stop() : start()));
    ui.panel.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    ui.panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') deselect();
      if (act === 'reselect') { deselect(); showToast('Click another element to select it'); }
      if (act === 'parent' && selectedEl && selectedEl.parentElement && selectedEl.parentElement !== document.documentElement) select(selectedEl.parentElement, true);
      if (act === 'details') { ui.details.classList.toggle('hidden'); b.classList.toggle('open', !ui.details.classList.contains('hidden')); }
    });
    // Keep the website's own keyboard shortcuts from firing while typing in our fields.
    for (const t of ['keydown', 'keyup', 'keypress']) ui.panel.addEventListener(t, (e) => {
      e.stopPropagation();
      if (t === 'keydown' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      if (t === 'keydown' && e.key === 'Escape') { e.preventDefault(); deselect(); }
    });
    ui.pins.addEventListener('click', (e) => { const p = e.target.closest('.pin'); if (p) togglePop(p.dataset.id); });

    mount();
    // Re-attach if the website wipes the DOM (some single-page apps do).
    new MutationObserver(() => { if (!host.isConnected) mount(); }).observe(document.documentElement, { childList: true });
  }
  function mount() { (document.documentElement || document.body).appendChild(host); }

  let toastTimer;
  function showToast(msg, bad) {
    ui.toast.textContent = msg; ui.toast.classList.toggle('bad', !!bad); ui.toast.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), bad ? 4200 : 2600);
  }

  function updateLauncher() {
    let onDashboard = false;
    try { onDashboard = !!auth.server && new URL(auth.server).origin === location.origin; } catch {}
    const show = auth.loggedIn && (auth.enabled || active) && !onDashboard;
    ui.launcher.classList.toggle('hidden', !show);
    ui.launcher.classList.toggle('on', active);
    ui.launcher.title = active ? 'Exit review mode (Esc)' : 'Review mode — click to inspect this page';
    const img = ui.launcher.querySelector('img');
    const x = ui.launcher.querySelector('svg');
    img.classList.toggle('hidden', active);
    if (active && !x) ui.launcher.insertAdjacentHTML('afterbegin', ICON.close);
    if (!active && x) x.remove();
    const open = pins.filter((p) => p.comment.status === 'open').length;
    ui.badge.textContent = open; ui.badge.classList.toggle('hidden', !open || active);
  }

  /* ----------------------------------------------------------------- element info */
  const autoLike = (s) => /\d{4,}|[0-9a-f]{8,}|^(css|sc|jsx|emotion|svelte|ng|v|data-v)-/i.test(s);
  const okClass = (c) => c && c.length < 40 && !autoLike(c) && !/[:\[\]\/@!%]/.test(c);
  function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } }
  function cssPath(el) {
    if (el.id && !autoLike(el.id) && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur !== el && cur.id && !autoLike(cur.id) && unique('#' + CSS.escape(cur.id))) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      let part = cur.tagName.toLowerCase();
      if (part.includes(':')) part = '*'; // namespaced SVG tags
      const cls = [...cur.classList].filter(okClass).slice(0, 2);
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((s) => s.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  }
  function xPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}[${i}]`);
    }
    return '/' + parts.join('/');
  }
  function shortLabel(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else { const c = [...el.classList].filter(okClass)[0]; if (c) s += '.' + c; }
    return s;
  }
  function textOf(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function describe(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const attributes = {};
    for (const a of ['href', 'src', 'alt', 'title', 'type', 'name', 'role', 'aria-label', 'placeholder']) {
      if (el.hasAttribute(a)) attributes[a] = el.getAttribute(a).slice(0, 300);
    }
    let html = el.outerHTML || '';
    if (html.length > 2000) html = html.slice(0, 2000) + '…';
    return {
      selector: cssPath(el), xpath: xPath(el), tag: el.tagName.toLowerCase(), id: el.id || '',
      classes: [...el.classList], text: textOf(el).slice(0, 500), html, attributes,
      styles: {
        fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color,
        backgroundColor: cs.backgroundColor, margin: cs.margin, padding: cs.padding, display: cs.display, textAlign: cs.textAlign, borderRadius: cs.borderRadius,
      },
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    };
  }

  /* ----------------------------------------------------------------- highlight boxes */
  function place(box, el) {
    const r = el.getBoundingClientRect();
    box.style.transform = `translate(${r.left - 2}px, ${r.top - 2}px)`;
    box.style.width = `${r.width + 4}px`;
    box.style.height = `${r.height + 4}px`;
    return r;
  }
  function setHover(el) {
    hoverEl = el;
    if (!el || el === selectedEl) { ui.hover.classList.add('hidden'); return; }
    ui.hover.classList.remove('hidden');
    const r = place(ui.hover, el);
    ui.tag.innerHTML = `<b>${esc(shortLabel(el))}</b><i>${Math.round(r.width)} × ${Math.round(r.height)}</i>`;
    ui.tag.classList.toggle('inside', r.top < 30);
  }
  function loop() {
    if (!active) return;
    if (selectedEl) { if (selectedEl.isConnected) place(ui.selected, selectedEl); else deselect(); }
    if (hoverEl && hoverEl.isConnected && hoverEl !== selectedEl) place(ui.hover, hoverEl);
    positionPins();
    if (location.href !== lastHref) { lastHref = location.href; deselect(); loadPins(); }
    loopId = requestAnimationFrame(loop);
  }

  /* ----------------------------------------------------------------- inspect events */
  const isOurs = (e) => e.composedPath().includes(host);
  function targetOf(e) {
    let t = e.target;
    if (t && t.nodeType !== 1) t = t.parentElement;
    if (!t || t === document.documentElement || t === host) return null;
    return t;
  }
  function onMove(e) { if (isOurs(e)) { setHover(null); return; } setHover(targetOf(e)); }
  function block(e) { if (isOurs(e)) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  function onClick(e) {
    if (isOurs(e)) { if (!e.composedPath().includes(ui.pop) && !e.composedPath().some((n) => n.classList && n.classList.contains('pin'))) closePop(); return; }
    block(e);
    closePop();
    const t = targetOf(e);
    if (t) select(t);
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (isOurs(e)) return; // handled inside the panel
    e.preventDefault(); e.stopPropagation();
    if (openPinId) closePop(); else if (selectedEl) deselect(); else stop();
  }
  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'touchstart', 'touchend'];

  let cursorStyle;
  function start() {
    if (!auth.loggedIn) { showToast('Sign in from the Site Review extension icon first.', true); return; }
    if (active) return;
    active = true;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    for (const t of BLOCKED) document.addEventListener(t, block, { capture: true, passive: false });
    cursorStyle = document.createElement('style');
    cursorStyle.textContent = 'html, html * { cursor: crosshair !important; }';
    (document.head || document.documentElement).appendChild(cursorStyle);
    ui.tint.classList.remove('hidden');
    ui.banner.classList.remove('hidden');
    ui.pins.classList.remove('hidden');
    updateLauncher();
    loadPins();
    loopId = requestAnimationFrame(loop);
  }
  function stop() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(loopId);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    for (const t of BLOCKED) document.removeEventListener(t, block, { capture: true });
    if (cursorStyle) cursorStyle.remove();
    deselect();
    setHover(null);
    closePop();
    ui.tint.classList.add('hidden');
    ui.banner.classList.add('hidden');
    ui.pins.classList.add('hidden');
    updateLauncher();
  }

  /* ----------------------------------------------------------------- selection + panel */
  function colorSw(v) { return `<span class="sw" style="background:${esc(v)}"></span>${esc(v)}`; }
  async function select(el, keepText) {
    selectedEl = el;
    setHover(null);
    ui.selected.classList.remove('hidden');
    place(ui.selected, el);
    ui.banner.classList.add('hidden');
    const info = describe(el);
    const text = info.text;
    ui.chipSel.textContent = info.selector;
    ui.chipSel.title = info.selector;
    ui.chipSub.textContent = `<${info.tag}>${text ? ` "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"` : ''}`;
    const s = info.styles;
    const rows = [
      ['Tag', `<code>&lt;${esc(info.tag)}&gt;</code>`],
      ['ID', info.id ? `<code>#${esc(info.id)}</code>` : '—'],
      ['Classes', info.classes.length ? info.classes.map((c) => `<code>.${esc(c)}</code>`).join(' ') : '—'],
      ['Size', `${Math.round(info.rect.width)} × ${Math.round(info.rect.height)} px`],
      ['Font', `${esc(s.fontFamily.split(',')[0].replace(/["']/g, ''))} · ${esc(s.fontSize)} · ${esc(s.fontWeight)}`],
      ['Color', colorSw(s.color)],
      ['Background', colorSw(s.backgroundColor)],
      ['Selector', `<code>${esc(info.selector)}</code>`],
    ];
    ui.details.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');
    ui.err.textContent = '';
    const wasHidden = ui.panel.classList.contains('hidden');
    ui.panel.classList.remove('hidden');
    if (!ui.name.value) {
      const saved = await chrome.storage.local.get('reviewerName').catch(() => ({}));
      ui.name.value = saved.reviewerName || (auth.user && auth.user.name) || '';
    }
    ui.who.textContent = auth.user ? `Signed in as ${auth.user.email}` : '';
    if (wasHidden || !keepText) (ui.name.value ? ui.desc : ui.name).focus({ preventScroll: true });
  }
  function deselect() {
    selectedEl = null;
    ui.selected.classList.add('hidden');
    ui.panel.classList.add('hidden');
    ui.err.textContent = '';
    if (active) ui.banner.classList.remove('hidden');
  }

  async function submit() {
    if (submitting || !selectedEl) return;
    const authorName = ui.name.value.trim();
    const description = ui.desc.value.trim();
    if (!authorName) { ui.err.textContent = 'Please enter your name.'; ui.name.focus(); return; }
    if (!description) { ui.err.textContent = 'Please describe what should change.'; ui.desc.focus(); return; }
    submitting = true;
    ui.err.textContent = '';
    ui.submit.disabled = true;
    ui.submit.firstChild.textContent = 'Submitting… ';
    chrome.storage.local.set({ reviewerName: authorName }).catch(() => {});

    const el = selectedEl;
    const r0 = el.getBoundingClientRect();
    if (r0.bottom < 0 || r0.top > innerHeight || r0.right < 0 || r0.left > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      await wait(350);
    }
    // Hide our UI so the screenshot shows the page exactly as the reviewer sees it.
    const element = describe(el);
    const viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY };
    host.style.visibility = 'hidden';
    if (cursorStyle) cursorStyle.disabled = true;
    await nextFrame(); await wait(40);
    const shot = await send({ type: 'capture' });
    host.style.visibility = '';
    if (cursorStyle) cursorStyle.disabled = false;

    const res = await send({
      type: 'api', method: 'POST', path: '/api/comments',
      body: { authorName, description, url: location.href, pageTitle: document.title, element, viewport, screenshot: shot.ok ? shot.dataUrl : null },
    });
    submitting = false;
    ui.submit.disabled = false;
    ui.submit.firstChild.textContent = 'Submit comment ';
    if (!res.ok) {
      ui.err.textContent = res.status === 401 ? 'Your access has ended. Sign in again from the extension icon.' : res.error;
      return;
    }
    ui.desc.value = '';
    deselect();
    pins.push({ comment: res.data.comment, el });
    renderPins();
    showToast(`Comment #${res.data.comment.number} submitted`);
  }

  /* ----------------------------------------------------------------- pins */
  async function loadPins() {
    if (!auth.loggedIn) return;
    const url = location.href;
    const res = await send({ type: 'api', method: 'GET', path: `/api/comments?status=open&page=${encodeURIComponent(url)}` });
    if (!res.ok || url !== location.href) return;
    pins = res.data.comments.map((c) => {
      let el = null;
      try { el = c.element.selector ? document.querySelector(c.element.selector) : null; } catch {}
      return { comment: c, el };
    });
    renderPins();
  }
  function renderPins() {
    const myId = auth.user && auth.user.id;
    ui.pins.innerHTML = pins.map((p) =>
      `<button class="pin ${p.comment.userId === myId ? 'mine' : ''}" data-id="${p.comment.id}" title="#${p.comment.number} · ${esc(p.comment.authorName)}">${p.comment.number}</button>`).join('');
    positionPins();
    updateLauncher();
  }
  function positionPins() {
    if (!active) return;
    for (const node of ui.pins.children) {
      const p = pins.find((x) => x.comment.id === node.dataset.id);
      if (!p) continue;
      let x, y;
      if (p.el && p.el.isConnected) { const r = p.el.getBoundingClientRect(); x = r.right - 14; y = r.top - 12; }
      else { const c = p.comment; x = c.element.rect.x + c.element.rect.width + c.viewport.scrollX - scrollX - 14; y = c.element.rect.y + c.viewport.scrollY - scrollY - 12; }
      const visible = y > -20 && y < innerHeight && x > -20 && x < innerWidth;
      node.style.display = visible ? '' : 'none';
      node.style.transform = `translate(${Math.min(Math.max(x, 4), innerWidth - 30)}px, ${Math.max(y, 4)}px)`;
      if (openPinId === p.comment.id) placePop(node);
    }
  }
  function timeAgo(iso) {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
  }
  function togglePop(id) {
    if (openPinId === id) return closePop();
    const p = pins.find((x) => x.comment.id === id); if (!p) return;
    openPinId = id;
    const c = p.comment;
    ui.pop.innerHTML = `<div class="pop-head"><span><b>#${c.number} · ${esc(c.authorName)}</b></span><span>${timeAgo(c.createdAt)}</span></div><p>${esc(c.description)}</p>`;
    ui.pop.classList.remove('hidden');
    positionPins();
  }
  function placePop(pinNode) {
    const r = pinNode.getBoundingClientRect();
    const w = 280, h = ui.pop.offsetHeight;
    let left = Math.min(r.right + 8, innerWidth - w - 10);
    let top = r.top;
    if (top + h > innerHeight - 10) top = innerHeight - h - 10;
    if (left < 10) left = 10;
    ui.pop.style.left = `${left}px`; ui.pop.style.top = `${Math.max(10, top)}px`;
  }
  function closePop() { openPinId = null; ui.pop.classList.add('hidden'); }

  /* ----------------------------------------------------------------- wiring */
  async function refreshAuth() {
    const s = await send({ type: 'getState' });
    auth = { loggedIn: !!s.loggedIn, user: s.user || null, enabled: s.enabled !== false, server: s.server || '' };
    if (!auth.loggedIn) { stop(); pins = []; renderPins(); }
    updateLauncher();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ping') { sendResponse({ pong: true }); return; }
    if (msg.type === 'startInspect') { refreshAuth().then(() => { start(); sendResponse({ ok: auth.loggedIn, error: auth.loggedIn ? null : 'Please sign in first.' }); }); return true; }
    if (msg.type === 'toggleInspect') { refreshAuth().then(() => (active ? stop() : start())); sendResponse({ ok: true }); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.token || changes.user || changes.enabled)) refreshAuth().then(() => { if (changes.token && auth.loggedIn) loadPins(); });
  });

  build();
  refreshAuth().then(() => { if (auth.loggedIn && auth.enabled) loadPins(); });
})();
