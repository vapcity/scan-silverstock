// ==UserScript==
// @name         Silver-Stock : scan +1
// @namespace    vapcity
// @version      2.6
// @downloadURL  https://raw.githubusercontent.com/vapcity/scan-silverstock/main/silverstock-scan.user.js
// @updateURL    https://raw.githubusercontent.com/vapcity/scan-silverstock/main/silverstock-scan.user.js
// @description  Scanne un code-barres dans l'inventaire : la quantité de la bonne ligne passe à +1 automatiquement. Compatible Mac et Windows.
// @match        https://app.silver-stock.fr/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  let panel = null;
  const undoStack = [];      // [{alert, added}]
  let lastLabel = '';        // dernier article scanné
  let currentKey = null;     // inventaire pour lequel on a restauré la sauvegarde
  const STORE = 'ss_scan_v2';
  const getPref = (k, d) => { try { const v = localStorage.getItem('ss_' + k); return v === null ? d : v === '1'; } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem('ss_' + k, v ? '1' : '0'); } catch (e) {} };
  let voiceOn = getPref('voice', true);
  let toastTimer = null;

  // ---------- accès à la page Angular ----------
  function getScope() {
    if (!window.angular) return null;
    const el = document.getElementById('searchBox1');
    if (!el) return null;
    const sc = angular.element(el).scope();
    return sc && sc.selected && sc.selected.alerts ? sc : null; // un inventaire doit être ouvert
  }

  function barcodesOf(alert) {
    const p = alert.product;
    if (!p) return [];
    const list = [];
    const add = v => { if (v !== null && v !== undefined && String(v).trim()) list.push(String(v).trim()); };
    if (!alert.sizeId) add(p.product_barcode);
    (p.product_specific_rules || []).forEach(r => { if (r.size_id === alert.sizeId) add(r.barcode); });
    if (Array.isArray(p.barcodes)) p.barcodes.forEach(b => add(b && b.barcode !== undefined ? b.barcode : b));
    return list;
  }

  const findAlerts = (sc, code) => (sc.selected.alerts || []).filter(a => barcodesOf(a).includes(code));
  const hasQty = a => a.realQuantityInput !== null && a.realQuantityInput !== undefined && a.realQuantityInput !== '';
  const counted = sc => (sc.selected.alerts || []).filter(a => Number(a.alertStatus) === 2 && hasQty(a));
  const remaining = sc => (sc.selected.alerts || []).filter(a => Number(a.alertStatus) === 2 && !hasQty(a));
  const nameOf = a => (a.product && a.product.product_model) || '?';
  const keyOf = sc => sc.selected.identifier || sc.selected.$id || 'inv';

  // ---------- sons / messages ----------
  // un seul contexte audio, réveillé au premier scan (Safari et Chrome sur Mac bloquent le son sinon)
  let audioCtx = null;
  function audio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  // voix française du Mac (Thomas, Amélie…) ou de Windows (Hortense, Paul…)
  function speak(text, delay) {
    if (!voiceOn || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR'; u.rate = 1.1;
    try {
      const v = speechSynthesis.getVoices();
      u.voice = v.find(x => x.lang === 'fr-FR' && x.localService) || v.find(x => /^fr/i.test(x.lang)) || null;
    } catch (e) {}
    setTimeout(() => speechSynthesis.speak(u), delay || 0);
  }

  function beep(ok, word) {
    try {
      const c = audio();
      const tone = (freq, start, dur, type, vol) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = type; o.frequency.value = freq; g.gain.value = vol;
        o.connect(g); g.connect(c.destination); o.start(c.currentTime + start); o.stop(c.currentTime + start + dur);
      };
      if (ok) tone(880, 0, 0.08, 'sine', 0.15);
      else { tone(150, 0, 0.25, 'sawtooth', 0.4); tone(110, 0.3, 0.45, 'sawtooth', 0.4); }
    } catch (e) {}
    if (!ok) {
      try {
        panel.style.transition = 'background .15s';
        panel.style.background = '#fecaca';
        setTimeout(() => { panel.style.background = '#fff'; }, 600);
        if (word) speak(word, 700);
      } catch (e) {}
    }
  }

  // petite mélodie montante : tout l'inventaire est scanné
  function fanfare() {
    try {
      const c = audio();
      [523, 659, 784, 1047].forEach((f, i) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f; g.gain.value = 0.2;
        o.connect(g); g.connect(c.destination);
        o.start(c.currentTime + 0.15 * i); o.stop(c.currentTime + 0.15 * i + 0.14);
      });
      speak('Tout est scanné', 700);
    } catch (e) {}
  }

  // petite bulle au-dessus du bandeau, qui s'efface toute seule (les erreurs restent plus longtemps)
  function say(text, kind) {
    const t = panel.querySelector('#ss-toast');
    t.textContent = text;
    t.style.display = 'block';
    t.style.background = kind === 'err' ? '#fdecec' : kind === 'ok' ? '#e8f9ee' : '#f3f4f6';
    t.style.color = kind === 'err' ? '#b91c1c' : kind === 'ok' ? '#15803d' : '#374151';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, kind === 'err' ? 7000 : 3000);
  }

  // ---------- sauvegarde (survit au rechargement de la page) ----------
  function readStore() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function writeStore(o) { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) {} }

  function snapshot(sc) {
    if (currentKey !== keyOf(sc)) return; // pas encore restauré pour cet inventaire
    const all = readStore();
    const key = keyOf(sc);
    const alerts = sc.selected.alerts || [];
    const ids = new Set(alerts.map(a => a.$id));
    const saved = {};
    // on garde les entrées dont la ligne n'est pas (encore) chargée
    Object.keys(all[key] || {}).forEach(id => { if (!ids.has(id)) saved[id] = all[key][id]; });
    counted(sc).forEach(a => { saved[a.$id] = parseInt(a.realQuantityInput, 10); });
    if (Object.keys(saved).length) all[key] = saved; else delete all[key];
    writeStore(all);
  }

  function restore(sc) {
    const key = keyOf(sc);
    currentKey = key;
    const saved = readStore()[key];
    if (!saved) return;
    let n = 0;
    sc.$applyAsync(() => {
      (sc.selected.alerts || []).forEach(a => {
        if (saved[a.$id] && Number(a.alertStatus) === 2 && !hasQty(a)) { a.realQuantityInput = saved[a.$id]; n++; }
      });
      if (n) say('↻ ' + n + ' quantité(s) retrouvée(s) après rechargement.', 'ok');
    });
  }

  // ---------- affichage ----------
  function refreshUI() {
    const sc = getScope();
    const list = sc ? counted(sc) : [];
    const pieces = list.reduce((s, a) => s + (parseInt(a.realQuantityInput, 10) || 0), 0);
    panel.querySelector('#ss-n').textContent = list.length;
    const off = !navigator.onLine;
    panel.querySelector('#ss-send').disabled = !list.length || off;
    panel.querySelector('#ss-send').title = off ? 'Pas d’internet : validation impossible pour le moment' : '';
    panel.querySelector('#ss-off').style.display = off ? 'block' : 'none';
    panel.querySelector('#ss-stats').textContent = list.length + ' article' + (list.length > 1 ? 's' : '') + ' · ' + pieces + ' pièce' + (pieces > 1 ? 's' : '');
    panel.querySelector('#ss-rem').textContent = sc ? remaining(sc).length : 0;
    panel.querySelector('#ss-undo').disabled = !undoStack.length;
    panel.querySelector('#ss-last').textContent = lastLabel || '—';
  }

  // affiche la ligne à l'écran (change de page si besoin) et la surligne
  function reveal(sc, alert) {
    const find = () => [...document.querySelectorAll('input[ng-model="alert.realQuantityInput"]')]
      .find(i => angular.element(i).scope().alert === alert);
    const flash = inp => {
      const row = inp.closest('[ng-repeat]') || inp.parentElement;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const old = row.style.transition, oldBg = row.style.background;
      row.style.transition = 'background .3s'; row.style.background = '#bbf7d0';
      setTimeout(() => { row.style.background = oldBg; row.style.transition = old; }, 700);
    };
    const inp = find();
    if (inp) return flash(inp);
    if (sc.pagination && sc.pagination.options) {
      const idx = sc.selected.filteredAlerts ? sc.selected.filteredAlerts.indexOf(alert) : -1;
      if (idx >= 0) {
        const per = sc.pagination.options.productsPerPage;
        sc.$apply(() => { sc.pagination.options.currentPage = Math.floor(idx / per) + 1; sc.pagination.recompute && sc.pagination.recompute(); });
        setTimeout(() => { const i = find(); if (i) flash(i); }, 300);
      }
    }
  }

  // ---------- douchette réglée en QWERTY sur un clavier AZERTY ----------
  // ex. « &éç » au lieu de « 129 » : on retraduit en chiffres (rangée du haut Mac et Windows)
  const AZERTY = { '&': '1', 'é': '2', '"': '3', "'": '4', '(': '5', '§': '6', '-': '6', 'è': '7', '!': '8', '_': '8', 'ç': '9', 'à': '0' };
  function normalize(code) {
    if (code.length > 1 && [...code].every(ch => AZERTY[ch])) return [...code].map(ch => AZERTY[ch]).join('');
    return code;
  }

  // ---------- actions ----------
  function onScan(raw) {
    const sc = getScope();
    if (!sc) return say('Ouvre d\'abord un inventaire (ex. « semaine du … »).', 'err');

    // "-" tapé dans le champ = annuler le dernier scan
    if (raw === '-') return undo();
    raw = normalize(raw);

    // lignes uniques (une même ligne peut apparaître deux fois en mémoire)
    const seen = new Set();
    const found = findAlerts(sc, raw).filter(a => { const k = a.$id || a; if (seen.has(k)) return false; seen.add(k); return true; });
    if (!found.length) { beep(false, 'Absent'); return say('⚠ Code ' + raw + ' : absent de cet inventaire.', 'err'); }
    const open = found.filter(a => Number(a.alertStatus) === 2);
    if (!open.length) {
      beep(false, 'Déjà validé');
      const invDone = Number(sc.selected.alertStatus) !== 2;
      return say('⚠ ' + nameOf(found[0]) + (invDone ? ' : cet inventaire est déjà validé. Ouvre un inventaire de la colonne « Demandes d’inventaires ».' : ' : ligne déjà validée dans Silver-Stock, pas modifiée.'), 'err');
    }
    let target = open[0];
    if (open.length > 1) {
      // même produit et même taille sur plusieurs lignes : on prend la première
      const sameItem = new Set(open.map(a => a.productId + '_' + a.sizeId)).size === 1;
      if (!sameItem) {
        // déjà choisi pour ce code pendant cette session ?
        const chosen = open.find(a => choices[raw] && a.$id === choices[raw]);
        if (!chosen) return pickLine(sc, raw, open);
        target = chosen;
      }
    }
    return addOne(sc, target);
  }

  // ---------- même code-barres sur plusieurs articles : on demande lequel ----------
  const choices = {}; // code -> $id de la ligne choisie (pendant la session)
  function pickLine(sc, code, lines) {
    beep(false, 'Choisis la ligne');
    const old = document.getElementById('ss-modal'); if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'ss-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
    modal.innerHTML =
      '<div style="background:#fff;border-radius:10px;width:min(520px,94vw);font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;padding:14px">' +
      '<b>Ce code (' + code + ') correspond à ' + lines.length + ' lignes.</b><div style="color:#64748b;font-size:12px;margin:4px 0 10px">Clique sur la bonne ligne. Le choix est retenu pour les scans suivants de ce code.</div>' +
      '<div id="ss-pl"></div><div style="text-align:right;margin-top:8px"><button id="ss-pc" style="padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;cursor:pointer">Annuler (Échap)</button></div></div>';
    document.body.appendChild(modal);
    const list = modal.querySelector('#ss-pl');
    const close = () => { document.removeEventListener('keydown', onKey, true); modal.remove(); panel.querySelector('#ss-in').focus(); };
    const pick = a => { choices[code] = a.$id; close(); addOne(sc, a); };
    lines.slice(0, 12).forEach(a => {
      const b = document.createElement('button');
      b.style.cssText = 'display:block;width:100%;text-align:left;padding:9px 10px;margin:4px 0;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;cursor:pointer;font-size:14px';
      b.textContent = nameOf(a) + (a.sizeName && a.sizeName !== 'Taille unique' ? ' — ' + a.sizeName : '') + '   (compté : ' + (parseInt(a.realQuantityInput, 10) || 0) + ')';
      b.onclick = () => pick(a);
      list.appendChild(b);
    });
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); say('Rien ajouté.', ''); }
      else { e.preventDefault(); e.stopPropagation(); } // un scan pendant le choix est ignoré
    };
    document.addEventListener('keydown', onKey, true);
    modal.querySelector('#ss-pc').onclick = () => { close(); say('Rien ajouté.', ''); };
    say('⚠ Plusieurs lignes pour ce code : choisis la bonne.', 'err');
  }

  function addOne(sc, target) {
    const add = 1;
    const wasRemaining = remaining(sc).length;
    const next = (parseInt(target.realQuantityInput, 10) || 0) + add;
    sc.$apply(() => { target.realQuantityInput = next; });
    undoStack.push({ alert: target, added: add });
    if (undoStack.length > 200) undoStack.shift();
    lastLabel = nameOf(target) + (target.sizeName && target.sizeName !== 'Taille unique' ? ' (' + target.sizeName + ')' : '') + '  →  ' + next;
    reveal(sc, target);
    say('+' + add + ' → ' + nameOf(target) + ' : ' + next, 'ok');
    snapshot(sc); refreshUI();
    // dernier article de la liste scanné pour la première fois
    if (wasRemaining === 1 && remaining(sc).length === 0) {
      fanfare();
      say('✅ Tout est scanné ! Vérifie les quantités, puis « Valider ».', 'ok');
    } else beep(true);
  }

  function undo() {
    const sc = getScope(); if (!sc) return;
    const last = undoStack.pop();
    if (!last) return say('Rien à annuler.', 'err');
    const a = last.alert;
    const left = (parseInt(a.realQuantityInput, 10) || 0) - last.added;
    sc.$apply(() => { a.realQuantityInput = left > 0 ? left : null; });
    lastLabel = '↩ annulé : ' + nameOf(a) + (left > 0 ? '  →  ' + left : '');
    say('Annulé −' + last.added + ' → ' + nameOf(a), 'ok');
    reveal(sc, a); snapshot(sc); refreshUI();
  }

  function showRemaining() {
    const sc = getScope(); if (!sc) return say('Ouvre d\'abord un inventaire.', 'err');
    const list = remaining(sc);
    const old = document.getElementById('ss-modal'); if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'ss-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
    modal.innerHTML =
      '<div style="background:#fff;border-radius:10px;width:min(560px,94vw);max-height:80vh;display:flex;flex-direction:column;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif">' +
        '<div style="padding:12px 14px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:8px">' +
          '<b style="flex:1">Pas encore scannés (' + list.length + ')</b>' +
          '<input id="ss-mf" placeholder="Filtrer…" style="padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px">' +
          '<button id="ss-mc" style="border:0;background:none;font-size:20px;cursor:pointer">✕</button></div>' +
        '<div id="ss-ml" style="overflow:auto;padding:6px 14px"></div></div>';
    document.body.appendChild(modal);
    const ml = modal.querySelector('#ss-ml');
    const draw = () => {
      const q = modal.querySelector('#ss-mf').value.toLowerCase();
      ml.innerHTML = '';
      list.filter(a => (nameOf(a) + ' ' + (a.sizeName || '')).toLowerCase().includes(q)).forEach(a => {
        const d = document.createElement('div');
        d.style.cssText = 'padding:7px 0;border-bottom:1px solid #f1f5f9;cursor:pointer';
        d.textContent = nameOf(a) + (a.sizeName && a.sizeName !== 'Taille unique' ? ' — ' + a.sizeName : '');
        d.title = 'Cliquer pour afficher la ligne';
        d.onclick = () => { modal.remove(); reveal(sc, a); };
        ml.appendChild(d);
      });
      if (!ml.children.length) ml.innerHTML = '<div style="padding:16px;color:#15803d">✅ Tout a été scanné.</div>';
    };
    modal.querySelector('#ss-mf').oninput = draw; draw();
    const close = () => { modal.remove(); panel.querySelector('#ss-in').focus(); };
    modal.querySelector('#ss-mc').onclick = close;
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
  }

  async function sendAll() {
    const sc = getScope(); if (!sc) return;
    const list = counted(sc);
    if (!list.length) return;
    if (!navigator.onLine) { beep(false); return say('⚠ Pas d’internet : validation impossible, réessaie quand la connexion revient.', 'err'); }
    const pieces = list.reduce((s, a) => s + (parseInt(a.realQuantityInput, 10) || 0), 0);
    const left = remaining(sc).length;
    const recap = 'Envoyer à Silver-Stock :\n' +
      '• ' + list.length + ' article(s) comptés\n' +
      '• ' + pieces + ' pièce(s) au total\n' +
      (left ? '\n⚠ ATTENTION : ' + left + ' article(s) de la liste n\'ont PAS été scannés et ne seront pas envoyés.\n' : '\n✅ Tous les articles de la liste ont été scannés.\n') +
      '\nValider l\'envoi ?';
    if (!confirm(recap)) return;
    const btn = panel.querySelector('#ss-send'); btn.disabled = true;
    let ok = 0, bad = 0;
    for (const a of list) {
      try { await sc.sendVerif(a, a.realQuantityInput); ok++; } catch (e) { bad++; }
      say('Envoi… ' + (ok + bad) + ' / ' + list.length, '');
    }
    undoStack.length = 0;
    try { sc.$applyAsync(() => sc.pagination.recompute()); } catch (e) {}
    say('Envoyé : ' + ok + ' article(s)' + (bad ? ', ' + bad + ' erreur(s)' : '') + '.', bad ? 'err' : 'ok');
    setTimeout(() => { const s = getScope(); if (s) snapshot(s); refreshUI(); }, 1500);
  }

  // ---------- construction du bandeau ----------
  function build() {
    panel = document.createElement('div');
    panel.id = 'ss-scan-panel';
    panel.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:99999;background:#fff;border:2px solid #3d86dc;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.25);padding:8px;width:min(380px,94vw);font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif';
    const btn = 'padding:6px 9px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;cursor:pointer;font-size:13px';
    const open = getPref('open', false);
    panel.innerHTML =
      '<div id="ss-off" style="display:none;margin-bottom:6px;padding:6px 9px;border-radius:6px;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:600">⚠ Pas d’internet : ne valide pas maintenant. Tes scans sont gardés.</div>' +
      '<div id="ss-toast" style="display:none;position:absolute;left:0;right:0;top:100%;margin-top:6px;padding:7px 10px;border-radius:8px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.2)"></div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<span id="ss-grip" title="Glisser pour déplacer (double-clic : recentrer)" style="cursor:grab;user-select:none;touch-action:none;color:#94a3b8;font-size:18px;line-height:1;padding:0 2px">⋮⋮</span>' +
        '<input id="ss-in" placeholder="📷 Scanner ici" autocomplete="off" style="flex:1;min-width:0;padding:7px 9px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px">' +
        '<button id="ss-send" style="padding:7px 10px;border:0;border-radius:6px;background:#3d86dc;color:#fff;font-weight:600;cursor:pointer;white-space:nowrap">Valider (<span id="ss-n">0</span>)</button>' +
        '<button id="ss-x" title="Afficher / masquer les détails" style="border:0;background:none;font-size:16px;cursor:pointer;padding:0 4px">' + (open ? '▾' : '▴') + '</button>' +
      '</div>' +
      '<div id="ss-body" style="display:' + (open ? 'block' : 'none') + '">' +
        '<div style="margin-top:8px;display:flex;align-items:baseline;gap:8px">' +
          '<div id="ss-last" style="flex:1;min-width:0;font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</div>' +
          '<span id="ss-stats" style="color:#64748b;font-size:12px;white-space:nowrap"></span>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<button id="ss-undo" style="' + btn + '">↩ Annuler</button>' +
          '<button id="ss-remb" style="' + btn + '">📋 Restants (<span id="ss-rem">0</span>)</button>' +
          '<button id="ss-voice" style="' + btn + '"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);
    // déplacement horizontal uniquement ; la position est mémorisée
    let posX = 0.5;
    try { const v = parseFloat(localStorage.getItem('ss_posx')); if (v >= 0 && v <= 1) posX = v; } catch (e) {}
    const applyPos = () => {
      const w = panel.offsetWidth, vw = window.innerWidth;
      const cx = Math.min(Math.max(posX * vw, w / 2 + 4), vw - w / 2 - 4);
      panel.style.left = cx + 'px';
    };
    const savePos = () => { try { localStorage.setItem('ss_posx', String(posX)); } catch (e) {} };
    const grip = panel.querySelector('#ss-grip');
    grip.addEventListener('pointerdown', e => { grip.setPointerCapture(e.pointerId); grip.style.cursor = 'grabbing'; e.preventDefault(); });
    grip.addEventListener('pointermove', e => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      posX = e.clientX / window.innerWidth; applyPos(); savePos();
    });
    grip.addEventListener('pointerup', e => { try { grip.releasePointerCapture(e.pointerId); } catch (err) {} grip.style.cursor = 'grab'; savePos(); panel.querySelector('#ss-in').focus(); });
    grip.addEventListener('dblclick', () => { posX = 0.5; applyPos(); savePos(); });
    window.addEventListener('resize', applyPos);
    applyPos();

    const voiceBtn = panel.querySelector('#ss-voice');
    const drawVoice = () => { voiceBtn.textContent = voiceOn ? '🔊 Voix' : '🔇 Sans voix'; };
    drawVoice();
    voiceBtn.onclick = () => { voiceOn = !voiceOn; setPref('voice', voiceOn); if (!voiceOn && window.speechSynthesis) speechSynthesis.cancel(); drawVoice(); panel.querySelector('#ss-in').focus(); };

    const input = panel.querySelector('#ss-in');
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== 'Tab') return;
      e.preventDefault();
      const code = input.value.trim(); input.value = '';
      if (code) onScan(code);
    });
    panel.querySelector('#ss-send').onclick = sendAll;
    panel.querySelector('#ss-undo').onclick = () => { undo(); input.focus(); };
    panel.querySelector('#ss-remb').onclick = showRemaining;
    panel.querySelector('#ss-x').onclick = () => {
      const body = panel.querySelector('#ss-body');
      const show = body.style.display === 'none';
      body.style.display = show ? 'block' : 'none';
      panel.querySelector('#ss-x').textContent = show ? '▾' : '▴';
      setPref('open', show);
      input.focus();
    };
    window.addEventListener('offline', () => { refreshUI(); beep(false, 'Plus d’internet'); say('⚠ Plus d’internet. Continue de scanner, mais ne valide pas.', 'err'); });
    window.addEventListener('online', () => { refreshUI(); say('Internet est revenu. Tu peux valider.', 'ok'); });
    // reprend le focus quand on clique dans le vide
    document.addEventListener('click', e => {
      if (!e.target.closest('input,button,select,textarea,a,[ng-click],#ss-modal')) input.focus();
    });
    input.focus();
  }

  // ---------- démarrage : le bandeau n'apparaît que sur la page Inventaires ----------
  setInterval(() => {
    const onPage = /#!\/inventories/.test(location.hash) && document.getElementById('searchBox1');
    if (onPage && !panel) build();
    if (!panel) return;
    panel.style.display = onPage ? '' : 'none';
    if (!onPage) return;
    const sc = getScope();
    if (sc && (sc.selected.alerts || []).length) {
      if (currentKey !== keyOf(sc)) { undoStack.length = 0; lastLabel = ''; restore(sc); }
      else snapshot(sc); // enregistre aussi les quantités saisies à la main
    }
    refreshUI();
  }, 1000);
})();
