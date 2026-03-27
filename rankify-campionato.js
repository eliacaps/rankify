/**
 * rankify-campionato.js
 * Campionato: Tier S (20), Tier A (20), Tier B/C/D con distribuzione automatica per data.
 * - Tier B: 3 gruppi × 16 — Group A = più vecchi, Group C = più nuovi
 * - Tier C: 9 gruppi × 16 — Group A = più vecchi, Group I = più nuovi
 * - Tier D: 27 gruppi × 16 — Group A = più vecchi, Group Ω = più nuovi
 * L'utente inserisce/rimuove opening nel tier; il sistema ridistribuisce automaticamente.
 */
'use strict';

// escapeHtml è definita in rankify.js e disponibile globalmente.
// Se questo file venisse mai usato standalone, la funzione è qui come fallback:
/* function escapeHtml(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');} */

const CAMPIONATO_FILE = 'campionato.json';

// ── STATO SESSIONI DI GIOCO ──────────────────────────────────────────────────
// Ogni oggetto raccoglie le variabili di una sessione specifica.
// Le funzioni rimangono top-level e accedono allo stato tramite questi oggetti.

const giocaState = {
  tier:     'S',
  day:      0,       // 0-based
  matchIdx: 0,
  matches:  [],      // [[a,b], ...]
  results:  [],      // [{a, b, scoreA, scoreB}, ...]
  rounds:   [],      // calendario completo
  order:    [],      // snapshot classifica a inizio sessione
};

const swissState = {
  group:         null,
  turn:          0,
  matches:       [],
  matchIdx:      0,
  results:       [],
  phase:         'stage',  // 'stage' | 'knock'
  knockPhase:    'qf',     // 'qf' | 'sf' | 'final'
  knockMatches:  [],
  knockResults:  [],
  knockMatchIdx: 0,
  forcedTurn:    null,
};

const tierCState = {
  group:         null,
  phase:         'main',   // 'main' | 'silver'
  matchPhase:    'r16',
  knockMatches:  [],
  knockResults:  [],
  knockMatchIdx: 0,
};

const campionatoUI = {
  currentTier:  'S',
  currentGroup: null,
  searchQuery:  '',
  groupSearchQuery: '',
  dragName:     null,
};

// Gruppo corrente Tier B (dichiarato qui per evitare ReferenceError in strict mode)
let _giocaBGroup = null;

/* ══════════════════════════════════════════════════════════════
   CACHE LAYER
   Riduce calcoli ripetuti e lookup lineari sul db.
══════════════════════════════════════════════════════════════ */

// Cache per getEntryByName — invalidata quando db cambia
const _entryCache = new Map();
function _invalidateEntryCache() { _entryCache.clear(); }

// Cache per distributeGroups — chiave: tier + hash leggero della lista
// (hash su lunghezza + somma charCode dei nomi: O(n) sul contenuto ma stringa corta,
//  nessuna collisione su pipe nei nomi, invalida correttamente dopo drag&drop)
const _distCache = new Map();
function _distCacheKey(tier) {
  const list = campionatoData[tier];
  if (!list || list.length === 0) return tier + ':0';
  let h = list.length;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    for (let j = 0; j < s.length; j++) {
      h = (Math.imul(h, 31) + s.charCodeAt(j)) | 0;
    }
    // Include la posizione nell'hash così drag&drop cambia la chiave
    h = (Math.imul(h, 31) + i) | 0;
  }
  return tier + ':' + (h >>> 0);
}
function _invalidateDistCache(tier) {
  if (tier) {
    const prefix = tier + ':';
    for (const k of _distCache.keys()) { if (k.startsWith(prefix)) _distCache.delete(k); }
  } else {
    _distCache.clear();
  }
}

// Cache per _generateRoundRobin — chiave: JSON dei team
const _rrCache = new Map();
const _RR_CACHE_MAX = 4;
function _invalidateRRCache() { _rrCache.clear(); }

// Cache per getAllUsedNames — invalida ad ogni modifica
let _usedNamesCache = null;
function _invalidateUsedNames() { _usedNamesCache = null; }

// Cache per getOpenings — invalidata quando db cambia (lo gestisce rankify.js via _invalidateCatCache,
// ma campionatoData non modifica db, quindi è sicuro invalidarla solo al load)
let _openingsCache = null;
function _invalidateOpeningsCache() { _openingsCache = null; }

// Cache per _swissGetRecordsUpTo — chiave: group + upTo + turn corrente
// Invalida all'inizio di ogni sessione match e dopo ogni salvataggio turno
const _recordsCache = new Map();
function _invalidateRecordsCache(group) {
  if (group) {
    for (const k of _recordsCache.keys()) { if (k.startsWith(group + ':')) _recordsCache.delete(k); }
  } else {
    _recordsCache.clear();
  }
}

// Cache per _swissGenerateTurnMatches — raramente cambia (dipende da t0Order e risultati)
const _turnMatchesCache = new Map();
function _invalidateTurnMatchesCache(group) {
  if (group) {
    for (const k of _turnMatchesCache.keys()) { if (k.startsWith(group + ':')) _turnMatchesCache.delete(k); }
  } else {
    _turnMatchesCache.clear();
  }
}

/* ── SVG costanti hoistate — non riallocate ad ogni _renderTierChrome ── */
const _SVG_CALENDAR = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><rect x="1" y="3" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="1" y1="7" x2="15" y2="7" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="1" x2="5" y2="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="11" y1="1" x2="11" y2="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const _SVG_SWISS    = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><circle cx="3" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="13" cy="3" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="13" cy="13" r="2" stroke="currentColor" stroke-width="1.4"/><line x1="5" y1="8" x2="11" y2="4" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="8" x2="11" y2="12" stroke="currentColor" stroke-width="1.2"/></svg>`;
const _SVG_KNOCK    = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><rect x="1" y="5" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="10" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.4"/><line x1="7" y1="7" x2="9" y2="4" stroke="currentColor" stroke-width="1.2"/><line x1="7" y1="7" x2="9" y2="12" stroke="currentColor" stroke-width="1.2"/></svg>`;
const _SVG_SILVER   = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'];
const SEASON_START = { name: 'Spring', year: 2026 };

function seasonFromIndex(idx) {
  const year = SEASON_START.year + Math.floor((idx + SEASONS.indexOf(SEASON_START.name)) / SEASONS.length);
  const seasonName = SEASONS[(idx + SEASONS.indexOf(SEASON_START.name)) % SEASONS.length];
  return `${seasonName} ${year}`;
}

function getCurrentSeasonLabel() {
  const idx = campionatoData._seasonIdx || 0;
  return seasonFromIndex(idx);
}

function getNextSeasonLabel() {
  const idx = (campionatoData._seasonIdx || 0) + 1;
  return seasonFromIndex(idx);
}

const TIER_CONFIG = {
  S:  { type: 'simple',   max: 20,       color: '#f5c842' },
  A:  { type: 'simple',   max: 20,       color: '#42e8a0' },
  B:  { type: 'grouped',  max: 16,       color: '#60a8ff', groups: ['A','B','C'] },
  C:  { type: 'grouped',  max: 16,       color: '#7c6fff', groups: ['A','B','C','D','E','F','G','H','I'] },
  D:  { type: 'grouped',  max: 16,       color: '#ff6ba0', groups: ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','Ω'] },
  NE: { type: 'simple',   max: Infinity, color: '#ffffff' }
};
const CAMPIONATO_TIERS = ['S','A','B','C','D','NE'];

/* ══════════════════════════════════════════════════════════════
   STATO
   campionatoData shape:
   {
     S: [],          // array di nomi
     A: [],
     B: [],          // lista flat — distribuita automaticamente
     C: [],
     D: []
   }
══════════════════════════════════════════════════════════════ */
let campionatoData = {};

/* ── DEFAULT ──────────────────────────────────────────────── */
function makeDefaultData() {
  const d = { _seasonIdx: 0, _hallOfFame: [], _sScores: {}, _matchdayResults: {}, _matchdayOrder: [], _aScores: {}, _aMatchdayResults: {}, _aMatchdayOrder: [], _swissB: {}, _knockC: {} };
  CAMPIONATO_TIERS.forEach(t => { d[t] = []; });
  return d;
}

function mergeData(parsed) {
  const def = makeDefaultData();
  if (typeof parsed._seasonIdx === 'number') def._seasonIdx = parsed._seasonIdx;
  ['_hallOfFame', '_matchdayOrder', '_aMatchdayOrder'].forEach(k => {
    if (Array.isArray(parsed[k])) def[k] = parsed[k];
  });
  ['_sScores', '_matchdayResults', '_aScores', '_aMatchdayResults', '_swissB', '_knockC'].forEach(k => {
    if (parsed[k] && typeof parsed[k] === 'object' && !Array.isArray(parsed[k])) def[k] = parsed[k];
  });
  CAMPIONATO_TIERS.forEach(t => {
    if (Array.isArray(parsed[t])) {
      def[t] = parsed[t];
    } else if (parsed[t] && typeof parsed[t] === 'object') {
      const cfg = TIER_CONFIG[t];
      if (cfg.type === 'grouped')
        cfg.groups.forEach(g => { if (Array.isArray(parsed[t][g])) def[t].push(...parsed[t][g]); });
    }
  });
  return def;
}

/* ── LOAD / SAVE ──────────────────────────────────────────── */
function campionatoLoad(callback) {
  fetch(CAMPIONATO_FILE + '?_=' + Date.now())
    .then(r => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(text => {
      if (text === null) {
        campionatoData = makeDefaultData();
        if (callback) callback();
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        console.error('[Rankify] campionato.json corrotto:', e.message);
        if (typeof toast === 'function')
          toast('⚠ campionato.json sembra corrotto — dati in memoria mantenuti. Controlla il file.', 'error');
        if (!campionatoData || Object.keys(campionatoData).length === 0)
          campionatoData = makeDefaultData();
        if (callback) callback();
        return;
      }
      campionatoData = mergeData(parsed);
      _invalidateEntryCache();
      _invalidateOpeningsCache();
      _invalidateUsedNames();
      _invalidateDistCache();
      _invalidateRRCache();
      _invalidateRecordsCache();
      _invalidateTurnMatchesCache();
      if (callback) callback();
    })
    .catch(err => {
      console.error('[Rankify] Errore caricamento campionato:', err);
      if (typeof toast === 'function')
        toast('⚠ Impossibile caricare campionato.json — dati in memoria mantenuti.', 'error');
      if (!campionatoData || Object.keys(campionatoData).length === 0)
        campionatoData = makeDefaultData();
      if (callback) callback();
    });
}

/* ── Save con coda anti-race-condition ──
   Garantisce che le richieste arrivino al server nell'ordine in cui
   sono state generate, prevenendo che una save "vecchia" sovrascriva
   una "nuova". onDone viene sempre chiamato (anche in caso di errore).
*/
let _campSaveQueue = Promise.resolve();
let _campSavePending = false;  // c'e' gia' un salvataggio in attesa in coda?

function campionatoSave(onDone) {
  _invalidateUsedNames();
  _invalidateDistCache();

  // Se c'e' gia' un save in coda (non ancora partito), scartalo:
  // tanto quello che partira' dopo avra' i dati piu' aggiornati.
  if (_campSavePending) {
    if (onDone) onDone();
    return;
  }
  _campSavePending = true;

  // Snapshot dei dati al momento della chiamata, non al momento dell'invio
  const snapshot = JSON.stringify(campionatoData, null, 2);

  _campSaveQueue = _campSaveQueue.then(() => {
    _campSavePending = false;
    return fetch('/save-campionato', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rankify-Password': (typeof RANKIFY_PASSWORD !== 'undefined' ? RANKIFY_PASSWORD : '')
      },
      body: snapshot
    })
    .then(r => {
      if (!r.ok) {
        console.error('[Rankify] Errore salvataggio campionato: HTTP', r.status);
        if (typeof toast === 'function') toast('⚠ Salvataggio fallito (HTTP ' + r.status + ')', 'error');
      }
      if (onDone) onDone();
    })
    .catch(err => {
      console.error('[Rankify] Errore salvataggio campionato:', err);
      if (typeof toast === 'function') toast('⚠ Salvataggio fallito — controlla che il server sia attivo.', 'error');
      if (onDone) onDone();
    });
  });
}

/* ── DB helpers ───────────────────────────────────────────── */
function getOpenings() {
  if (typeof db === 'undefined') return [];
  if (_openingsCache) return _openingsCache;
  _openingsCache = db.filter(e => e && (e.categories || []).some(c => c.toLowerCase() === 'opening'));
  return _openingsCache;
}

function getEntryByName(name) {
  if (typeof db === 'undefined') return null;
  if (_entryCache.has(name)) return _entryCache.get(name);
  const entry = db.find(e => e && e.name === name) || null;
  _entryCache.set(name, entry);
  return entry;
}

function getEntryDate(name) {
  const e = getEntryByName(name);
  if (!e || !e.data) return Infinity;
  const s = e.data.trim();

  // "-2010" → -2010 (negativo, quindi prima di 2011)
  // "2011"  → 2011
  // "2011-2015" → 2011 (prende il primo numero con segno)
  const match = s.match(/^(-?\d+)/);
  if (match) return parseInt(match[1], 10);

  return Infinity;
}

/** Tutti i nomi usati in qualunque tier */
function getAllUsedNames() {
  if (_usedNamesCache) return _usedNamesCache;
  _usedNamesCache = CAMPIONATO_TIERS.flatMap(t => campionatoData[t] || []);
  return _usedNamesCache;
}

/* ── DISTRIBUZIONE AUTOMATICA ─────────────────────────────── */
/**
 * Distribuisce gli opening nei gruppi in modo round-robin:
 * il prossimo opening va sempre nel gruppo con meno elementi.
 * In caso di parità, va nel gruppo con indice più basso (A prima di B, ecc.).
 * Restituisce { A: [...], B: [...], ... }
 */
function distributeGroups(tier) {
  const cacheKey = _distCacheKey(tier);
  if (_distCache.has(cacheKey)) return _distCache.get(cacheKey);

  const cfg      = TIER_CONFIG[tier];
  const original = campionatoData[tier] || [];
  const nGrp     = cfg.groups.length;

  const sorted = [...original].sort((a, b) => {
    const da = getEntryDate(a), db = getEntryDate(b);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  const n     = sorted.length;
  const base  = Math.floor(n / nGrp);
  const extra = n % nGrp;
  const sizes = cfg.groups.map((_, i) => base + (i < extra ? 1 : 0));

  const nameToGroup = {};
  let si = 0;
  cfg.groups.forEach((g, gi) => {
    for (let k = 0; k < sizes[gi]; k++) {
      nameToGroup[sorted[si++]] = g;
    }
  });

  const result = {};
  cfg.groups.forEach(g => { result[g] = []; });
  original.forEach(name => {
    const g = nameToGroup[name];
    if (g) result[g].push(name);
  });

  _distCache.set(cacheKey, result);
  return result;
}

/* ── NAVIGAZIONE ──────────────────────────────────────────── */
function showCampionato() {
  campionatoLoad(() => {
    showView('campionatoMenuView');
    campionatoUpdateMenuCounts();
    campionatoCheckOrfani();
    campionatoUpdateSeasonUI();
  });
}

function campionatoUpdateSeasonUI() {
  const el = document.getElementById('campSeasonLabel');
  if (el) el.textContent = getCurrentSeasonLabel();
  const btn = document.querySelector('.camp-next-season-btn');
  if (btn) btn.title = `Avanza a: ${getNextSeasonLabel()}`;
  // Aggiorna label del bottone NE nel menu
  const neLabel = document.querySelector('.camp-tier-menu-btn.tier-ne .camp-tier-menu-label');
  if (neLabel) neLabel.textContent = getCurrentSeasonLabel();
}

function campionatoCheckOrfani() {
  const allNames = new Set((typeof db !== 'undefined' ? db : []).map(e => e.name));
  const orfani = [];
  CAMPIONATO_TIERS.forEach(t => {
    campionatoData[t].forEach(n => {
      if (!allNames.has(n)) orfani.push({ name: n, tier: t });
    });
  });
  if (orfani.length === 0) return;

  // Mostra pannello orfani
  const panel = document.getElementById('campOrfaniPanel');
  if (!panel) return;
  panel.style.display = 'block';
  const list = document.getElementById('campOrfaniList');
  list.innerHTML = orfani.map((o, orfanoIdx) => {
    const ns = o.name.replace(/'/g,"\'").replace(/"/g,'&quot;');
    const suggestions = (typeof db !== 'undefined' ? db : [])
      .filter(e => e.name.toLowerCase().includes(o.name.toLowerCase().slice(0,4)))
      .slice(0,5);
    const opts = suggestions.map(e =>
      `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`
    ).join('');
    return `<div class="camp-orfano-row">
      <span class="camp-orfano-name" title="Tier ${escapeHtml(o.tier)}">⚠ ${escapeHtml(o.name)} <small>(Tier ${escapeHtml(o.tier)})</small></span>
      <select class="camp-orfano-select" id="orfano_${orfanoIdx}">
        <option value="">— ignora —</option>
        ${opts}
      </select>
      <input class="camp-orfano-input" placeholder="o digita nuovo nome…"
        list="dbNames" id="orfanoInput_${orfanoIdx}"/>
    </div>`;
  }).join('');

  // datalist con tutti i nomi del db
  let dl = document.getElementById('dbNamesList');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'dbNamesList'; document.body.appendChild(dl); }
  dl.innerHTML = (typeof db !== 'undefined' ? db : []).map(e => `<option value="${escapeHtml(e.name)}"/>`).join('');

  // Salva riferimento orfani per il fix
  panel._orfani = orfani;
}

function campionatoFixOrfani() {
  const panel = document.getElementById('campOrfaniPanel');
  if (!panel || !panel._orfani) return;
  let changed = false;
  panel._orfani.forEach((o, orfanoIdx) => {
    const sel = document.getElementById('orfano_' + orfanoIdx);
    const inp = document.getElementById('orfanoInput_' + orfanoIdx);
    const newName = (inp && inp.value.trim()) || (sel && sel.value) || '';
    if (!newName) return;
    const t = o.tier;
    campionatoData[t] = campionatoData[t].map(n => n === o.name ? newName : n);
    changed = true;
  });
  if (changed) {
    _invalidateEntryCache();
    _invalidateOpeningsCache();
    _invalidateUsedNames();
    _invalidateDistCache();
    campionatoSave();
    if (typeof toast === 'function') toast('Elementi aggiornati!', 'success');
  }
  panel.style.display = 'none';
  campionatoUpdateMenuCounts();
}

function campionatoIgnoraOrfani() {
  // Rimuove solo gli orfani non rimappati
  const panel = document.getElementById('campOrfaniPanel');
  if (!panel || !panel._orfani) return;
  const allNames = new Set((typeof db !== 'undefined' ? db : []).map(e => e.name));
  CAMPIONATO_TIERS.forEach(t => {
    campionatoData[t] = campionatoData[t].filter(n => allNames.has(n));
  });
  campionatoSave();
  panel.style.display = 'none';
  campionatoUpdateMenuCounts();
  if (typeof toast === 'function') toast('Elementi orfani rimossi', 'info');
}

function showCampionatoTier(tier) {
  campionatoUI.currentTier  = tier;
  campionatoUI.currentGroup = null;
  const cfg = TIER_CONFIG[tier];

  if (cfg.type === 'grouped') {
    campionatoUI.groupSearchQuery = '';
    showView('campionatoGroupView');
    renderGroupPicker();
    renderGroupAddPanel();
  } else {
    campionatoUI.searchQuery = '';
    showView('campionatoTierView');
    renderCampionatoTier();
  }
}

function showCampionatoGroup(group) {
  campionatoUI.currentGroup = group;
  showView('campionatoTierView');
  renderCampionatoTier();
}

function campionatoBack() {
  const cfg = TIER_CONFIG[campionatoUI.currentTier];
  if (cfg.type === 'grouped' && campionatoUI.currentGroup !== null) {
    campionatoUI.currentGroup = null;
    campionatoUI.groupSearchQuery   = '';
    showView('campionatoGroupView');
    renderGroupPicker();
    renderGroupAddPanel();
  } else {
    campionatoUpdateMenuCounts();
    showView('campionatoMenuView');
  }
}

/* ── CONTATORI MENU ───────────────────────────────────────── */


function campionatoUpdateMenuCounts() {
  for (const [tier, cfg] of Object.entries(TIER_CONFIG)) {
    const el = document.getElementById('campMenuCount' + tier);
    if (!el) continue;
    const n = (campionatoData[tier] || []).length;
    if (cfg.max === Infinity) {
      el.textContent = `${n} elementi`;
    } else if (cfg.type === 'simple') {
      el.textContent = `${n} / ${cfg.max}`;
    } else {
      el.textContent = `${n} / ${cfg.groups.length * cfg.max}`;
    }
  }
}

/* ── GROUP PICKER ─────────────────────────────────────────── */
function renderGroupPicker() {
  const tier = campionatoUI.currentTier;
  const cfg  = TIER_CONFIG[tier];
  const dist = distributeGroups(tier);

  const labelEl = document.getElementById('campGroupTierLabel');
  if (labelEl) { labelEl.textContent = `TIER ${tier}`; labelEl.style.color = cfg.color; }
  const groupSeasonEl = document.getElementById('campGroupSeasonLabel');
  if (groupSeasonEl) groupSeasonEl.textContent = getCurrentSeasonLabel();

  const grid = document.getElementById('campGroupGrid');
  if (!grid) return;

  const n    = cfg.groups.length;
  // Tier B (3 gruppi): 1 colonna, larghi come i 3 bottoni sommati
  // Tier C (9 gruppi): 3 colonne
  // Tier D (27 gruppi): 9 colonne
  const cols    = n <= 3 ? 1 : n <= 9 ? 3 : 9;
  const maxW    = n <= 3 ? '560px' : n <= 9 ? '560px' : '1400px';
  const padding = n <= 3 ? '28px 10px' : n <= 9 ? '28px 10px' : '12px 8px';
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.maxWidth = maxW;
  grid.dataset.padding = padding;

  grid.innerHTML = cfg.groups.map(g => {
    const members = dist[g] || [];
    const count   = members.length;
    const full    = count >= cfg.max;

    // Calcola range di date del gruppo
    let dateRange = '';
    if (count > 0) {
      const dates = members.map(n => getEntryDate(n)).filter(d => d !== Infinity);
      if (dates.length > 0) {
        const minD = Math.min(...dates);
        const maxD = Math.max(...dates);
        // Recupera la stringa originale della data per mostrare il formato originale
        const minEntry = members.find(n => getEntryDate(n) === minD);
        const maxEntry = members.find(n => getEntryDate(n) === maxD);
        // Estrai solo il primo numero da ogni stringa data per il range compatto
        const minRaw = minEntry ? (getEntryByName(minEntry)?.data || '') : '';
        const maxRaw = maxEntry ? (getEntryByName(maxEntry)?.data || '') : '';
        const minNum = (minRaw.match(/(-?\d+)/) || [null, minD])[1];
        const maxNum = (maxRaw.match(/(-?\d+)/) || [null, maxD])[1];
        dateRange = String(minNum) === String(maxNum) ? String(minNum) : `${minNum} – ${maxNum}`;
      }
    }

    return `<button class="camp-group-btn" onclick="showCampionatoGroup('${g}')"
      style="border-color:${full ? cfg.color : 'var(--border)'}">
      <span class="camp-group-letter" style="color:${cfg.color}">Group ${g}</span>
      <span class="camp-group-count" style="color:${full ? cfg.color : '#8080a0'}">${count} / ${cfg.max}</span>
      ${dateRange ? `<span class="camp-group-date-range">${dateRange}</span>` : ''}
    </button>`;
  }).join('');

  if (grid.dataset.padding) {
    grid.querySelectorAll('.camp-group-btn').forEach(btn => {
      btn.style.padding = grid.dataset.padding;
    });
  }

  // Mostra il pannello aggiunta solo per Tier D
  const groupView = document.getElementById('campionatoGroupView');
  const groupAddPanel = document.querySelector('#campionatoGroupView .camp-add-panel');
  const showGroupPanel = (tier === 'D');
  if (groupAddPanel) groupAddPanel.style.display = showGroupPanel ? '' : 'none';
  if (groupView) groupView.classList.toggle('split-view', showGroupPanel);

  if (showGroupPanel) renderGroupAddPanel();
}

/* ── SCORES — getter centralizzato ───────────────────────── */
const TIER_SCORE_KEY  = { S: '_sScores',         A: '_aScores'         };
const TIER_ORDER_KEY  = { S: '_matchdayOrder',    A: '_aMatchdayOrder'  };
const TIER_RESULTS_KEY= { S: '_matchdayResults',  A: '_aMatchdayResults'};

function getScores(tier) {
  return campionatoData[TIER_SCORE_KEY[tier]] || {};
}

/* ── DOM helper ───────────────────────────────────────────── */
function _makeEl(tag, cls, text, style) {
  const e = document.createElement(tag);
  if (cls)   e.className    = cls;
  if (text)  e.textContent  = text;
  if (style) e.style.cssText = style;
  return e;
}

/** Wrapper immagine con fallback placeholder — usato in tutti gli slot bracket */
function _makeSlotImg(entry, wrapCls = 'swiss-slot-img') {
  const wrap = _makeEl('div', wrapCls);
  if (imgSrc(entry)) {
    const img = _makeEl('img');
    img.src = imgSrc(entry); img.loading = 'lazy';
    img.onerror = () => { wrap.innerHTML = '<span class="swiss-slot-img-ph"></span>'; };
    wrap.appendChild(img);
  } else {
    wrap.innerHTML = '<span class="swiss-slot-img-ph"></span>';
  }
  return wrap;
}

/* ── Hover helper per righe con colori personalizzati ── */
function campRowHover(el, isHover) {
  el.style.cssText = isHover ? el.dataset.hoverStyle : el.dataset.baseStyle;
}

/* ── RENDER TIER VIEW ─────────────────────────────────────── */

/**
 * Aggiorna tutti gli elementi "chrome" della tier view:
 * label header, season label, frecce nav, pannello aggiunta, legenda, pulsante matchday.
 * Chiamato da renderCampionatoTier dopo aver calcolato la lista.
 */
function _renderTierChrome(tier, group) {
  const cfg = TIER_CONFIG[tier];

  // ── Header label e colore ──
  const labelEl = document.getElementById('campionatoTierLabel');
  if (labelEl) {
    labelEl.textContent = cfg.type === 'grouped'
      ? `TIER ${tier} — GROUP ${group}`
      : tier === 'NE' ? getCurrentSeasonLabel() : `TIER ${tier}`;
    labelEl.style.color = cfg.color;
  }
  const seasonLabelEl = document.getElementById('campTierSeasonLabel');
  if (seasonLabelEl) seasonLabelEl.textContent = tier !== 'NE' ? getCurrentSeasonLabel() : '';

  // ── Frecce navigazione gruppi e pannello aggiunta ──
  const tierView = document.getElementById('campionatoTierView');
  const addPanel = document.querySelector('#campionatoTierView .camp-add-panel');
  const btnPrev  = document.getElementById('campNavPrev');
  const btnNext  = document.getElementById('campNavNext');
  const lblNav   = document.getElementById('campNavLabel');

  if (cfg.type === 'grouped') {
    if (addPanel) addPanel.style.display = 'none';
    if (tierView) tierView.classList.remove('split-view');
    const idx = cfg.groups.indexOf(group);
    if (btnPrev) { btnPrev.style.display = 'flex'; btnPrev.disabled = idx <= 0; }
    if (btnNext) { btnNext.style.display = 'flex'; btnNext.disabled = idx >= cfg.groups.length - 1; }
    if (lblNav)  lblNav.textContent = `Group ${group} (${idx + 1} / ${cfg.groups.length})`;
  } else {
    if (btnPrev) btnPrev.style.display = 'none';
    if (btnNext) btnNext.style.display = 'none';
    const showPanel = (tier === 'D' || tier === 'NE');
    if (addPanel) addPanel.style.display = showPanel ? '' : 'none';
    if (tierView) tierView.classList.toggle('split-view', showPanel);
  }

  // ── Legenda pills ──
  const legendEl = document.getElementById('campTierLegend');
  if (legendEl) {
    const pill = (cls, dot, label) =>
      `<span class="camp-legend-pill ${cls}"><span class="camp-legend-dot" style="background:${dot}"></span>${label}</span>`;
    const pillColor = (dot, label) =>
      `<span class="camp-legend-pill" style="border-color:${dot}40;background:${dot}14;color:${dot}"><span class="camp-legend-dot" style="background:${dot}"></span>${label}</span>`;

    const LEGEND_MAP = {
      S:  () => [pill('champ','#f5c842','1° Campione'), pill('relg','#ff5050','Ultimi 4 → A')],
      A:  () => [pill('prom','#42e8a0','Top 3 → S'),   pill('relg','#ff5050','Ultimi 5 → B')],
      B:  () => [],
      C:  () => group ? [] : [pill('prom','#42e8a0','Vincitore → B'), pill('relg','#ff5050','5 eliminati → D (Silver)')],
      D:  () => [pill('prom','#42e8a0','1° del gruppo → C')],
      NE: () => [
        pillColor('#f5c842','1° → S'), pillColor('#42e8a0','2° → A'),
        pillColor('#60a8ff','3°–6° → B'), pillColor('#7c6fff','7°–18° → C'),
        pillColor('#ff6ba0','19°+ → D'),
      ],
    };
    legendEl.innerHTML = (LEGEND_MAP[tier] ? LEGEND_MAP[tier]() : []).join('');
  }

  // ── Pulsante Matchday (S/A) e Swiss System (Tier B gruppi) ──
  const matchdayWrap = document.getElementById('campMatchdayBtnWrap');
  if (matchdayWrap) {
    if (tier === 'S') {
      matchdayWrap.innerHTML = `<button class="camp-legend-matchday-btn" onclick="matchdayOpen()">${_SVG_CALENDAR} MATCHDAY</button>`;
    } else if (tier === 'A') {
      matchdayWrap.innerHTML = `<button class="camp-legend-matchday-btn" style="border-color:rgba(66,232,160,.5);color:#42e8a0" onclick="matchdayOpenA()">${_SVG_CALENDAR} MATCHDAY</button>`;
    } else if (tier === 'B' && group !== null) {
      matchdayWrap.innerHTML = `<button class="camp-legend-swiss-btn" onclick="swissOpenGroup('${group}')">${_SVG_SWISS} SWISS SYSTEM</button><button class="camp-legend-swiss-btn camp-legend-knock-btn" onclick="swissOpenGroup('${group}');setTimeout(()=>swissShowTab('knock'),100)">${_SVG_KNOCK} KNOCKOUT</button>`;
    } else if (tier === 'C' && group !== null) {
      matchdayWrap.innerHTML = `<button class="camp-legend-swiss-btn camp-legend-knock-btn" style="border-color:rgba(124,111,255,.5);color:#7c6fff" onclick="tierCOpenGroup('${group}')">${_SVG_KNOCK} MAIN BRACKET</button><button class="camp-legend-swiss-btn" style="border-color:rgba(180,180,210,.4);color:#b4b4d2" onclick="tierCOpenGroup('${group}');setTimeout(()=>tierCShowPanel('silver'),100)">${_SVG_SILVER} SILVER BRACKET</button>`;
    } else {
      matchdayWrap.replaceChildren();
    }
  }
}

function renderCampionatoTier() {
  const tier  = campionatoUI.currentTier;
  const cfg   = TIER_CONFIG[tier];
  const group = campionatoUI.currentGroup;

  // ── Lista da mostrare ──
  let displayList;
  if (cfg.type === 'grouped') {
    displayList = (distributeGroups(tier)[group]) || [];
  } else {
    displayList = TIER_SCORE_KEY[tier]
      ? getTierSorted(tier)
      : (campionatoData[tier] || []);
  }

  const counterEl = document.getElementById('campionatoTierCounter');
  if (counterEl) counterEl.textContent = '';

  // ── Chrome (header, nav, pannello, legenda, matchday btn) ──
  _renderTierChrome(tier, group);

  // ── Lista e pannello aggiunta ──
  const pr           = getPromotedRelegated(tier, group);
  const fullyEditable = (tier === 'D' || tier === 'NE');
  const noDrag       = (tier === 'S' || tier === 'A') && group === null || (tier === 'B' && group !== null) || (tier === 'C' && group !== null);
  renderTierList(displayList, noDrag, pr.promoted, pr.relegated, fullyEditable, pr.promotedColor || {});
  if (typeof campAudioInjectUI === 'function') campAudioInjectUI();
  if (cfg.type !== 'grouped') renderAddPanel();
}

/* ── PROMOZIONI / RETROCESSIONI ──────────────────────────── */
/**
 * Restituisce { promoted: Set, relegated: Set } per un tier/gruppo.
 * I nomi nei set sono quelli che salgono (verde) o scendono (rosso).
 */
function getPromotedRelegated(tier, group) {
  const promoted  = new Set();
  const relegated = new Set();

  if (tier === 'S') {
    getTierSSorted().slice(-4).forEach(n => relegated.add(n));

  } else if (tier === 'A') {
    const list = getTierASorted();
    list.slice(0, 3).forEach(n => promoted.add(n));
    list.slice(-5).forEach(n => relegated.add(n));

  } else if (tier === 'B' || tier === 'C' || tier === 'D') {
    if (tier === 'B' && group) {
      const winner = _swissGetKnockWinner(group);
      if (winner) promoted.add(winner);
      const relg = _swissGetRelegated5(group);
      relg.forEach(n => relegated.add(n));
    } else if (tier === 'C' && group) {
      const champion = _knockCGetChampion(group);
      if (champion) promoted.add(champion);
      const relg = _knockCGetRelegated(group);
      relg.forEach(n => relegated.add(n));
    } else {
      const grp = (distributeGroups(tier)[group]) || [];
      if (grp.length > 0) promoted.add(grp[0]);
      if (tier !== 'D') grp.slice(-Math.min(5, grp.length)).forEach(n => relegated.add(n));
    }
    promoted.forEach(n => relegated.delete(n));

  } else if (tier === 'NE') {
    (campionatoData['NE'] || []).forEach((n, i) => promoted.add(n));
  }

  // Per NE costruiamo anche una mappa nome→colore destinazione
  const promotedColor = {};
  if (tier === 'NE') {
    const NE_SLOTS = [
      { from: 0,  to: 0,  dest: 'S' },
      { from: 1,  to: 1,  dest: 'A' },
      { from: 2,  to: 5,  dest: 'B' },
      { from: 6,  to: 17, dest: 'C' },
      { from: 18, to: Infinity, dest: 'D' },
    ];
    (campionatoData['NE'] || []).forEach((n, i) => {
      const slot = NE_SLOTS.find(s => i >= s.from && i <= s.to);
      if (slot) promotedColor[n] = TIER_CONFIG[slot.dest].color;
    });
  }

  return { promoted, relegated, promotedColor };
}

function getTierSorted(tier) {
  const list   = campionatoData[tier] || [];
  const scores = getScores(tier);
  return [...list].sort((a, b) => {
    const sa = scores[a] !== undefined ? scores[a] : -Infinity;
    const sb = scores[b] !== undefined ? scores[b] : -Infinity;
    if (sb !== sa) return sb - sa;
    return list.indexOf(a) - list.indexOf(b);
  });
}
function getTierSSorted() { return getTierSorted('S'); }
function getTierASorted() { return getTierSorted('A'); }

function campionatoSetScore(name, value) {
  if (!window._RANKIFY_IS_ADMIN) return;
  if (!campionatoData._sScores) campionatoData._sScores = {};
  const scores = campionatoData._sScores;
  const v = parseFloat(value);
  if (isNaN(v)) { delete scores[name]; }
  else          { scores[name] = v; }
  campionatoSave();
  _rerenderRankedTier('S');
}

function _rerenderRankedTier(tier) {
  if (campionatoUI.currentTier !== tier) return;
  const pr     = getPromotedRelegated(tier, null);
  const sorted = getTierSorted(tier);

  // Prova patch differenziale: aggiorna solo punteggi e classi senza ricostruire il DOM
  const el = document.getElementById('campionatoRankList');
  const existingRows = el ? el.querySelectorAll('.camp-rank-row[data-name]') : [];

  // Verifica che l'ordine e il numero di righe corrispondano — se no, rebuild completo
  const namesMatch = existingRows.length === sorted.length &&
    [...existingRows].every((row, i) => row.dataset.name === sorted[i]);

  if (!namesMatch) {
    renderTierList(sorted, true, pr.promoted, pr.relegated, false, pr.promotedColor || {});
    if (typeof campAudioInjectUI === 'function') campAudioInjectUI();
    return;
  }

  // Patch: aggiorna solo i valori che cambiano
  const scores    = getScores(tier);
  const tierColor = tier === 'A' ? '66,232,160' : null;
  const rankColors = { 1: '#f5c842', 2: '#b0b8c8', 3: '#cd7f32' };

  existingRows.forEach((row, i) => {
    const name      = sorted[i];
    const rank      = i + 1;
    const isRelg    = pr.relegated.has(name);
    const isProm    = pr.promoted.has(name);
    const scoreVal  = scores[name] !== undefined ? scores[name] : '';

    // Aggiorna punteggio
    const scoreEl = row.querySelector('.camp-s-score-input');
    if (scoreEl) scoreEl.textContent = scoreVal !== '' ? scoreVal : '—';

    // Aggiorna colore numero rank
    const numEl = row.querySelector('.camp-rank-num');
    if (numEl) {
      let numColor = rankColors[rank] || '#50506a';
      if (isRelg) numColor = '#ff5050';
      else if (isProm && !rankColors[rank]) numColor = tierColor ? `rgb(${tierColor})` : '#42e8a0';
      numEl.style.color = numColor;
    }

    // Aggiorna classi e stili bordo/sfondo
    let rowClass = 'camp-rank-row tier-s-row';
    let rowStyle = '';
    let hoverStyle = '';

    if (isRelg) {
      rowClass  += ' camp-row-relegated';
      rowStyle   = 'border-color:rgba(255,80,80,.5);background:rgba(255,80,80,.06);';
      hoverStyle = 'border-color:rgba(255,80,80,.8);background:rgba(255,80,80,.14);';
    } else if (isProm) {
      rowClass  += ' camp-row-promoted';
      rowStyle   = tierColor
        ? `border-color:rgba(${tierColor},.5);background:rgba(${tierColor},.06);`
        : 'border-color:rgba(66,232,160,.5);background:rgba(66,232,160,.06);';
      hoverStyle = tierColor
        ? `border-color:rgba(${tierColor},.8);background:rgba(${tierColor},.14);`
        : 'border-color:rgba(66,232,160,.8);background:rgba(66,232,160,.14);';
    } else if (i < 3 && !tierColor) {
      rowClass  += ` camp-s-podium-rank${rank}`;
      hoverStyle = 'border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.04);';
    } else {
      hoverStyle = 'border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.04);';
    }

    row.className = rowClass;
    row.style.cssText = rowStyle;
    row.dataset.baseStyle  = rowStyle;
    row.dataset.hoverStyle = rowStyle + hoverStyle;
  });
}
function _rerenderTierSList() { _rerenderRankedTier('S'); }
function _rerenderTierAList() { _rerenderRankedTier('A'); }


function renderTierList(list, readOnly, promoted = new Set(), relegated = new Set(), fullyEditable = false, promotedColor = {}) {
  const el = document.getElementById('campionatoRankList');
  if (!el) return;

  const isTierS = (campionatoUI.currentTier === 'S' && campionatoUI.currentGroup === null);
  const isTierA = (campionatoUI.currentTier === 'A' && campionatoUI.currentGroup === null);

  // Per tutti i tier la griglia a 2 colonne rimane invariata
  el.classList.remove('tier-s-list');
  const rows = Math.ceil(list.length / 2);
  el.style.gridTemplateRows = rows > 0 ? `repeat(${rows}, auto)` : '';

  if (!list || list.length === 0) {
    el.innerHTML = `<div class="camp-empty-state">
      <div class="camp-empty-icon">🏆</div>
      <div class="camp-empty-text">Nessun opening in questa classifica</div>
      ${readOnly ? '' : '<div class="camp-empty-sub">Cerca e aggiungi opening dal pannello a destra</div>'}
    </div>`;
    return;
  }

  const rankColors = { 1: '#f5c842', 2: '#b0b8c8', 3: '#cd7f32' };

  // ── Tier S e A: render con punteggi, podio e no-drag ──
  if (isTierS || isTierA) {
    const tier    = campionatoUI.currentTier;
    const scores  = getScores(tier);
    // Tier A: i top 3 hanno bordo verde (colore tier); Tier S: nessun bordo speciale
    const tierColor = isTierA ? '66,232,160' : null;

    const podiumHTML = list.slice(0, 3).map((name, idx) => {
      const rank     = idx + 1;
      const entry    = getEntryByName(name);
      const imgVal   = entry ? (imgSrc(entry) || '') : '';
      const dateVal  = entry && entry.data ? entry.data : '—';
      const isRelg   = relegated.has(name);
      const scoreVal = scores[name] !== undefined ? scores[name] : '';
      const numColor = isRelg ? '#ff5050' : rankColors[rank];

      let rowClass = `camp-rank-row tier-s-row`;
      let rowStyle = '';
      if (isRelg) {
        rowClass += ' camp-row-relegated';
        rowStyle  = 'border-color:rgba(255,80,80,.5);background:rgba(255,80,80,.06);';
      } else if (tierColor) {
        rowClass += ' camp-row-promoted';
        rowStyle  = `border-color:rgba(${tierColor},.5);background:rgba(${tierColor},.06);`;
      } else {
        rowClass += ` camp-s-podium-rank${rank}`;
      }

      return `<div class="${rowClass}" style="${rowStyle}" data-name="${escapeHtml(name)}">
        <div class="camp-rank-num" style="color:${numColor}">${rank}</div>
        <div class="camp-rank-img">${imgVal ? `<img src="${escapeHtml(imgVal)}"  loading="lazy" onerror="this.style.display='none'"/>` : '<div class="camp-rank-img-placeholder">🎵</div>'}</div>
        <div class="camp-rank-info"><div class="camp-rank-name">${escapeHtml(name)}</div><div class="camp-rank-date">${escapeHtml(dateVal)}</div></div>
        <div class="camp-s-score-wrap">
          <div class="camp-s-score-input" style="pointer-events:none">${scoreVal !== '' ? scoreVal : '—'}</div>
        </div>
      </div>`;
    }).join('');

    const restHTML = list.slice(3).map((name, i) => {
      const idx      = i + 3;
      const entry    = getEntryByName(name);
      const imgVal   = entry ? (imgSrc(entry) || '') : '';
      const dateVal  = entry && entry.data ? entry.data : '—';
      const isRelg   = relegated.has(name);
      const isProm   = promoted.has(name);
      const scoreVal = scores[name] !== undefined ? scores[name] : '';

      let rankColor = '#50506a';
      if (isRelg)      rankColor = '#ff5050';
      else if (isProm) rankColor = tierColor ? `rgb(${tierColor})` : '#42e8a0';

      let rowClass = 'camp-rank-row tier-s-row';
      let rowStyle = '';
      if (isProm)  { rowClass += ' camp-row-promoted'; rowStyle = tierColor ? `border-color:rgba(${tierColor},.5);background:rgba(${tierColor},.06);` : 'border-color:rgba(66,232,160,.5);background:rgba(66,232,160,.06);'; }
      if (isRelg)  { rowClass += ' camp-row-relegated'; rowStyle = 'border-color:rgba(255,80,80,.5);background:rgba(255,80,80,.06);'; }

      const hoverStyle = isRelg ? 'border-color:rgba(255,80,80,.8);background:rgba(255,80,80,.14);'
                       : isProm ? (tierColor ? `border-color:rgba(${tierColor},.8);background:rgba(${tierColor},.14);` : 'border-color:rgba(66,232,160,.8);background:rgba(66,232,160,.14);')
                       : 'border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.04);';

      return `<div class="${rowClass}" style="${rowStyle}"
        data-name="${escapeHtml(name)}" data-base-style="${rowStyle}" data-hover-style="${rowStyle}${hoverStyle}" onmouseover="campRowHover(this,true)" onmouseout="campRowHover(this,false)">
        <div class="camp-rank-num" style="color:${rankColor}">${idx + 1}</div>
        <div class="camp-rank-img">${imgVal ? `<img src="${escapeHtml(imgVal)}"  loading="lazy" onerror="this.style.display='none'"/>` : '<div class="camp-rank-img-placeholder">🎵</div>'}</div>
        <div class="camp-rank-info"><div class="camp-rank-name">${escapeHtml(name)}</div><div class="camp-rank-date">${escapeHtml(dateVal)}</div></div>
        <div class="camp-s-score-wrap">
          <div class="camp-s-score-input" style="pointer-events:none">${scoreVal !== '' ? scoreVal : '—'}</div>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = `<div class="camp-s-podium-wrapper">${podiumHTML}</div>${restHTML}`;
    return;
  }
  const rankColorsFull = {};
  el.innerHTML = list.map((name, idx) => {
    const entry     = getEntryByName(name);
    const imgVal    = entry ? (imgSrc(entry) || '') : '';
    const dateVal   = entry && entry.data ? entry.data : '—';
    let rankColor = rankColorsFull[idx+1] || '#50506a';
    if (relegated.has(name)) rankColor = '#ff5050';
    if (promoted.has(name) && !rankColorsFull[idx+1]) rankColor = promotedColor[name] || '#42e8a0';
    const ns        = escapeHtml(name);

    let rowClass = readOnly ? 'read-only' : '';
    let rowStyle = '';
    const pColor = promotedColor[name];
    if (promoted.has(name))  {
      rowClass += ' camp-row-promoted';
      const c = pColor || '#42e8a0';
      const r = parseInt(c.slice(1,3),16), g2 = parseInt(c.slice(3,5),16), b2 = parseInt(c.slice(5,7),16);
      rowStyle = `border-color:rgba(${r},${g2},${b2},.5);background:rgba(${r},${g2},${b2},.06);`;
    }
    if (relegated.has(name)) { rowClass += ' camp-row-relegated'; rowStyle = 'border-color:rgba(255,80,80,.5);background:rgba(255,80,80,.06);'; }

    let hoverStyle = '';
    if (promoted.has(name)) {
      const c = pColor || '#42e8a0';
      const r = parseInt(c.slice(1,3),16), g2 = parseInt(c.slice(3,5),16), b2 = parseInt(c.slice(5,7),16);
      hoverStyle = `border-color:rgba(${r},${g2},${b2},.8);background:rgba(${r},${g2},${b2},.14);`;
    }
    if (relegated.has(name)) {
      hoverStyle = 'border-color:rgba(255,80,80,.8);background:rgba(255,80,80,.14);';
    }
    // Hover di default per righe read-only senza colore speciale (es. Tier B gruppi)
    if (readOnly && !hoverStyle) {
      hoverStyle = 'border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.04);';
    }

    const draggable = !readOnly;
    return `<div class="camp-rank-row ${rowClass}" style="${rowStyle}"
        ${hoverStyle ? `data-base-style="${rowStyle}" data-hover-style="${rowStyle}${hoverStyle}" onmouseover="campRowHover(this,true)" onmouseout="campRowHover(this,false)"` : ''}
        ${draggable ? `draggable="true"
        data-name="${ns}"
        data-idx="${idx}"
        ondragstart="campDragStart(event,'${ns}')"
        ondragover="campDragOver(event,${idx})"
        ondrop="campDrop(event,${idx})"
        ondragend="campDragEnd()"` : ''}>
      <div class="camp-rank-num" style="color:${rankColor}">${idx+1}</div>
      <div class="camp-rank-img">${imgVal ? `<img src="${escapeHtml(imgVal)}"  loading="lazy" onerror="this.style.display='none'"/>` : '<div class="camp-rank-img-placeholder">🎵</div>'}</div>
      <div class="camp-rank-info"><div class="camp-rank-name">${ns}</div><div class="camp-rank-date">${escapeHtml(dateVal)}</div></div>
      ${fullyEditable ? `<div class="camp-rank-actions">
        <button class="camp-action-btn camp-remove-btn" onclick="campionatoRemove('${ns}')" title="Rimuovi">✕</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

function renderAddPanel() {
  const tier  = campionatoUI.currentTier;
  const cfg   = TIER_CONFIG[tier];
  const list  = campionatoData[tier] || [];
  const maxTotal = cfg.type === 'grouped' ? cfg.groups.length * cfg.max : cfg.max;
  const usedSet = new Set(getAllUsedNames());
  const opens = getOpenings();
  const q     = campionatoUI.searchQuery.trim().toLowerCase();
  const avail = opens.filter(e =>
    !usedSet.has(e.name) &&
    (!q || e.name.toLowerCase().includes(q))
  );

  const el = document.getElementById('campionatoAddResults');
  if (!el) return;

  if (maxTotal !== Infinity && list.length >= maxTotal) { el.innerHTML = `<div class="camp-add-full">Tier pieno (${list.length}/${maxTotal})</div>`; return; }
  if (opens.length === 0)      { el.innerHTML = `<div class="camp-add-empty">Nessun opening nel database.</div>`; return; }
  if (avail.length === 0)      { el.innerHTML = `<div class="camp-add-empty">${q ? 'Nessun risultato' : 'Tutti gli opening sono già assegnati'}</div>`; return; }

  el.innerHTML = avail.slice(0,60).map(e => {
    const ns   = escapeHtml(e.name);
    const date = e.data ? ` <span style="color:#8080a0;font-size:11px">(${escapeHtml(e.data)})</span>` : '';
    return `<div class="camp-add-row" onclick="campionatoAdd('${ns}')">
      <div class="camp-add-img">${imgSrc(e) ? `<img src="${escapeHtml(imgSrc(e))}"  loading="lazy" onerror="this.style.display='none'"/>` : '<div class="camp-rank-img-placeholder">🎵</div>'}</div>
      <div class="camp-add-name">${ns}${date}</div>
      <div class="camp-add-plus">＋</div>
    </div>`;
  }).join('');
}

/* ── TIER VIEW per tier grouped: mostra lista del tier completa ─ */
/* ── AZIONI ───────────────────────────────────────────────── */
function campionatoAdd(name) {
  if (!window._RANKIFY_IS_ADMIN) return;
  const tier = campionatoUI.currentTier;
  const cfg  = TIER_CONFIG[tier];
  const list = campionatoData[tier];
  const maxTotal = cfg.type === 'grouped' ? cfg.groups.length * cfg.max : cfg.max;

  if (list.includes(name)) return;
  if (maxTotal !== Infinity && list.length >= maxTotal) {
    if (typeof toast==='function') toast(`Tier ${tier} è pieno`, 'error');
    return;
  }
  list.push(name);
  campionatoSave();
  renderCampionatoTier();
  if (cfg.type === 'grouped' && typeof toast === 'function') {
    // Mostra in quale gruppo è finito
    const dist = distributeGroups(tier);
    for (const [g, members] of Object.entries(dist)) {
      if (members.includes(name)) {
        toast(`Aggiunto in Group ${g}`, 'success');
        break;
      }
    }
  }
}

function campionatoRemove(name) {
  if (!window._RANKIFY_IS_ADMIN) return;
  // Rimuovi da tier semplice (S/A)
  campionatoData[campionatoUI.currentTier] = campionatoData[campionatoUI.currentTier].filter(x => x !== name);
  campionatoSave();
  renderCampionatoTier();
}

function campionatoRemoveFromTier(name) {
  if (!window._RANKIFY_IS_ADMIN) return;
  campionatoData[campionatoUI.currentTier] = campionatoData[campionatoUI.currentTier].filter(x => x !== name);
  campionatoSave();
  renderGroupPicker();
  renderCampionatoTier();
}



/* ── DRAG & DROP (solo tier semplici) ────────────────────── */
function campDragStart(event, name) {
  campionatoUI.dragName = name;
  event.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    const row = document.querySelector(`.camp-rank-row[data-name="${name}"]`);
    if (row) row.classList.add('dragging');
  }, 0);
}

function campDragOver(event, idx) {
  event.preventDefault();
  document.querySelectorAll('.camp-rank-row, .camp-s-podium-slot').forEach((r,i) => r.classList.toggle('drag-over', i===idx));
}

function campDrop(event, idx) {
  event.preventDefault();
  if (!window._RANKIFY_IS_ADMIN) return;
  if (!campionatoUI.dragName) return;
  const list = campionatoData[campionatoUI.currentTier];
  if (idx < 0 || idx >= list.length) return;
  const from = list.indexOf(campionatoUI.dragName);
  if (from === -1 || from === idx) return;
  list.splice(from, 1);
  list.splice(idx, 0, campionatoUI.dragName);
  campionatoSave();
  renderCampionatoTier();
}

function campDragEnd() {
  campionatoUI.dragName = null;
  document.querySelectorAll('.camp-rank-row, .camp-s-podium-slot').forEach(r => r.classList.remove('dragging','drag-over'));
}

/* ── STAGIONE SUCCESSIVA → vedi fondo file ── */

/* ── NAVIGAZIONE GRUPPI ──────────────────────────────────── */
function campionatoNavGroup(dir) {
  const cfg = TIER_CONFIG[campionatoUI.currentTier];
  const idx = cfg.groups.indexOf(campionatoUI.currentGroup);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= cfg.groups.length) return;
  campionatoUI.currentGroup = cfg.groups[newIdx];
  renderCampionatoTier();
}

/* ── SEARCH ───────────────────────────────────────────────── */
function campionatoSearch(val) { campionatoUI.searchQuery = val; renderAddPanel(); }

function campionatoGroupSearch(val) { campionatoUI.groupSearchQuery = val; renderGroupAddPanel(); }

function renderGroupAddPanel() {
  const tier     = campionatoUI.currentTier;
  const cfg      = TIER_CONFIG[tier];
  const list     = campionatoData[tier] || [];
  const maxTotal = cfg.groups.length * cfg.max;
  const usedSet  = new Set(getAllUsedNames());
  const opens    = getOpenings();
  const q        = campionatoUI.groupSearchQuery.trim().toLowerCase();
  const avail    = opens.filter(e =>
    !usedSet.has(e.name) &&
    (!q || e.name.toLowerCase().includes(q))
  );

  const el      = document.getElementById('campGroupAddResults');
  const counter = document.getElementById('campGroupCounter');
  if (counter) counter.textContent = `${list.length} / ${maxTotal}`;
  if (!el) return;

  if (list.length >= maxTotal) { el.innerHTML = `<div class="camp-add-full">Tier pieno (${list.length}/${maxTotal})</div>`; return; }
  if (opens.length === 0)      { el.innerHTML = `<div class="camp-add-empty">Nessun opening nel database.</div>`; return; }
  if (avail.length === 0)      { el.innerHTML = `<div class="camp-add-empty">${q ? 'Nessun risultato' : 'Tutti gli opening sono già assegnati'}</div>`; return; }

  el.innerHTML = avail.slice(0, 60).map(e => {
    const ns   = escapeHtml(e.name);
    const date = e.data ? ` <span style="color:#8080a0;font-size:11px">(${escapeHtml(e.data)})</span>` : '';
    return `<div class="camp-add-row" onclick="campionatoAddToGroupedTier('${ns}')">
      <div class="camp-add-img">${imgSrc(e) ? `<img src="${escapeHtml(imgSrc(e))}"  loading="lazy" onerror="this.style.display='none'"/>` : '<div class="camp-rank-img-placeholder">🎵</div>'}</div>
      <div class="camp-add-name">${ns}${date}</div>
      <div class="camp-add-plus">＋</div>
    </div>`;
  }).join('');
}

function campionatoAddToGroupedTier(name) {
  if (!window._RANKIFY_IS_ADMIN) return;
  const tier     = campionatoUI.currentTier;
  const cfg      = TIER_CONFIG[tier];
  const list     = campionatoData[tier];
  const maxTotal = cfg.groups.length * cfg.max;

  if (list.includes(name)) return;
  if (list.length >= maxTotal) { if (typeof toast === 'function') toast(`Tier ${tier} è pieno`, 'error'); return; }

  list.push(name);
  campionatoSave();

  // Mostra in quale gruppo è finito
  const dist = distributeGroups(tier);
  for (const [g, members] of Object.entries(dist)) {
    if (members.includes(name)) {
      if (typeof toast === 'function') toast(`Aggiunto → Group ${g}`, 'success');
      break;
    }
  }
  renderGroupPicker();
  renderGroupAddPanel();
}

/* ── STAGIONE SUCCESSIVA — PREVIEW MODAL ────────────────── */
function _calcolaMovimenti() {
  const data = campionatoData;
  const s_down = getTierSSorted().slice(-4);
  const a_sorted = getTierASorted();
  const a_up   = a_sorted.slice(0, 3);
  const a_down = a_sorted.slice(-5);
  const distB = distributeGroups('B');
  const b_up = [], b_down = [];
  for (const g of TIER_CONFIG['B'].groups) {
    const grp = distB[g] || [];
    const winner = _swissGetKnockWinner(g);
    if (winner) b_up.push(winner);
    else if (grp.length > 0) b_up.push(grp[0]);
    const relg = _swissGetRelegated5(g);
    if (relg.length > 0) b_down.push(...relg);
    else b_down.push(...grp.slice(-Math.min(5, grp.length)));
  }
  const distC = distributeGroups('C');
  const c_up = [], c_down = [];
  for (const g of TIER_CONFIG['C'].groups) {
    const grp = distC[g] || [];
    // Usa il vincitore reale del knockout se disponibile
    const winner = _knockCGetChampion(g);
    if (winner) c_up.push(winner);
    else if (grp.length > 0) c_up.push(grp[0]);
    const relg = _knockCGetRelegated(g);
    if (relg.length > 0) c_down.push(...relg);
    else c_down.push(...grp.slice(-Math.min(5, grp.length)));
  }
  const distD = distributeGroups('D');
  const d_up = [];
  for (const g of TIER_CONFIG['D'].groups) {
    const grp = distD[g] || [];
    if (grp.length > 0) d_up.push(grp[0]);
  }
  const ne = [...(data['NE'] || [])];
  const ne_toS = ne.slice(0, 1), ne_toA = ne.slice(1, 2),
        ne_toB = ne.slice(2, 6), ne_toC = ne.slice(6, 18), ne_toD = ne.slice(18);
  const b_remove = new Set([...b_up, ...b_down]);
  const c_remove = new Set([...c_up, ...c_down]);
  const newS = data['S'].slice(0, -4).concat(a_up, ne_toS);
  const newA = data['A'].slice(3, data['A'].length - 5).concat(s_down, b_up, ne_toA);
  const newB = data['B'].filter(n => !b_remove.has(n)).concat(a_down, c_up, ne_toB);
  const newC = data['C'].filter(n => !c_remove.has(n)).concat(b_down, d_up, ne_toC);
  const newD = data['D'].filter(n => !d_up.includes(n)).concat(c_down, ne_toD);
  return { s_down, a_up, a_down, b_up, b_down, c_up, c_down, d_up,
           ne_toS, ne_toA, ne_toB, ne_toC, ne_toD,
           newS, newA, newB, newC, newD };
}

function campionatoStagioneSuccessiva() {
  const gruppiIncompleti = TIER_CONFIG['B'].groups.filter(g => !_swissGetKnockWinner(g) && (campionatoData['B'] || []).length > 0);
  const gruppiCIncompleti = TIER_CONFIG['C'].groups.filter(g => !_knockCIsTournamentComplete(g) && (campionatoData['C'] || []).length > 0 && (() => { const dist = distributeGroups('C'); return (dist[g]||[]).length > 0; })());
  if (gruppiIncompleti.length > 0 || gruppiCIncompleti.length > 0) {
    const modal = document.getElementById('campSeasonModal');
    const idx = (campionatoData._seasonIdx || 0) + 1;
    const year = SEASON_START.year + Math.floor((idx + SEASONS.indexOf(SEASON_START.name)) / SEASONS.length);
    const next = SEASONS[(idx + SEASONS.indexOf(SEASON_START.name)) % SEASONS.length] + ' ' + year;
    modal.querySelector('.csm-header-slot').innerHTML = `Avanzare a <strong>${next}</strong>?`;
    modal.querySelector('.csm-movements').innerHTML =
      `<div style="text-align:center;padding:24px 16px;color:var(--text-muted);">
        <div style="font-size:28px;margin-bottom:12px;">⏳</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:.08em;color:#ff6b35;margin-bottom:8px;">STAGIONE IN CORSO</div>
        <div style="font-size:13px;line-height:1.6;">I seguenti gruppi non hanno ancora un vincitore del knockout:<br>
        ${gruppiIncompleti.length > 0 ? `<strong style="color:#60a8ff">Tier B: ${gruppiIncompleti.map(g => 'Group ' + g).join(', ')}</strong><br>` : ''}
        ${gruppiCIncompleti.length > 0 ? `<strong style="color:#7c6fff">Tier C: ${gruppiCIncompleti.map(g => 'Group ' + g).join(', ')}</strong><br>` : ''}
        <br>Completa il torneo prima di avanzare alla stagione successiva.</div>
      </div>`;
    modal.querySelector('.csm-totals-grid').innerHTML = '';
    const confirmBtn = modal.querySelector('.csm-confirm-btn');
    if (confirmBtn) confirmBtn.style.display = 'none';
    modal.classList.add('open');
    return;
  }
  const modal0 = document.getElementById('campSeasonModal');
  const confirmBtn0 = modal0 ? modal0.querySelector('.csm-confirm-btn') : null;
  if (confirmBtn0) confirmBtn0.style.display = '';
  const m = _calcolaMovimenti();
  const idx = (campionatoData._seasonIdx || 0) + 1;
  const year = SEASON_START.year + Math.floor((idx + SEASONS.indexOf(SEASON_START.name)) / SEASONS.length);
  const next = SEASONS[(idx + SEASONS.indexOf(SEASON_START.name)) % SEASONS.length] + ' ' + year;

  function sec(title, color, items) {
    if (!items.length) return '';
    return `<div class="csm-section">
      <div class="csm-section-title" style="color:${color}">${title} <span class="csm-count">(${items.length})</span></div>
      <div class="csm-names">${items.map(n => `<span class="csm-name">${n}</span>`).join('')}</div>
    </div>`;
  }

  const modal = document.getElementById('campSeasonModal');
  modal.querySelector('.csm-header-slot').innerHTML = `Avanzare a <strong>${next}</strong>?`;
  modal.querySelector('.csm-movements').innerHTML =
      sec('⬆ A → S', '#f5c842', m.a_up) +
      sec('⬇ S → A', '#f5c842', m.s_down) +
      sec('⬆ B → A', '#60a8ff', m.b_up) +
      sec('⬇ A → B', '#60a8ff', m.a_down) +
      sec('⬆ C → B', '#7c6fff', m.c_up) +
      sec('⬇ B → C', '#7c6fff', m.b_down) +
      sec('⬆ D → C', '#ff6ba0', m.d_up) +
      sec('⬇ C → D', '#ff6ba0', m.c_down) +
      sec('🆕 ' + getCurrentSeasonLabel() + ' → S', '#f5c842', m.ne_toS) +
      sec('🆕 ' + getCurrentSeasonLabel() + ' → A', '#42e8a0', m.ne_toA) +
      sec('🆕 ' + getCurrentSeasonLabel() + ' → B', '#60a8ff', m.ne_toB) +
      sec('🆕 ' + getCurrentSeasonLabel() + ' → C', '#7c6fff', m.ne_toC) +
      sec('🆕 ' + getCurrentSeasonLabel() + ' → D', '#ff6ba0', m.ne_toD);
  modal.querySelector('.csm-totals-grid').innerHTML =
      `<div class="csm-total-row" style="--tc:#f5c842"><span class="csm-total-tier">S</span><span class="csm-total-count">${m.newS.length}</span></div>` +
      `<div class="csm-total-row" style="--tc:#42e8a0"><span class="csm-total-tier">A</span><span class="csm-total-count">${m.newA.length}</span></div>` +
      `<div class="csm-total-row" style="--tc:#60a8ff"><span class="csm-total-tier">B</span><span class="csm-total-count">${m.newB.length}</span></div>` +
      `<div class="csm-total-row" style="--tc:#7c6fff"><span class="csm-total-tier">C</span><span class="csm-total-count">${m.newC.length}</span></div>` +
      `<div class="csm-total-row" style="--tc:#ff6ba0"><span class="csm-total-tier">D</span><span class="csm-total-count">${m.newD.length}</span></div>`;
  modal.classList.add('open');
}

/* ── Fisher-Yates shuffle crittograficamente sicuro ── */
function _cryptoShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const max = Math.floor(0x100000000 / i) * i;
    const tmp = new Uint32Array(1);
    let r;
    do { crypto.getRandomValues(tmp); r = tmp[0]; } while (r >= max);
    [a[i], a[r % i]] = [a[r % i], a[i]];
  }
  return a;
}

function campSeasonModalConfirm() {
  document.getElementById('campSeasonModal').classList.remove('open');
  const data = campionatoData;

  // Salva i top 3 del Tier S nella Hall of Fame PRIMA dei movimenti
  const sortedS = getTierSSorted();
  const topS = sortedS.slice(0, 3);
  if (!data._hallOfFame) data._hallOfFame = [];
  const hof = {
    season: getCurrentSeasonLabel(),
    entries: topS.map(name => {
      const e = getEntryByName(name);
      return { name, imgPath: e ? (imgSrc(e) || '') : '' };
    })
  };
  data._hallOfFame.push(hof);

  const m = _calcolaMovimenti();
  const b_remove = new Set([...m.b_up, ...m.b_down]);
  const c_remove = new Set([...m.c_up, ...m.c_down]);
  // Rimuovi i retrocessi (ultimi 4 per punteggio) e aggiungi i promossi
  const sRetrocessi = new Set(m.s_down);
  const sortedA = getTierASorted();
  data['S'] = sortedS.filter(n => !sRetrocessi.has(n)).concat(m.a_up, m.ne_toS);
  const aRetrocessi = new Set(m.a_up.concat(m.a_down));
  data['A'] = sortedA.filter(n => !aRetrocessi.has(n)).concat(m.s_down, m.b_up, m.ne_toA);
  data['B'] = data['B'].filter(n => !b_remove.has(n)).concat(m.a_down, m.c_up, m.ne_toB);
  data['C'] = data['C'].filter(n => !c_remove.has(n)).concat(m.b_down, m.d_up, m.ne_toC);
  data['D'] = data['D'].filter(n => !m.d_up.includes(n)).concat(m.c_down, m.ne_toD);
  data['NE'] = [];
  Object.assign(data, {
    _sScores: {}, _aScores: {},
    _matchdayResults: {}, _matchdayOrder: _cryptoShuffle(data['S']),
    _aMatchdayResults: {}, _aMatchdayOrder: _cryptoShuffle(data['A']),
    _swissB: {}, _knockC: {}
  });
  _invalidateTurnMatchesCache();
  _invalidateRecordsCache();
  _invalidateRRCache();
  TIER_CONFIG['B'].groups.forEach(function(g) {
    const dist = distributeGroups('B');
    const p = dist[g] || [];
    if (p.length < 2) return;
    let arr, attempts = 0;
    do { arr = _cryptoShuffle(p); attempts++; }
    while (attempts < 10 && arr.some((v, i) => v === p[i]));
    data._swissB[g] = {
      turn: 0, participants: [...p], t0Order: arr,
      t0Results:{}, t1Results:{}, t2Results:{}, t3Results:{}, t4Results:{},
      kqfResults:{}, ksfResults:{}, kfResults:{}
    };
  });
  // Inizializza Knockout Tier C con bracket casuale per la nuova stagione
  TIER_CONFIG['C'].groups.forEach(function(g) {
    const dist = distributeGroups('C');
    const p = dist[g] || [];
    if (p.length < 2) return;
    data._knockC[g] = {
      participants: _cryptoShuffle(p),
      r16Results:{}, qfResults:{}, sfResults:{}, fResults:{},
      sv1Results:{}, sv2Results:{}, svfResults:{}
    };
  });
  const cfgS = TIER_CONFIG['S'], cfgA = TIER_CONFIG['A'];
  if (data['S'].length > cfgS.max) data['S'] = data['S'].slice(0, cfgS.max);
  if (data['A'].length > cfgA.max) data['A'] = data['A'].slice(0, cfgA.max);
  campionatoData._seasonIdx = (campionatoData._seasonIdx || 0) + 1;
  campionatoSave();
  campionatoUpdateMenuCounts();
  campionatoUpdateSeasonUI();
  if (typeof toast === 'function') toast(`Benvenuto in ${getCurrentSeasonLabel()}!`, 'success');
}

function campSeasonModalCancel() {
  document.getElementById('campSeasonModal').classList.remove('open');
}

/* ── ALBO D'ORO ─────────────────────────────────────────── */
function campAlboApri() {
  const hof = campionatoData._hallOfFame || [];
  const listEl  = document.getElementById('campAlboList');
  const emptyEl = document.getElementById('campAlboEmpty');
  const modal   = document.getElementById('campAlboModal');

  if (!hof.length) {
    listEl.replaceChildren();
    emptyEl.style.display = '';
  } else {
    emptyEl.style.display = 'none';
    const medals = ['gold','silver','bronze'];
    const icons  = ['🥇','🥈','🥉'];
    listEl.innerHTML = [...hof].reverse().map(row => {
      const entries = (row.entries || []).map((e, i) => {
        const img = imgSrc(e)
          ? `<img src="${escapeHtml(imgSrc(e))}"  loading="lazy" onerror="this.style.display='none'"/>`
          : '🎵';
        return `<div class="camp-albo-entry ${medals[i] || ''}">
          <span class="camp-albo-medal">${icons[i] || ''}</span>
          <div class="camp-albo-img">${img}</div>
          <span class="camp-albo-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>
        </div>`;
      }).join('');
      return `<div class="camp-albo-row">
        <div class="camp-albo-season">${row.season}</div>
        <div class="camp-albo-podium">${entries}</div>
      </div>`;
    }).join('');
  }

  modal.classList.add('open');
}


function campAlboChiudi() {
  document.getElementById('campAlboModal').classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════
   MATCHDAY — generico per Tier S e A
══════════════════════════════════════════════════════════════ */

/**
 * Genera il calendario round-robin per n squadre.
 * Algoritmo "circle method": fissa il primo elemento, ruota gli altri.
 * Restituisce array di 19 giornate, ognuna con 10 coppie [a, b].
 */
function _generateRoundRobin(teams) {
  const cacheKey = teams.join('|');
  if (_rrCache.has(cacheKey)) return _rrCache.get(cacheKey);

  const n = teams.length;
  const rounds = [];
  let ring = Array.from({length: n - 1}, (_, i) => i + 1);

  for (let r = 0; r < n - 1; r++) {
    const round = [];
    round.push([0, ring[0]]);
    for (let i = 1; i < n / 2; i++) {
      round.push([ring[i], ring[n - 1 - i]]);
    }
    rounds.push(round.map(([a, b]) => [teams[a], teams[b]]));
    ring = [...ring.slice(1), ring[0]];
  }

  // Mantieni la cache piccola (LRU semplice: svuota se troppo grande)
  if (_rrCache.size >= _RR_CACHE_MAX) _rrCache.clear();
  _rrCache.set(cacheKey, rounds);
  return rounds;
}

const _matchdayCurrentDay = { S: 0, A: 0 };

function _getOrCreateOrderFor(tier) {
  const key = TIER_ORDER_KEY[tier];
  if (!campionatoData[key] || campionatoData[key].length === 0) {
    campionatoData[key] = getTierSorted(tier);
    campionatoSave();
  }
  return campionatoData[key];
}
// alias usati altrove
function _getOrCreateOrder()  { return _getOrCreateOrderFor('S'); }
function _getOrCreateOrderA() { return _getOrCreateOrderFor('A'); }

function matchdayOpenForTier(tier) {
  const list = _getOrCreateOrderFor(tier);
  if (list.length < 2) {
    if (typeof toast === 'function') toast(`Servono almeno 2 elementi nel Tier ${tier}`, 'error');
    return;
  }
  const rounds  = _generateRoundRobin(list);
  const results = campionatoData[TIER_RESULTS_KEY[tier]] || {};
  let firstUnplayed = rounds.findIndex((round, i) => {
    const dayKey = String(i + 1);
    return !(results[dayKey] && Object.keys(results[dayKey]).length === round.length);
  });
  _matchdayCurrentDay[tier] = firstUnplayed >= 0 ? firstUnplayed : rounds.length - 1;
  _matchdayRenderForTier(tier, list);
  const modalId = tier === 'S' ? 'matchdayModal' : 'matchdayAModal';
  document.getElementById(modalId).classList.add('open');
}
function matchdayOpen()  { matchdayOpenForTier('S'); }
function matchdayOpenA() { matchdayOpenForTier('A'); }

function matchdayCloseForTier(tier) {
  const modalId = tier === 'S' ? 'matchdayModal' : 'matchdayAModal';
  document.getElementById(modalId).classList.remove('open');
}
function matchdayClose()  { matchdayCloseForTier('S'); }
function matchdayAClose() { matchdayCloseForTier('A'); }

function matchdayGoForTier(tier, delta) {
  const list = _getOrCreateOrderFor(tier);
  const rounds = _generateRoundRobin(list);
  _matchdayCurrentDay[tier] = Math.max(0, Math.min(rounds.length - 1, _matchdayCurrentDay[tier] + delta));
  _matchdayRenderForTier(tier, list);
}
function matchdayGo(delta)  { matchdayGoForTier('S', delta); }
function matchdayAGo(delta) { matchdayGoForTier('A', delta); }

function matchdayGoToForTier(tier, idx) {
  const list = _getOrCreateOrderFor(tier);
  const rounds = _generateRoundRobin(list);
  _matchdayCurrentDay[tier] = Math.max(0, Math.min(rounds.length - 1, idx));
  _matchdayRenderForTier(tier, list);
}
function matchdayGoTo(idx)  { matchdayGoToForTier('S', idx); }
function matchdayAGoTo(idx) { matchdayGoToForTier('A', idx); }

function _matchdayRenderForTier(tier, list) {
  const isS      = tier === 'S';
  const pfx      = isS ? 'matchday' : 'matchdayA';
  const color    = 'var(--gold)';
  const rounds   = _generateRoundRobin(list);
  const total    = rounds.length;
  const day      = _matchdayCurrentDay[tier];
  const matches  = rounds[day];

  document.getElementById(`${pfx}DayBadge`).textContent = `Giornata ${day + 1}`;
  document.getElementById(`${pfx}DaySub`).textContent   = `di ${total}`;
  document.getElementById(`${pfx}PrevBtn`).disabled = (day === 0);
  document.getElementById(`${pfx}NextBtn`).disabled = (day === total - 1);

  const dotsEl = document.getElementById(`${pfx}Dots`);
  dotsEl.innerHTML = rounds.map((_, i) =>
    `<span class="matchday-dot${i === day ? ' active' : ''}" onclick="matchdayGoToForTier('${tier}',${i})" title="Giornata ${i+1}"></span>`
  ).join('');

  const matchesEl    = document.getElementById(`${pfx}Matches`);
  const savedResults = (campionatoData[TIER_RESULTS_KEY[tier]] || {})[String(day + 1)] || {};
  const standings    = getTierSorted(tier);

  matchesEl.innerHTML = matches.map(([a, b]) => {
    const ea    = getEntryByName(a);
    const eb    = getEntryByName(b);
    const rankA = standings.indexOf(a) + 1;
    const rankB = standings.indexOf(b) + 1;
    const imgA  = ea && imgSrc(ea) ? `<img class="matchday-team-img" src="${imgSrc(ea)}"  loading="lazy" onerror="this.style.display='none'">` : `<div class="matchday-team-img-placeholder">🎵</div>`;
    const imgB  = eb && imgSrc(eb) ? `<img class="matchday-team-img" src="${imgSrc(eb)}"  loading="lazy" onerror="this.style.display='none'">` : `<div class="matchday-team-img-placeholder">🎵</div>`;
    const key   = _matchKey(a, b);
    const res   = savedResults[key];
    let scoreHtml = `<div class="matchday-vs">VS</div>`;
    if (res) {
      const [sA, sB, teamA] = res;
      const scoreA = teamA === a ? sA : sB;
      const scoreB = teamA === a ? sB : sA;
      scoreHtml = `<div class="matchday-vs" style="font-size:32px;color:${color}">${scoreA}–${scoreB}</div>`;
    }
    return `<div class="matchday-match">
      <div class="matchday-team">${imgA}<div><div class="matchday-team-name">${a}</div><div class="matchday-team-rank">${rankA}°</div></div></div>
      ${scoreHtml}
      <div class="matchday-team right">${imgB}<div><div class="matchday-team-name">${b}</div><div class="matchday-team-rank">${rankB}°</div></div></div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   GIOCA — Stato
══════════════════════════════════════════════════════════════ */

/* ── Helpers chiave match ── */
function _matchKey(a, b) {
  return [a, b].sort().join(' ⚔ ');
}

/* ══════════════════════════════════════════════════════════════
   GIOCA — Apertura / navigazione
══════════════════════════════════════════════════════════════ */
function campGiocaApri() {
  const sl = document.getElementById('giocaTierSeasonLabel');
  if (sl) sl.textContent = getCurrentSeasonLabel();
  showView('giocaTierView');
}
function campGiocaChiudi() {
  showView('campionatoMenuView');
  campionatoUpdateMenuCounts();
}

function campGiocaSelezionaTier(tier) {
  giocaState.tier = tier;

  // Tier B → prima scegli il gruppo
  if (tier === 'B') {
    _campGiocaApriSceltaGruppoB();
    return;
  }

  // Tier C → prima scegli il gruppo
  if (tier === 'C') {
    _campGiocaApriSceltaGruppoC();
    return;
  }

  campGiocaChiudi();
  if (tier === 'A') {
    giocaState.order  = _getOrCreateOrderA();
  } else {
    giocaState.order  = _getOrCreateOrder();
  }
  giocaState.rounds = _generateRoundRobin(giocaState.order);
  _renderGiocaDayList();
  const el = document.getElementById('giocaDayTierLabel');
  if (el) el.textContent = `PARTITE — TIER ${tier}`;
  const sl = document.getElementById('giocaDaySeasonLabel');
  if (sl) sl.textContent = getCurrentSeasonLabel();
  showView('giocaDayView');
}

/* ── Tier B: selezione gruppo ── */

// ── Helper button gruppo picker ──────────────────────────────────────────
function _campGruppoBtn(tier, g, label) {
  return `<button class="gioca-tier-btn gioca-tier-btn--${tier.toLowerCase()}" onclick="_campGiocaSelezionaGruppo('${tier}','${g}')">
      <span class="gioca-tier-icon">Group ${g}</span>
      <span style="font-size:12px;opacity:.7">${label}</span>
    </button>`;
}
function _campGiocaApriSceltaGruppoB() {
  const sl = document.getElementById('giocaBGroupSeasonLabel');
  if (sl) sl.textContent = getCurrentSeasonLabel();
  const btns = document.getElementById('giocaBGroupBtns');
  if (!btns) return;
  btns.innerHTML = TIER_CONFIG['B'].groups.map(g => {
    const d = _swissData(g);
    const done = d.turn >= 5;
    let label;
    if (!done) {
      label = `Turno ${d.turn + 1} / 5`;
    } else {
      const kfDone  = Object.keys(d.kfResults  || {}).length >= 1;
      const ksfDone = Object.keys(d.ksfResults || {}).length >= 2;
      const kqfDone = Object.keys(d.kqfResults || {}).length >= 4;
      label = kfDone ? '🏆 Completato' : ksfDone ? '⚔️ Knockout — Finale' : kqfDone ? '⚔️ Knockout — Semifinali' : '⚔️ Knockout — Quarti';
    }
    return _campGruppoBtn('B', g, label);
  }).join('');
  showView('giocaBGroupView');
}

function _campGiocaSelezionaGruppo(tier, group) {
  if (tier === 'B') {
    _giocaBGroup = group;
    swissState.group  = group;
    const d = _swissData(group);
    if (d.participants.length === 0) d.participants = [...(distributeGroups('B')[group] || [])];
    _renderGiocaBTurnList();
  } else {
    tierCState.group = group;
    const d = _knockCData(group);
    if (d.participants.length === 0) d.participants = [...(distributeGroups('C')[group] || [])];
    _renderGiocaCTurnList();
  }
  const el = document.getElementById('giocaDayTierLabel');
  if (el) el.textContent = `TIER ${tier} — Group ${group}`;
  const sl = document.getElementById('giocaDaySeasonLabel');
  if (sl) sl.textContent = getCurrentSeasonLabel();
  showView('giocaDayView');
}
function _campGiocaSelezionaGruppoB(group) { _campGiocaSelezionaGruppo('B', group); }
function _campGiocaSelezionaGruppoC(group) { _campGiocaSelezionaGruppo('C', group); }

function _renderGiocaBTurnList() {
  const group = _giocaBGroup;
  const d     = _swissData(group);
  const el    = document.getElementById('giocaDayList');
  if (!el) return;

  const kqfDone = Object.keys(d.kqfResults || {}).length >= 4;
  const ksfDone = Object.keys(d.ksfResults || {}).length >= 2;
  const kfDone  = Object.keys(d.kfResults  || {}).length >= 1;

  const swissTurns = [1, 2, 3, 4, 5].map(turnNum => {
    const t           = turnNum - 1;
    const played      = t < d.turn;
    const isCurrent   = t === d.turn;
    const notReached  = t > d.turn;
    const nextPlayed  = d.turn > t + 1 || (t === 4 && kqfDone);
    // Oscurato: non raggiunto, oppure già giocato con successivo già giocato/knockout iniziato
    const locked      = notReached || (played && nextPlayed) || (played && kqfDone);
    const clickable   = isCurrent || (played && !nextPlayed && !kqfDone);

    let statusText, statusClass;
    if (played)       { statusText = '✅ Completato'; statusClass = ' done'; }
    else if (notReached) { statusText = '🔒 Bloccato'; statusClass = ' locked'; }
    else              { statusText = '○ Da giocare'; statusClass = ''; }

    return `<div class="gioca-day-row${played ? ' played' : ''}${locked ? ' locked' : ''}"
      onclick="${clickable ? `_campGiocaAvviaTurnoB(${t})` : ''}"
      style="${locked ? 'opacity:.4;cursor:default' : 'cursor:pointer'}">
      <span class="gioca-day-num">Swiss — Turno ${turnNum}</span>
      <span class="gioca-day-status${statusClass}">${statusText}</span>
      <span style="color:#60608a;font-size:18px">${clickable ? '›' : ''}</span>
    </div>`;
  }).join('');

  // Fasi knockout (disponibili solo dopo swiss completato)
  const swissDone = d.turn >= 5;
  const knockPhases = [
    { key: 'kqfResults', label: 'Knockout — Quarti',    matchCount: 4 },
    { key: 'ksfResults', label: 'Knockout — Semifinali', matchCount: 2 },
    { key: 'kfResults',  label: 'Knockout — Finale',     matchCount: 1 },
  ];

  const knockTurns = knockPhases.map(({ key, label, matchCount }, idx) => {
    if (!swissDone) {
      return `<div class="gioca-day-row locked" style="opacity:.4;cursor:default">
        <span class="gioca-day-num">${label}</span>
        <span class="gioca-day-status locked">🔒 Completa Swiss prima</span>
        <span></span>
      </div>`;
    }
    const results    = d[key] || {};
    const played     = Object.keys(results).length >= matchCount;
    const nextKey    = knockPhases[idx + 1]?.key;
    const nextPlayed = nextKey && Object.keys(d[nextKey] || {}).length > 0;
    // Oscurato se già giocato e la fase successiva è già stata giocata
    const locked     = played && !!nextPlayed;
    const clickable  = !locked;
    return `<div class="gioca-day-row${played ? ' played' : ''}${locked ? ' locked' : ''}"
      onclick="${clickable ? `_campGiocaAvviaKnockB('${key}')` : ''}"
      style="${locked ? 'opacity:.4;cursor:default' : 'cursor:pointer'}">
      <span class="gioca-day-num">${label}</span>
      <span class="gioca-day-status${played ? ' done' : ''}">${played ? '✅ Completato' : '○ Da giocare'}</span>
      <span style="color:#60608a;font-size:18px">${clickable ? '›' : ''}</span>
    </div>`;
  }).join('');

  el.innerHTML = swissTurns + knockTurns;
}

/**
 * Cancella i risultati di tutti i turni > turnIdx e l'intero knockout stage,
 * e riporta d.turn a turnIdx (così il turno viene rigiocato come se fosse corrente).
 */
function _swissRollbackFrom(group, turnIdx) {
  const d = _swissData(group);
  // Azzera il turno che si sta rigiocando E tutti i turni successivi
  for (let t = turnIdx; t <= 4; t++) {
    const k = _swissTurnResultKey(t);
    if (d[k]) d[k] = {};
  }
  // Azzera l'intero knockout stage (dipendeva dai record del turno corrotto)
  d.kqfResults = {};
  d.ksfResults = {};
  d.kfResults  = {};
  // Riporta il cursore al turno che si sta rigiocando
  d.turn = turnIdx;
  _invalidateTurnMatchesCache(group);
  _invalidateRecordsCache(group);
}

function _campGiocaAvviaTurnoB(turnIdx) {
  const d = _swissData(_giocaBGroup);
  if (!d.participants || d.participants.length === 0) {
    if (typeof toast === 'function') toast(`Group ${_giocaBGroup} è vuoto — aggiungi opening prima`, 'error');
    return;
  }
  if (turnIdx > d.turn) return;
  // Blocca se il knockout è già iniziato
  if (Object.keys(d.kqfResults || {}).length > 0) {
    if (typeof toast === 'function') toast('Non puoi modificare lo Swiss: il Knockout Stage è già iniziato', 'error');
    return;
  }
  // Blocca il replay se il turno successivo è già stato giocato (d.turn > turnIdx + 1)
  if (d.turn > turnIdx + 1) {
    if (typeof toast === 'function') toast(`Non puoi rigiocare il Turno ${turnIdx + 1}: il Turno ${turnIdx + 2} è già stato completato`, 'error');
    return;
  }

  swissState.group    = _giocaBGroup;
  swissState.phase    = 'stage';
  swissState.matches  = _swissGenerateTurnMatches(_giocaBGroup, turnIdx);
  swissState.matchIdx = 0;
  swissState.results  = [];
  swissState.forcedTurn = turnIdx;

  _swissSetupGiocaView(`TIER B — Group ${_giocaBGroup}`, `Swiss — Turno ${turnIdx + 1}`);
  showView('giocaMatchView');
  _swissRenderMatch();
}

function _campGiocaAvviaKnockB(phaseKey) {
  const phaseMap = { kqfResults: 'qf', ksfResults: 'sf', kfResults: 'final' };
  swissState.knockPhase = phaseMap[phaseKey];
  swissState.group = _giocaBGroup;
  swissKnockAvviaFase();
}

function campGiocaChiudiDay() {
  if (giocaState.tier === 'B') {
    _campGiocaApriSceltaGruppoB(); // ridisegna i bottoni con stato aggiornato
  } else if (giocaState.tier === 'C') {
    _campGiocaApriSceltaGruppoC();
  } else {
    showView('giocaTierView');
  }
}

function _renderGiocaDayList() {
  const results = giocaState.tier === 'A' ? (campionatoData._aMatchdayResults || {}) : (campionatoData._matchdayResults || {});
  const el = document.getElementById('giocaDayList');
  el.innerHTML = giocaState.rounds.map((round, i) => {
    const dayKey  = String(i + 1);
    const played  = results[dayKey] && Object.keys(results[dayKey]).length === round.length;
    const prevKey = String(i);
    const prevPlayed = i === 0 || (results[prevKey] && Object.keys(results[prevKey]).length === giocaState.rounds[i-1].length);
    const locked  = !played && !prevPlayed;

    let statusText, statusClass;
    if (played)      { statusText = '✅ Completata'; statusClass = ' done'; }
    else if (locked) { statusText = '🔒 Bloccata';  statusClass = ' locked'; }
    else             { statusText = '○ Da giocare'; statusClass = ''; }

    return `<div class="gioca-day-row${played ? ' played' : ''}${locked ? ' locked' : ''}"
      onclick="${locked ? '' : `campGiocaAvviaGiornata(${i})`}"
      style="${locked ? 'opacity:.4;cursor:default' : 'cursor:pointer'}">
      <span class="gioca-day-num">Giornata ${i + 1}</span>
      <span class="gioca-day-status${statusClass}">${statusText}</span>
      <span style="color:#60608a;font-size:18px">${locked ? '' : '›'}</span>
    </div>`;
  }).join('');
}

function campGiocaAvviaGiornata(dayIdx) {
  if (!giocaState.rounds || !giocaState.rounds[dayIdx]) {
    if (giocaState.tier === 'A') {
      giocaState.order  = _getOrCreateOrderA();
    } else {
      giocaState.order  = _getOrCreateOrder();
    }
    giocaState.rounds = _generateRoundRobin(giocaState.order);
  }
  giocaState.day      = dayIdx;
  giocaState.matchIdx = 0;
  giocaState.results  = [];
  giocaState.matches  = giocaState.rounds[dayIdx];
  showView('giocaMatchView');
  _giocaRenderMatch();
}

/* ══════════════════════════════════════════════════════════════
   GIOCA — Render partita
══════════════════════════════════════════════════════════════ */
// ── Helper img contestant ────────────────────────────────────────────────
function _giocaSetContestantImg(el, imgPath) {
  if (imgPath) {
    el.src = imgPath; el.style.display = '';
    el.onerror = function() { this.style.display = 'none'; };
  } else {
    el.style.display = 'none';
  }
}
function _giocaRenderMatch() {
  const total   = giocaState.matches.length;
  const current = giocaState.matchIdx;
  const [a, b]  = giocaState.matches[current];

  document.getElementById('giocaMatchDayLabel').textContent  = `TIER ${giocaState.tier}`;
  document.getElementById('giocaMatchProgress').textContent  = `Giornata ${giocaState.day + 1}`;
  const counter = document.getElementById('giocaMatchCounter');
  if (counter) counter.textContent = `Match ${current + 1} / ${total}`;

  const ea = getEntryByName(a), eb = getEntryByName(b);
  _giocaSetContestantImg(document.getElementById('giocaContLeftImg'),  imgSrc(ea) || '');
  _giocaSetContestantImg(document.getElementById('giocaContRightImg'), imgSrc(eb) || '');

  document.getElementById('giocaContLeftName').textContent  = a;
  document.getElementById('giocaContRightName').textContent = b;
  document.getElementById('giocaContLeft').className  = 'contestant';
  document.getElementById('giocaContRight').className = 'contestant';

  _giocaLoadAudio('giocaLeft',  ea || null);
  _giocaLoadAudio('giocaRight', eb || null);
}

/* ══════════════════════════════════════════════════════════════
   GIOCA — Pick
   Prima chiamata = voto (1 punto al vincitore, 0 all'altro, o 1-1 se pareggio)
   Il pareggio si ottiene cliccando di nuovo il perdente entro 600ms
   → implementazione semplificata: doppio click = pareggio
   Approccio reale: primo click = voto, se rivoto l'altro = pareggio
══════════════════════════════════════════════════════════════ */

function giocaPick(side) {
  const [a, b] = giocaState.matches[giocaState.matchIdx];
  const cardId = side === 0 ? 'giocaContLeft' : 'giocaContRight';
  document.getElementById(cardId).classList.add('picked');
  _giocaStopAudio();
  const winner = side === 0 ? a : b;
  const scoreA = side === 0 ? 2 : 0;
  const scoreB = side === 0 ? 0 : 2;
  giocaState.results.push({ a, b, scoreA, scoreB });
  giocaState.matchIdx++;
  setTimeout(_giocaAdvance, 420);
}

function giocaDraw() {
  const [a, b] = giocaState.matches[giocaState.matchIdx];
  document.getElementById('giocaContLeft').classList.add('picked');
  document.getElementById('giocaContRight').classList.add('picked');
  _giocaStopAudio();
  giocaState.results.push({ a, b, scoreA: 1, scoreB: 1 });
  giocaState.matchIdx++;
  setTimeout(_giocaAdvance, 420);
}

function _giocaAdvance() {
  if (giocaState.matchIdx >= giocaState.matches.length) {
    _giocaSalvaEShoEndDay();
  } else {
    _giocaRenderMatch();
  }
}

function campGiocaEsci() {
  _giocaStopAudio();
  showView('campionatoMenuView');
  campionatoUpdateMenuCounts();
}

function campGiocaProssimaGiornata() {
  showView('giocaEndView');
  campGiocaAvviaGiornata(giocaState.day + 1);
}

/* ══════════════════════════════════════════════════════════════
   GIOCA — Fine giornata
══════════════════════════════════════════════════════════════ */
function _giocaSalvaEShoEndDay() {
  const dayKey = String(giocaState.day + 1);
  const dayResults = {};
  giocaState.results.forEach(r => {
    dayResults[_matchKey(r.a, r.b)] = [r.scoreA, r.scoreB, r.a];
  });

  if (giocaState.tier === 'A') {
    if (!campionatoData._aMatchdayResults) campionatoData._aMatchdayResults = {};
    campionatoData._aMatchdayResults[dayKey] = dayResults;
    _giocaRicalcolaAScores();
    campionatoSave();
    if (campionatoUI.currentTier === 'A') _rerenderTierAList();
  } else {
    if (!campionatoData._matchdayResults) campionatoData._matchdayResults = {};
    campionatoData._matchdayResults[dayKey] = dayResults;
    _giocaRicalcolaScores();
    campionatoSave();
    if (campionatoUI.currentTier === 'S') _rerenderTierSList();
  }
  _giocaShowEndDay();
}

function _giocaRicalcolaScoresForTier(tier) {
  const scores = {};
  const results = campionatoData[TIER_RESULTS_KEY[tier]] || {};
  Object.values(results).forEach(dayRes => {
    Object.entries(dayRes).forEach(([key, val]) => {
      const [scoreA, scoreB, teamA] = val;
      const teams = key.split(' ⚔ ');
      const a = teamA;
      const b = teams.find(t => t !== a) || teams[1];
      scores[a] = (scores[a] || 0) + scoreA;
      scores[b] = (scores[b] || 0) + scoreB;
    });
  });
  campionatoData[TIER_SCORE_KEY[tier]] = scores;
}
function _giocaRicalcolaScores()  { _giocaRicalcolaScoresForTier('S'); }
function _giocaRicalcolaAScores() { _giocaRicalcolaScoresForTier('A'); }
function _giocaShowEndDay() {
  document.getElementById('giocaEndDayLabel').textContent = `GIORNATA ${giocaState.day + 1}`;
  const el = document.getElementById('giocaEndResults');
  el.replaceChildren();
  const scoreColor = 'var(--gold)';
  giocaState.results.forEach(r => {
    const ea = getEntryByName(r.a);
    const eb = getEntryByName(r.b);
    el.appendChild(_makeEndRow(r.a, r.b, r.scoreA, r.scoreB, ea, eb, scoreColor, false));
  });
  const nextBtn = document.getElementById('giocaNextDayBtn');
  nextBtn.style.display = (giocaState.day + 1) < giocaState.rounds.length ? '' : 'none';
  showView('giocaEndView');
}

/* ══════════════════════════════════════════════════════════════
   GIOCA — Sistema audio (usa createAudioPlayer da rankify.js)
══════════════════════════════════════════════════════════════ */
const _gStore = {
  giocaLeft:  { audio: null, dragging: false },
  giocaRight: { audio: null, dragging: false },
};

function _gIds(side) {
  const L = side === 'giocaLeft';
  return {
    bar:   L ? 'giocaLeftAudio'      : 'giocaRightAudio',
    btn:   L ? 'giocaLeftAudioBtn'   : 'giocaRightAudioBtn',
    track: L ? 'giocaLeftAudioTrack' : 'giocaRightAudioTrack',
    fill:  L ? 'giocaLeftAudioFill'  : 'giocaRightAudioFill',
    thumb: L ? 'giocaLeftAudioThumb' : 'giocaRightAudioThumb',
    time:  L ? 'giocaLeftAudioTime'  : 'giocaRightAudioTime',
  };
}

const _gPlayers = {
  giocaLeft:  createAudioPlayer(_gIds('giocaLeft'),  _gStore.giocaLeft),
  giocaRight: createAudioPlayer(_gIds('giocaRight'), _gStore.giocaRight),
};

// Proxy per retrocompatibilità con codice che legge _gAudio[side]
const _gAudio = new Proxy({}, {
  get: (_, side) => _gStore[side]?.audio ?? null,
});

function _giocaStopAudio() {
  _gPlayers.giocaLeft.stop();
  _gPlayers.giocaRight.stop();
}

function _giocaLoadAudio(side, entry) {
  if (typeof stopCampPlaylist === 'function') stopCampPlaylist();
  _gPlayers[side].load(entry, undefined, false);
  _gPlayers[side].initSeek();
}

// Override toggleContAudio per i lati gioca
const _origToggleContAudio = window.toggleContAudio;
window.toggleContAudio = function(side) {
  if (side !== 'giocaLeft' && side !== 'giocaRight') {
    if (_origToggleContAudio) _origToggleContAudio(side);
    return;
  }
  const other = side === 'giocaLeft' ? 'giocaRight' : 'giocaLeft';
  _gPlayers[side].toggle(_gPlayers[other]);
};


/* ══════════════════════════════════════════════════════════════
   SWISS SYSTEM — TIER B
   ══════════════════════════════════════════════════════════════

   Struttura dati campionatoData._swissB:
   {
     "A": {   // group letter
       turn: 0..4,           // turno corrente (0-based). 5 = swiss completato
       participants: [...],  // 16 nomi in ordine iniziale
       // risultati turni: oggetto { matchKey: [scoreA, scoreB, nameA] }
       t0Results: {},   // Turn 1 (16 giocatori → 8w 8l)
       t1Results: {},   // Turn 2 (4 match winners, 4 match losers)
       t2Results: {},   // Turn 3
       t3Results: {},   // Turn 4
       t4Results: {},   // Turn 5 (solo 2-2)
       // Knockout (dopo swiss stage)
       kqfResults: {},  // QF: 4 match
       ksfResults: {},  // SF: 2 match
       kfResults:  {},  // Final: 1 match
     }
   }

   Record (wins, losses):
   Dopo T1: 1-0 o 0-1
   Dopo T2: 2-0, 1-1, 0-2
   Dopo T3: 3-0, 2-1, 1-2, 0-3  → 3-0 e 0-3 escono dal swiss
   Dopo T4: 3-1, 2-2, 1-3        → 3-1 va in QF, 1-3 eliminato
   Dopo T5: 3-2, 2-3             → 3-2 va in QF, 2-3 eliminato

   QF: 8 partecipanti:
     - 2 da 3-0
     - 4 da 3-1
     - 2 da 3-2
   Eliminati: 8 partecipanti:
     - 2 da 0-3
     - 2 da 1-3
     - 4 da 2-3 ... (aggiustato per avere esattamente 8)

   Nota: con 16 giocatori il conteggio esatto è:
   T1: 8 vincitori (1-0), 8 perdenti (0-1)
   T2: 4 con 2-0, 8 con 1-1, 4 con 0-2
   T3: 2 con 3-0 (→ QF), 6 con 2-1, 6 con 1-2, 2 con 0-3 (→ Elim)
   T4: 3 match tra 2-1 (→ 3-1 e 2-2), 3 match tra 1-2 (→ 2-2 e 1-3)
       = 3 con 3-1 (→ QF), 6 con 2-2, 3 con 1-3 (→ Elim)
   T5: 3 match tra i 6 con 2-2 → 3 con 3-2 (→ QF), 3 con 2-3 (→ Elim)

   QF (8): 2 × 3-0 + 3 × 3-1 + 3 × 3-2 = 8 ✓
   Elim (8): 2 × 0-3 + 3 × 1-3 + 3 × 2-3 = 8 ✓

══════════════════════════════════════════════════════════════ */

/* ── Stato corrente sessione Swiss ── */

/* ── Accesso dati ── */
function _swissData(group) {
  if (!campionatoData._swissB) campionatoData._swissB = {};
  if (!campionatoData._swissB[group]) {
    const dist = distributeGroups('B');
    const p = dist[group] || [];
    campionatoData._swissB[group] = {
      turn: 0, participants: [...p],
      t0Order: null,
      t0Results:{}, t1Results:{}, t2Results:{}, t3Results:{}, t4Results:{},
      kqfResults:{}, ksfResults:{}, kfResults:{}
    };
  }
  return campionatoData._swissB[group];
}

function _swissTurnResultKey(turn) {
  return ['t0Results','t1Results','t2Results','t3Results','t4Results'][turn];
}

/* ── Calcola record (wins, losses) dopo i turni giocati ── */

/* ── Genera i match per un turno in base ai record ── */
function _swissGenerateTurnMatches(group, turn) {
  const d = _swissData(group);

  if (turn === 0) {
    // Turno 0: usa t0Order se presente e completo, altrimenti participants.
    // NON cachare se t0Order non è ancora valorizzato: potrebbe essere impostato
    // dopo (es. campSeasonModalConfirm lo genera dopo _swissB = {}).
    const p = d.t0Order && d.t0Order.length === d.participants.length ? d.t0Order : d.participants;
    const ready = d.t0Order && d.t0Order.length === d.participants.length && d.participants.length > 0;
    if (!ready) {
      // t0Order non ancora pronto: calcola ma non cachare
      const m = [];
      for (let i = 0; i < p.length - 1; i += 2) m.push([p[i], p[i+1]]);
      return m;
    }
    const cacheKey0 = group + ':0';
    if (_turnMatchesCache.has(cacheKey0)) return _turnMatchesCache.get(cacheKey0);
    const m = [];
    for (let i = 0; i < p.length - 1; i += 2) m.push([p[i], p[i+1]]);
    _turnMatchesCache.set(cacheKey0, m);
    return m;
  }

  const cacheKey = group + ':' + turn;
  if (_turnMatchesCache.has(cacheKey)) return _turnMatchesCache.get(cacheKey);

  const records = _swissGetRecordsUpTo(group, turn - 1);
  const groups = {};
  d.participants.forEach(n => {
    const r = records[n];
    if (!r) return; // partecipante non nei records (gruppo modificato dopo i risultati)
    const key = `${r.w}-${r.l}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(n);
  });

  let result;
  if (turn === 1) {
    const w = groups['1-0'] || [];
    const l = groups['0-1'] || [];
    result = [..._pairSequential(w), ..._pairSequential(l)];
  } else if (turn === 2) {
    const a = groups['2-0'] || [];
    const b = groups['1-1'] || [];
    const c = groups['0-2'] || [];
    result = [..._pairSequential(a), ..._pairSequential(b), ..._pairSequential(c)];
  } else if (turn === 3) {
    const a = groups['2-1'] || [];
    const b = groups['1-2'] || [];
    result = [..._pairSequential(a), ..._pairSequential(b)];
  } else if (turn === 4) {
    const a = groups['2-2'] || [];
    result = _pairSequential(a);
  } else {
    result = [];
  }

  _turnMatchesCache.set(cacheKey, result);
  return result;
}

function _pairSequential(arr) {
  const m = [];
  for (let i = 0; i < arr.length - 1; i += 2) m.push([arr[i], arr[i+1]]);
  return m;
}



/* Calcola record fino a (e includendo) il turno `upTo` */
function _swissGetRecordsUpTo(group, upTo) {
  const cacheKey = group + ':' + upTo;
  if (_recordsCache.has(cacheKey)) return _recordsCache.get(cacheKey);

  const d = _swissData(group);
  const records = {};
  d.participants.forEach(n => { records[n] = {w:0, l:0}; });
  for (let t = 0; t <= upTo; t++) {
    const matches = _swissGenerateTurnMatches(group, t);
    const key = _swissTurnResultKey(t);
    const res = d[key] || {};
    matches.forEach(([a, b]) => {
      const mk = _matchKey(a, b);
      const r = res[mk];
      if (!r) return;
      const [sA, sB, tA] = r;
      const wA = tA === a ? sA : sB;
      const wB = tA === a ? sB : sA;
      if (wA > wB) { records[a].w++; records[b].l++; }
      else { records[b].w++; records[a].l++; }
    });
  }

  _recordsCache.set(cacheKey, records);
  return records;
}
function _swissGetKnockWinner(group) {
  const d = _swissData(group);
  const rec = _swissGetRecordsUpTo(group, 4);
  const qfPlayers = d.participants.filter(n => rec[n] && rec[n].w === 3);
  const qfPairs   = Array.from({length:4}, (_,i) => ({a:qfPlayers[i*2]||null, b:qfPlayers[i*2+1]||null}));
  const sfPlayers = _swissKnockGetWinners(qfPairs, d.kqfResults||{});
  const sfPairs   = [{a:sfPlayers[0]||null,b:sfPlayers[1]||null},{a:sfPlayers[2]||null,b:sfPlayers[3]||null}];
  const finPlayers= _swissKnockGetWinners(sfPairs, d.ksfResults||{});
  return _swissKnockGetWinners([{a:finPlayers[0]||null,b:finPlayers[1]||null}], d.kfResults||{})[0] || null;
}
function _swissGetRelegated5(group) {
  // Retrocessi: solo 0-3 (2 giocatori) e 1-3 (3 giocatori) = 5 totali.
  // I 2-3 si salvano.
  const d = _swissData(group);
  if (!d || d.turn < 5) return [];
  const rec = _swissGetRecordsUpTo(group, 4);
  const elim03 = d.participants.filter(n => rec[n] && rec[n].w===0 && rec[n].l===3);
  const elim13 = d.participants.filter(n => rec[n] && rec[n].w===1 && rec[n].l===3);
  return [...elim03, ...elim13];
}

/* ── Navigazione ── */
/* ── Drag-to-pan per hub bracket view ── */
function _initHubDragPan(selector) {
  const hubBody = document.querySelector(selector);
  if (!hubBody || hubBody._dragPanHub) return;
  hubBody._dragPanHub = true;
  let down = false, sx = 0, sl = 0;
  hubBody.addEventListener('mousedown', e => {
    if (e.target.closest('.swiss-slot, .swiss-result-slot, .swiss-knock-slot, .swiss-tab, button, input')) return;
    down = true; sx = e.clientX; sl = hubBody.scrollLeft;
    hubBody.style.cursor = 'grabbing'; e.preventDefault();
  });
  window.addEventListener('mouseup', () => { down = false; hubBody.style.cursor = 'grab'; });
  window.addEventListener('mousemove', e => { if (down) hubBody.scrollLeft = sl - (e.clientX - sx); });
}

function swissOpenGroup(group) {
  swissState.group  = group;
  swissState.phase  = 'stage';
  const d = _swissData(group);
  if (d.participants.length === 0) {
    const dist = distributeGroups('B');
    d.participants = [...(dist[group] || [])];
  }

  const label = document.getElementById('swissHubLabel');
  if (label) { label.textContent = `TIER B — Group ${group}`; label.style.color = TIER_CONFIG['B'].color; }
  const sl = document.getElementById('swissHubSeason');
  if (sl) sl.textContent = getCurrentSeasonLabel();

  if (d.participants.length !== 16 && d.turn === 0) {
    const n = d.participants.length;
    if (typeof toast === 'function') {
      if (n === 0) toast(`Group ${group} è vuoto — aggiungi opening prima`, 'error');
      else if (n % 2 !== 0) toast(`Group ${group} ha ${n} partecipanti (dispari): un'opening non avrà avversario al Turno 1`, 'warning');
      else toast(`Group ${group} ha ${n} partecipanti (attesi 16)`, 'info');
    }
  }

  document.body.style.overflowX = 'auto';
  showView('swissHubView');
  document.body.classList.add('swiss-active');
  _initHubDragPan('.swiss-hub-body');
  swissShowTab('stage');
}

function swissBack() {
  document.body.classList.remove('swiss-active');
  showView('campionatoTierView');
  campionatoUI.currentGroup = swissState.group;
  renderCampionatoTier();
}

function swissTogglePhase() {
  const isStage = document.getElementById('swissPanelStage').style.display !== 'none';
  swissShowTab(isStage ? 'knock' : 'stage');
}

function swissShowTab(tab) {
  swissState.phase = tab === 'knock' ? 'knock' : 'stage';
  document.getElementById('swissPanelStage').style.display = tab === 'stage' ? '' : 'none';
  document.getElementById('swissPanelKnock').style.display = tab === 'knock' ? '' : 'none';

  // Aggiorna testo pulsante nell'header
  const btn = document.getElementById('swissNavBtn');
  if (btn) btn.textContent = tab === 'stage' ? 'KNOCKOUT STAGE →' : '← SWISS STAGE';
  const pillGreen = document.getElementById('swissLegendGreen');
  const pillRed   = document.getElementById('swissLegendRed');
  if (pillGreen) pillGreen.style.display = tab === 'knock' ? '' : 'none';
  if (pillRed)   pillRed.style.display   = tab === 'stage' ? '' : 'none';

  if (tab === 'stage') swissRenderStageBracket();
  if (tab === 'knock') swissRenderKnockBracket();
}

/* ── Render Stage Bracket ── */
function swissRenderStageBracket() {
  const group = swissState.group;
  const d = _swissData(group);
  const wrap = document.getElementById('swissBracketWrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const ct = d.turn;

  const r0 = ct >= 1 ? _swissGetRecordsUpTo(group, 0) : null;
  const r1 = ct >= 2 ? _swissGetRecordsUpTo(group, 1) : null;
  const r2 = ct >= 3 ? _swissGetRecordsUpTo(group, 2) : null;
  const r3 = ct >= 4 ? _swissGetRecordsUpTo(group, 3) : null;

  // ── Colonna TURN 1 ── un solo box con la pill sopra
  const col1 = _swissMakeCol();
  col1.appendChild(_swissBoxWithPill(group, ct > 0 ? 0 : null, null, null, 1, []));
  wrap.appendChild(col1);
  wrap.appendChild(_swissConnector());

  // ── Colonna TURN 2 ── 2 box ognuno con la sua pill
  const col2 = _swissMakeCol();
  if (r0) {
    const t1played = ct > 1;
    col2.appendChild(_swissBoxWithPill(group, t1played ? 1 : null, t1played ? r0 : null, '1-0', 2, [[1,0]], !t1played, 8));
    col2.appendChild(_swissBoxWithPill(group, t1played ? 1 : null, t1played ? r0 : null, '0-1', 2, [[0,1]], !t1played, 8));
  } else {
    col2.appendChild(_swissBoxWithPill(group, null, null, '1-0', 2, [[1,0]], true, 8));
    col2.appendChild(_swissBoxWithPill(group, null, null, '0-1', 2, [[0,1]], true, 8));
  }
  wrap.appendChild(col2);
  wrap.appendChild(_swissConnector());

  // ── Colonna TURN 3 ── 3 box
  const col3 = _swissMakeCol();
  if (r1) {
    const t2played = ct > 2;
    col3.appendChild(_swissBoxWithPill(group, t2played ? 2 : null, t2played ? r1 : null, '2-0', 3, [[2,0]], !t2played, 4));
    col3.appendChild(_swissBoxWithPill(group, t2played ? 2 : null, t2played ? r1 : null, '1-1', 3, [[1,1]], !t2played, 8));
    col3.appendChild(_swissBoxWithPill(group, t2played ? 2 : null, t2played ? r1 : null, '0-2', 3, [[0,2]], !t2played, 4));
  } else {
    col3.appendChild(_swissBoxWithPill(group, null, null, '2-0', 3, [[2,0]], true, 4));
    col3.appendChild(_swissBoxWithPill(group, null, null, '1-1', 3, [[1,1]], true, 8));
    col3.appendChild(_swissBoxWithPill(group, null, null, '0-2', 3, [[0,2]], true, 4));
  }
  wrap.appendChild(col3);
  wrap.appendChild(_swissConnector());

  // ── Colonna TURN 4 ── solo 2-1 e 1-2
  const col4 = _swissMakeCol();
  if (r2) {
    const t3played = ct > 3;
    col4.appendChild(_swissBoxWithPill(group, t3played ? 3 : null, t3played ? r2 : null, '2-1', 4, [[2,1]], !t3played, 6));
    col4.appendChild(_swissBoxWithPill(group, t3played ? 3 : null, t3played ? r2 : null, '1-2', 4, [[1,2]], !t3played, 6));
  } else {
    col4.appendChild(_swissBoxWithPill(group, null, null, '2-1', 4, [[2,1]], true, 6));
    col4.appendChild(_swissBoxWithPill(group, null, null, '1-2', 4, [[1,2]], true, 6));
  }
  wrap.appendChild(col4);
  wrap.appendChild(_swissConnector());

  // ── Colonna TURN 5 ── solo 2-2
  const col5 = _swissMakeCol();
  if (r3) {
    const t4played = ct > 4;
    col5.appendChild(_swissBoxWithPill(group, t4played ? 4 : null, t4played ? r3 : null, '2-2', 5, [[2,2]], !t4played, 6));
  } else {
    col5.appendChild(_swissBoxWithPill(group, null, null, '2-2', 5, [[2,2]], true, 6));
  }
  wrap.appendChild(col5);
  wrap.appendChild(_swissConnector());

  // ── Colonna RISULTATI ──
  const colFinal = _makeEl('div', 'swiss-col-final');
  colFinal.appendChild(_swissMakePillHeader('RISULTATI', []));

  const qfPanel = _makeEl('div', 'swiss-qf-panel');
  qfPanel.innerHTML = `<div class="swiss-panel-title">QUARTER-FINALS</div>`;
  const qfList = _makeEl('div', 'swiss-qf-list'); qfList.id = 'swissQFList';
  qfPanel.appendChild(qfList);

  const elPanel = _makeEl('div', 'swiss-el-panel');
  elPanel.innerHTML = `<div class="swiss-panel-title">ELIMINATED</div>`;
  const elList = _makeEl('div', 'swiss-el-list'); elList.id = 'swissELList';
  elPanel.appendChild(elList);

  colFinal.appendChild(qfPanel);
  colFinal.appendChild(elPanel);
  wrap.appendChild(colFinal);

  if (ct >= 5) _swissRenderQFElim(group);
  _swissInitDragPan(wrap);
}

/* Crea una colonna vuota */
function _swissMakeCol() {
  return _makeEl('div', 'swiss-col');
}

/* Pill + box abbinati: la pill mostra i pallini del record specifico */
function _swissBoxWithPill(group, turnForResults, recordsMap, recordFilter, turnNum, dots, empty = false, emptyCount = 0) {
  const wrap = _makeEl('div', 'swiss-box-wrap');

  // Pill con pallini del record
  wrap.appendChild(_swissMakePillHeader(turnNum, dots, recordFilter));

  // Box
  if (empty) {
    wrap.appendChild(_swissBoxEmpty(emptyCount));
  } else {
    wrap.appendChild(_swissBox(group, turnForResults, recordsMap, recordFilter));
  }

  return wrap;
}

/* Header pill bianco con "TURN N" + pallini record */
function _swissMakePillHeader(turnNumOrLabel, dots, recordFilter) {
  const labelText = recordFilter
    ? `TURN ${turnNumOrLabel}`
    : (typeof turnNumOrLabel === 'number' ? `TURN ${turnNumOrLabel}` : String(turnNumOrLabel));
  const h = _makeEl('div', 'swiss-turn-header');
  h.appendChild(_makeEl('span', 'swiss-turn-label', labelText));

  if (dots && dots.length > 0) {
    const dotsWrap = _makeEl('span', 'swiss-dots-wrap');
    dots.forEach(([w, l], groupIdx) => {
      if (groupIdx > 0) dotsWrap.appendChild(_makeEl('span', 'swiss-dots-sep'));
      for (let i = 0; i < w + l; i++)
        dotsWrap.appendChild(_makeEl('span', 'swiss-dot ' + (i < w ? 'win' : 'loss')));
    });
    h.appendChild(dotsWrap);
  }

  return h;
}

/* Box partecipanti con titolo record e slot */
function _swissBox(group, turnForResults, recordsMap, recordFilter) {
  const d = _swissData(group);
  const box = _makeEl('div', 'swiss-bracket-group');
  let titleColor = '';
  if (recordFilter) {
    const [w, l] = recordFilter.split('-').map(Number);
    titleColor = w === 3 ? '#42e8a0' : l === 3 ? '#ff5050' : w > l ? '#42e8a0' : l > w ? '#ff5050' : '#aaa';
  }
  const title = _makeEl('div', 'swiss-bracket-group-header', _swissBoxTitle(recordFilter));
  title.style.color = titleColor;
  box.appendChild(title);

  // Partecipanti filtrati per record
  let participants;
  if (!recordFilter && !recordsMap) {
    participants = d.participants;
  } else if (recordsMap && recordFilter) {
    const [fw, fl] = recordFilter.split('-').map(Number);
    participants = d.participants.filter(n => {
      const r = recordsMap[n]; return r && r.w === fw && r.l === fl;
    });
  } else {
    participants = d.participants;
  }

  // Mappa nome → risultato (W/L) nel turno corrente
  const nameResult = {};
  // Mappa nome → avversario nel match
  const nameOpponent = {};
  if (turnForResults !== null && turnForResults !== undefined) {
    const res = d[_swissTurnResultKey(turnForResults)] || {};
    _swissGenerateTurnMatches(group, turnForResults).forEach(([a, b]) => {
      nameOpponent[a] = b; nameOpponent[b] = a;
      const r = res[_matchKey(a, b)];
      if (!r) return;
      const [sA, sB, tA] = r;
      const wA = tA === a ? sA : sB;
      const wB = tA === a ? sB : sA;
      if (wA > wB) { nameResult[a] = 'winner'; nameResult[b] = 'loser'; }
      else         { nameResult[b] = 'winner'; nameResult[a] = 'loser'; }
    });
  }

  // Raggruppa a coppie secondo i match del turno corrente
  // Se abbiamo i match, usiamo quell'ordine; altrimenti coppie sequenziali
  let pairs = [];
  if (turnForResults !== null && turnForResults !== undefined) {
    const matches = _swissGenerateTurnMatches(group, turnForResults);
    const pSet = new Set(participants);
    pairs = matches
      .filter(([a, b]) => pSet.has(a) && pSet.has(b))
      .map(([a, b]) => [a, b]);
    // Aggiungi eventuali partecipanti non presenti nei match
    const inPairs = new Set(pairs.flat());
    participants.filter(n => !inPairs.has(n)).forEach(n => pairs.push([n, null]));
  } else {
    // Coppie sequenziali: usa t0Order se disponibile (abbinamenti randomizzati Turn 1)
    const orderedList = (d.t0Order && d.t0Order.length === d.participants.length)
      ? d.t0Order
      : participants;
    for (let i = 0; i < orderedList.length; i += 2) {
      pairs.push([orderedList[i], orderedList[i + 1] ?? null]);
    }
  }

  // Renderizza le coppie come "match cards"
  pairs.forEach((pair, pairIdx) => {
    if (pairIdx > 0) box.appendChild(_makeEl('div', 'swiss-match-sep'));

    const matchCard = _makeEl('div', 'swiss-match-card');

    pair.forEach((name, slotIdx) => {
      if (!name) return;
      const res = nameResult[name];
      const slot = _makeEl('div', 'swiss-slot' + (res === 'winner' ? ' winner' : '') + (slotIdx === 1 ? ' slot-bottom' : ''));

      slot.appendChild(_makeSlotImg(getEntryByName(name)));
      slot.appendChild(_makeEl('span', 'swiss-slot-name', name));

      const badge = _makeEl('span', 'swiss-slot-badge');
      if (res) { badge.classList.add(res === 'winner' ? 'w' : 'l'); badge.textContent = res === 'winner' ? 'W' : 'L'; }
      else { badge.style.visibility = 'hidden'; }
      slot.appendChild(badge);

      matchCard.appendChild(slot);
    });

    box.appendChild(matchCard);
  });

  return box;
}

function _swissBoxTitle(recordFilter) {
  if (!recordFilter) return 'Tutti (16)';
  const map = {
    '3-0': '3-0  ✦ QF', '3-1': '3-1  ✦ QF', '3-2': '3-2  ✦ QF',
    '0-3': '0-3  ✖ Elim', '1-3': '1-3  ✖ Elim', '2-3': '2-3  ✖ Elim',
  };
  return map[recordFilter] || recordFilter;
}

/* Box vuoto con N slot placeholder */
function _swissBoxEmpty(n) {
  const box = _makeEl('div', 'swiss-bracket-group');
  box.appendChild(_makeEl('div', 'swiss-bracket-group-header', '—'));
  const pairs = Math.ceil(n / 2);
  for (let p = 0; p < pairs; p++) {
    if (p > 0) box.appendChild(_makeEl('div', 'swiss-match-sep'));
    const card = _makeEl('div', 'swiss-match-card');
    const count = p === pairs - 1 && n % 2 !== 0 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const slot = _makeEl('div', 'swiss-slot' + (i === 1 ? ' slot-bottom' : ''));
      slot.style.opacity = '0.25';
      const imgWrap = _makeSlotImg(null);
      slot.appendChild(imgWrap);
      slot.appendChild(_makeEl('span', 'swiss-slot-name', '—'));
      const badgePh = _makeEl('span', 'swiss-slot-badge');
      badgePh.style.visibility = 'hidden';
      slot.appendChild(badgePh);
      card.appendChild(slot);
    }
    box.appendChild(card);
  }
  return box;
}

/* Connettore sottile tra colonne */
function _swissConnector() {
  return _makeEl('div', 'swiss-connector');
}

function _swissKnockArrowConnector(labelText, offsetY = 55) {
  const wrap = _makeEl('div', null, null, 'display:flex;flex-direction:column;align-items:center;justify-content:center;width:48px;flex-shrink:0;align-self:stretch;');
  const inner = _makeEl('div', null, null, `display:flex;flex-direction:column;align-items:center;transform:translateY(${-offsetY}px);`);
  if (labelText) inner.appendChild(_makeEl('div', null, labelText, 'font-family:"Bebas Neue",sans-serif;font-size:13px;letter-spacing:.07em;color:#f5c842;margin-bottom:4px;white-space:nowrap;'));
  const row = _makeEl('div', null, null, 'display:flex;align-items:center;');
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('width','34'); svg.setAttribute('height','4');
  svg.style.cssText = 'overflow:visible;';
  const dashLine = document.createElementNS('http://www.w3.org/2000/svg','line');
  dashLine.setAttribute('x1','0'); dashLine.setAttribute('y1','2');
  dashLine.setAttribute('x2','34'); dashLine.setAttribute('y2','2');
  dashLine.setAttribute('stroke','#f5c842'); dashLine.setAttribute('stroke-width','2');
  dashLine.setAttribute('stroke-dasharray','5,3'); dashLine.setAttribute('opacity','0.9');
  svg.appendChild(dashLine);
  const arrow = _makeEl('div', null, null, 'color:#f5c842;font-size:14px;line-height:1;margin-left:-1px;');
  arrow.innerHTML = '&#9654;';
  row.appendChild(svg); row.appendChild(arrow);
  inner.appendChild(row); wrap.appendChild(inner);
  return wrap;
}

function _swissRenderQFElim(group) {
  const d = _swissData(group);
  const completedTurns = Math.min(d.turn, 5) - 1;
  if (completedTurns < 0) return;
  const rec = _swissGetRecordsUpTo(group, completedTurns);
  const qfList = document.getElementById('swissQFList');
  const elList = document.getElementById('swissELList');
  if (!qfList || !elList) return;

  // QF = 3 vittorie, Elim = 3 sconfitte
  const qf = d.participants.filter(n => rec[n] && rec[n].w === 3);
  const el = d.participants.filter(n => rec[n] && rec[n].l === 3);

  // Ordina: prima i record migliori (meno sconfitte)
  qf.sort((a, b) => rec[a].l - rec[b].l);
  el.sort((a, b) => rec[b].w - rec[a].w);

  const relegated = el.filter(n => rec[n].w <= 1);

  function makeSlot(name, relegate) {
    const entry = getEntryByName(name);
    const r = rec[name];
    const slot = _makeEl('div', 'swiss-result-slot' + (relegate ? ' relegate' : ''));
    slot.appendChild(_makeSlotImg(entry));
    slot.appendChild(_makeEl('span', 'swiss-result-name', name));
    slot.appendChild(_makeEl('span', 'swiss-result-record', `${r.w}V/${r.l}L`));
    return slot;
  }

  qfList.replaceChildren();
  qf.forEach(n => qfList.appendChild(makeSlot(n, false)));
  elList.replaceChildren();
  el.forEach(n => elList.appendChild(makeSlot(n, relegated.includes(n))));
}

/* ── Render Knockout Bracket ── */
function swissRenderKnockBracket() {
  const group = swissState.group;
  const d = _swissData(group);
  const wrap = document.getElementById('swissKnockWrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const swissDone = d.turn >= 5;
  let qfPlayers = [];
  if (swissDone) {
    const rec = _swissGetRecordsUpTo(group, 4);
    qfPlayers = d.participants.filter(n => rec[n] && rec[n].w === 3);
  }

  const qfResults  = d.kqfResults || {};
  const qfPairs    = Array.from({length: 4}, (_, i) => ({a: qfPlayers[i*2]||null, b: qfPlayers[i*2+1]||null}));
  const sfPlayers  = _swissKnockGetWinners(qfPairs, qfResults);
  const sfResults  = d.ksfResults || {};
  const sfPairs    = [{a: sfPlayers[0]||null, b: sfPlayers[1]||null}, {a: sfPlayers[2]||null, b: sfPlayers[3]||null}];
  const finPlayers = _swissKnockGetWinners(sfPairs, sfResults);
  const finResults = d.kfResults || {};
  const champion   = _swissKnockGetWinners([{a: finPlayers[0]||null, b: finPlayers[1]||null}], finResults)[0];
  const finPairs   = [{a: finPlayers[0]||null, b: finPlayers[1]||null}];

  _swissAddKnockCol(wrap, 'QUARTERFINALS', _swissKnockMakeBox(qfPairs, qfResults, false));
  _swissAddKnockCol(wrap, 'SEMIFINALS',    _swissKnockMakeBox(sfPairs, sfResults, false));
  _swissAddKnockCol(wrap, 'FINAL',         _swissKnockMakeBox(finPairs, finResults, false));

  // Champion
  const champBox = _makeEl('div', 'swiss-bracket-group swiss-knock-champ-box');
  if (champion) {
    const card = _makeEl('div', 'swiss-match-card');
    const slot = _swissKnockMakeSlot(champion, true, false, false, true);
    slot.style.borderLeft = ''; slot.style.background = '';
    card.appendChild(slot);
    champBox.appendChild(card);
    champBox.appendChild(_makeEl('div', 'swiss-promote-label', '▲ PROMOTED TO TIER A', 'text-align:center;padding:8px 0 2px;'));
  } else {
    const card = _makeEl('div', 'swiss-match-card');
    card.appendChild(_swissKnockMakeSlot(null, false, false, false));
    champBox.appendChild(card);
  }
  _swissAddKnockCol(wrap, 'CHAMPION', champBox, false);

  _swissInitDragPan(wrap);
}

/* Pill header per il knockout — stile identico a _swissMakePillHeader */
function _swissKnockMakePill(label, dots) {
  const h = _makeEl('div', 'swiss-turn-header');
  h.appendChild(_makeEl('span', 'swiss-turn-label', label));
  if (dots && dots.length > 0) {
    const dotsWrap = _makeEl('span', 'swiss-dots-wrap');
    dots.forEach((d, gi) => {
      if (gi > 0) dotsWrap.appendChild(_makeEl('span', 'swiss-dots-sep'));
      dotsWrap.appendChild(_makeEl('span', 'swiss-dot ' + (d === 'win' ? 'win' : 'loss')));
    });
    h.appendChild(dotsWrap);
  }
  return h;
}

/* Calcola array di dot ('win'/'loss') per una fase knockout */
/* Box con le match card di una fase knockout — stile identico a swiss stage */
function _swissKnockMakeBox(pairs, results, markLosers = true, silverLosers = false) {
  const box = _makeEl('div', 'swiss-bracket-group');
  box.appendChild(_makeEl('div', 'swiss-bracket-group-header', ''));

  pairs.forEach(function(p, pairIdx) {
    if (pairIdx > 0) box.appendChild(_makeEl('div', 'swiss-match-sep'));
    const card = _makeEl('div', 'swiss-match-card');

    const mk = (p.a && p.b) ? _matchKey(p.a, p.b) : null;
    const res = mk ? results[mk] : null;
    let winnerName = null;
    if (res) {
      const [sA, sB, tA] = res;
      const wa = tA === p.a ? sA : sB;
      winnerName = wa > (tA === p.a ? sB : sA) ? p.a : p.b;
    }
    const matchPlayed = !!res;
    const isLoserA = markLosers ? p.a !== winnerName : false;
    const isLoserB = markLosers ? p.b !== winnerName : false;
    const isSilverA = silverLosers && matchPlayed && p.a !== winnerName;
    const isSilverB = silverLosers && matchPlayed && p.b !== winnerName;

    card.appendChild(_swissKnockMakeSlot(p.a, p.a === winnerName, false, matchPlayed, false, isLoserA && matchPlayed && !silverLosers, isSilverA));
    card.appendChild(_swissKnockMakeSlot(p.b, p.b === winnerName, true,  matchPlayed, false, isLoserB && matchPlayed && !silverLosers, isSilverB));
    box.appendChild(card);
  });

  return box;
}

/* Slot singolo identico a swiss-slot */
function _swissKnockMakeSlot(name, isWinner, isBottom, matchPlayed, showTrophy, forceLoser = false, forceSilver = false) {
  const stateCls = isWinner ? ' winner' : forceSilver ? ' silver-out' : forceLoser ? ' loser' : '';
  const slot = _makeEl('div', 'swiss-slot' + stateCls + (isBottom ? ' slot-bottom' : ''));
  const entry = name ? getEntryByName(name) : null;
  slot.appendChild(_makeSlotImg(entry));

  const nm = _makeEl('span', 'swiss-slot-name', name || '—');
  if (!name) { nm.style.color = 'var(--text-muted)'; slot.style.opacity = '0.35'; }
  slot.appendChild(nm);

  const badge = _makeEl('span', 'swiss-slot-badge');
  if (showTrophy) {
    badge.textContent = '🏆';
    badge.style.cssText = 'background:none;border:none;font-size:20px;';
  } else if (name && matchPlayed) {
    badge.classList.add(isWinner ? 'w' : 'l');
    badge.textContent = isWinner ? 'W' : 'L';
  } else {
    badge.style.visibility = 'hidden';
  }
  slot.appendChild(badge);

  return slot;
}

function _swissKnockGetWinners(pairs, results) {
  const winners = [];
  pairs.forEach(({a, b}) => {
    if (!a || !b) { winners.push(null); return; }
    const mk = _matchKey(a, b);
    const res = results[mk];
    if (!res) { winners.push(null); return; }
    const [sA, sB, tA] = res;
    const wa = tA === a ? sA : sB;
    const wb = tA === a ? sB : sA;
    winners.push(wa > wb ? a : b);
  });
  return winners;
}

/* ── Controlla se un turno è completamente giocato ── */
function _swissTurnFullyPlayed(group, turn) {
  const d = _swissData(group);
  const matches = _swissGenerateTurnMatches(group, turn);
  if (matches.length === 0) return false;
  const results = d[_swissTurnResultKey(turn)] || {};
  return matches.every(([a, b]) => !!results[_matchKey(a, b)]);
}

/* ── Avvia turno Swiss Stage ── */
function swissAvviaTurno() {
  const group = swissState.group;
  const d = _swissData(group);
  if (d.turn >= 5) return;

  swissState.matches    = _swissGenerateTurnMatches(group, d.turn);
  swissState.matchIdx   = 0;
  swissState.results    = [];
  swissState.phase      = 'stage';
  swissState.forcedTurn = null; // usa d.turn normale

  _swissSetupGiocaView(`TIER B — Group ${group}`, `Swiss — Turno ${d.turn + 1}`);
  showView('giocaMatchView');
  _swissRenderMatch();
}

/* ── Avvia fase Knockout ── */
function swissKnockAvviaFase() {
  const group = swissState.group;
  const d = _swissData(group);
  const rec = _swissGetRecordsUpTo(group, 4);
  const qfPlayers  = d.participants.filter(n => rec[n] && rec[n].w === 3);
  const qfPairs    = Array.from({length: 4}, (_, i) => ({a: qfPlayers[i*2]||null, b: qfPlayers[i*2+1]||null}));
  const qfResults  = d.kqfResults || {};
  const sfPlayers  = _swissKnockGetWinners(qfPairs, qfResults);
  const sfPairs    = [{a: sfPlayers[0]||null, b: sfPlayers[1]||null}, {a: sfPlayers[2]||null, b: sfPlayers[3]||null}];
  const sfResults  = d.ksfResults || {};
  const finPlayers = _swissKnockGetWinners(sfPairs, sfResults);
  const finResults = d.kfResults || {};

  if (swissState.knockPhase === 'qf') {
    swissState.knockMatches = qfPairs.filter(({a,b}) => a && b).map(({a,b}) => [a,b]);
  } else if (swissState.knockPhase === 'sf') {
    swissState.knockMatches = sfPairs.filter(({a,b}) => a && b).map(({a,b}) => [a,b]);
  } else {
    swissState.knockMatches = (finPlayers[0] && finPlayers[1]) ? [[finPlayers[0], finPlayers[1]]] : [];
  }
  if (swissState.knockMatches.length === 0) return;

  swissState.knockMatchIdx = 0;
  swissState.knockResults  = [];
  swissState.phase = 'knock';

  const phaseNames = {qf:'Quarti di Finale', sf:'Semifinali', final:'Finale'};
  _swissSetupGiocaView(`TIER B — Group ${group}`, `Knockout — ${phaseNames[swissState.knockPhase]}`);
  showView('giocaMatchView');
  _swissRenderKnockMatch();
}

/* ── Setup giocaMatchView per uso Swiss ── */
function _swissSetupGiocaView(tierLabel, roundLabel) {
  // Header
  const lbl = document.getElementById('giocaMatchDayLabel');
  if (lbl) lbl.textContent = tierLabel;
  const rnd = document.getElementById('giocaMatchProgress');
  if (rnd) rnd.textContent = roundLabel;

  // Nasconde TIE, rimappa Esci
  const tieBtn = document.getElementById('giocaDrawBtn');
  if (tieBtn) tieBtn.style.display = 'none';
  const exitBtn = document.querySelector('#giocaMatchView .btn-secondary');
  if (exitBtn) { exitBtn.onclick = swissMatchEsci; }

  // Rimappa i click dei contestant
  const left  = document.getElementById('giocaContLeft');
  const right = document.getElementById('giocaContRight');
  if (left)  left.onclick  = () => swissPick(0);
  if (right) right.onclick = () => swissPick(1);
}

/* ── Render match Swiss Stage ── */
function _swissRenderMatch() {
  const total   = swissState.matches.length;
  const current = swissState.matchIdx;
  const [a, b]  = swissState.matches[current];

  const counter = document.getElementById('giocaMatchCounter');
  if (counter) counter.textContent = `Match ${current + 1} / ${total}`;

  // Mostra il record attuale dei due opening nel sottotitolo del match
  const turn = swissState.forcedTurn !== null ? swissState.forcedTurn : _swissData(swissState.group).turn;
  const rnd = document.getElementById('giocaMatchProgress');
  if (rnd && swissState.group && turn > 0) {
    const rec = _swissGetRecordsUpTo(swissState.group, turn - 1);
    const ra = rec[a] || {w:0, l:0};
    const rb = rec[b] || {w:0, l:0};
    const clsA = ra.w > ra.l ? 'win' : ra.l > ra.w ? 'loss' : 'neutral';
    rnd.innerHTML = `Swiss \u2014 Turno ${turn + 1}&ensp;<span class="swiss-record-pill ${clsA}">${ra.w}-${ra.l}</span>`;
  }

  _swissSetContestants(a, b);
}

/* ── Render match Knockout ── */
function _swissRenderKnockMatch() {
  const total   = swissState.knockMatches.length;
  const current = swissState.knockMatchIdx;
  const [a, b]  = swissState.knockMatches[current];

  const counter = document.getElementById('giocaMatchCounter');
  if (counter) counter.textContent = `Match ${current + 1} / ${total}`;

  _swissSetContestants(a, b);
}

function _swissSetContestants(a, b) {
  if (typeof stopCampPlaylist === 'function') stopCampPlaylist();
  const ea = getEntryByName(a), eb = getEntryByName(b);
  document.getElementById('giocaContLeft').className  = 'contestant';
  document.getElementById('giocaContRight').className = 'contestant';
  _giocaSetContestantImg(document.getElementById('giocaContLeftImg'),  imgSrc(ea) || '');
  _giocaSetContestantImg(document.getElementById('giocaContRightImg'), imgSrc(eb) || '');
  document.getElementById('giocaContLeftName').textContent  = a;
  document.getElementById('giocaContRightName').textContent = b;
  _gPlayers.giocaLeft.load(ea  || null, undefined, false); _gPlayers.giocaLeft.initSeek();
  _gPlayers.giocaRight.load(eb || null, undefined, false); _gPlayers.giocaRight.initSeek();
}

/* ── Pick / Draw ── */
function swissPick(side) {
  const isKnock = swissState.phase === 'knock';
  const matches = isKnock ? swissState.knockMatches : swissState.matches;
  const idx     = isKnock ? swissState.knockMatchIdx : swissState.matchIdx;
  const [a, b]  = matches[idx];

  const cardId = side === 0 ? 'giocaContLeft' : 'giocaContRight';
  document.getElementById(cardId).classList.add('picked');
  _gPlayers.giocaLeft.stop();
  _gPlayers.giocaRight.stop();

  const scoreA = side === 0 ? 2 : 0;
  const scoreB = side === 0 ? 0 : 2;

  if (isKnock) {
    swissState.knockResults.push({a, b, scoreA, scoreB});
    swissState.knockMatchIdx++;
    setTimeout(_swissKnockAdvance, 420);
  } else {
    swissState.results.push({a, b, scoreA, scoreB});
    swissState.matchIdx++;
    setTimeout(_swissAdvance, 420);
  }
}

function _swissAdvance() {
  if (swissState.matchIdx >= swissState.matches.length) {
    _swissSalvaTurno();
  } else {
    _swissRenderMatch();
  }
}

function _swissKnockAdvance() {
  if (swissState.knockMatchIdx >= swissState.knockMatches.length) {
    _swissSalvaKnock();
  } else {
    _swissRenderKnockMatch();
  }
}

function _swissSalvaTurno() {
  const group = swissState.group;
  const d = _swissData(group);
  // Se il turno è stato forzato da giocaDayView, salva su quel turno specifico
  const targetTurn = (swissState.forcedTurn !== null) ? swissState.forcedTurn : d.turn;
  swissState.forcedTurn = null; // reset
  const key = _swissTurnResultKey(targetTurn);
  const dayResults = {};
  swissState.results.forEach(r => {
    dayResults[_matchKey(r.a, r.b)] = [r.scoreA, r.scoreB, r.a];
  });
  // Rollback di sicurezza: se si sta salvando un turno già passato,
  // cancella i turni successivi e il knockout (non dovrebbe mai servire
  // perché _campGiocaAvviaTurnoB ha già fatto rollback, ma è una rete di sicurezza)
  if (targetTurn < d.turn) {
    _swissRollbackFrom(group, targetTurn);
  }
  // Rimpiazza completamente i risultati del turno (non merge):
  // in caso di replay i match possono cambiare, e i vecchi result-key non devono sopravvivere.
  d[key] = dayResults;
  // Avanza d.turn se questo turno è ora completato e non era già avanzato
  if (d.turn === targetTurn && _swissTurnFullyPlayed(group, targetTurn)) {
    d.turn++;
  }
  _invalidateTurnMatchesCache(group);
  _invalidateRecordsCache(group);
  campionatoSave();
  _swissRestoreGiocaView();
  _swissShowEndTurno();
}

function _swissSalvaKnock() {
  const group = swissState.group;
  const d = _swissData(group);
  const resKey = swissState.knockPhase === 'qf' ? 'kqfResults' : swissState.knockPhase === 'sf' ? 'ksfResults' : 'kfResults';
  swissState.knockResults.forEach(r => {
    d[resKey][_matchKey(r.a, r.b)] = [r.scoreA, r.scoreB, r.a];
  });
  campionatoSave();
  _swissRestoreGiocaView();
  _swissShowEndKnock();
}

function _swissShowEndTurno() {
  const d = _swissData(swissState.group);
  // d.turn è già stato incrementato in _swissSalvaTurno se il turno era completo
  const completedTurn = Math.max(0, d.turn - 1);
  document.getElementById('swissEndLabel').textContent = `TURNO ${completedTurn + 1} COMPLETATO`;
  const el = document.getElementById('swissEndResults');
  el.replaceChildren();
  swissState.results.forEach(r => {
    const ea = getEntryByName(r.a);
    const eb = getEntryByName(r.b);
    const row = _swissMakeResultRow(r.a, r.b, r.scoreA, r.scoreB, ea, eb);
    el.appendChild(row);
  });
  const nextBtn = document.getElementById('swissEndNextBtn');
  if (nextBtn) {
    if (d.turn < 5) {
      nextBtn.style.display = '';
      nextBtn.textContent = `Turno ${d.turn + 1} →`;
    } else {
      nextBtn.style.display = '';
      nextBtn.textContent = '🏆 Vai al Knockout Stage →';
    }
  }
  showView('swissEndView');
}

function _swissShowEndKnock() {
  const phaseNames = {qf:'QUARTI DI FINALE', sf:'SEMIFINALI', final:'FINALE'};
  document.getElementById('swissEndLabel').textContent = phaseNames[swissState.knockPhase] + ' COMPLETATI';
  const el = document.getElementById('swissEndResults');
  el.replaceChildren();
  swissState.knockResults.forEach(r => {
    const ea = getEntryByName(r.a);
    const eb = getEntryByName(r.b);
    const row = _swissMakeResultRow(r.a, r.b, r.scoreA, r.scoreB, ea, eb);
    el.appendChild(row);
  });
  const nextBtn = document.getElementById('swissEndNextBtn');
  if (nextBtn) {
    const phaseOrder = ['qf','sf','final'];
    const curIdx = phaseOrder.indexOf(swissState.knockPhase);
    const hasNext = curIdx < phaseOrder.length - 1;
    nextBtn.style.display = hasNext ? '' : 'none';
    if (hasNext) {
      const nextPhase = phaseOrder[curIdx + 1];
      const nextNames = {sf:'Semifinali', final:'Finale'};
      nextBtn.textContent = `${nextNames[nextPhase]} →`;
    }
  }
  showView('swissEndView');
}

function _makeEndImg(entry, side) {
  const sideCls = side === 'left' ? 'gioca-end-img-left' : 'gioca-end-img-right';
  if (imgSrc(entry)) {
    const img = _makeEl('img', 'gioca-end-img ' + sideCls);
    img.src = imgSrc(entry); img.loading = 'lazy';
    img.onerror = function() { this.replaceWith(_makeEndImgPlaceholder()); };
    return img;
  }
  const ph = _makeEndImgPlaceholder();
  ph.classList.add(sideCls);
  return ph;
}
function _makeEndImgPlaceholder() {
  return _makeEl('span', 'gioca-end-img-placeholder', '🎵');
}

/* ── Riga risultato ── */
function _makeEndRow(a, b, scoreA, scoreB, ea, eb, scoreColor, isSwiss) {
  const row = _makeEl('div', 'gioca-end-row');

  const teamA = _makeEl('div', 'gioca-end-team left');
  teamA.appendChild(_makeEl('span', 'gioca-end-team-name', a));

  const imgA = _makeEndImg(ea, 'left');

  let center;
  if (isSwiss) {
    const aWon = scoreA > scoreB;
    center = _makeEl('div', 'swiss-result-badge');
    center.innerHTML = aWon
      ? `<span class="swiss-badge-w">W</span><span class="swiss-badge-sep">·</span><span class="swiss-badge-l">L</span>`
      : `<span class="swiss-badge-l">L</span><span class="swiss-badge-sep">·</span><span class="swiss-badge-w">W</span>`;
  } else {
    center = _makeEl('div', 'gioca-end-score', `${scoreA} – ${scoreB}`);
    if (scoreColor) center.style.color = scoreColor;
  }

  const imgB = _makeEndImg(eb, 'right');

  const teamB = _makeEl('div', 'gioca-end-team right');
  teamB.appendChild(_makeEl('span', 'gioca-end-team-name', b));

  row.appendChild(teamA); row.appendChild(imgA); row.appendChild(center);
  row.appendChild(imgB);  row.appendChild(teamB);
  return row;
}

function _swissMakeResultRow(a, b, scoreA, scoreB, ea, eb) {
  return _makeEndRow(a, b, scoreA, scoreB, ea, eb, null, true);
}

/* ── Drag-to-pan sul bracket ── */
function _swissInitDragPan(wrap) {
  // Trova il container che effettivamente scrolla orizzontalmente
  function getScrollContainer() {
    let el = wrap.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const overflowX = style.overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth) {
        return el;
      }
      el = el.parentElement;
    }
    return document.body;
  }

  let isDown = false, startX = 0, startScrollLeft = 0;
  let container = null;

  wrap.addEventListener('mousedown', e => {
    if (e.target.closest('.swiss-slot, .swiss-knock-slot, .swiss-result-slot')) return;
    container = getScrollContainer();
    isDown = true;
    wrap.classList.add('is-dragging');
    startX = e.clientX;
    startScrollLeft = container.scrollLeft;
    e.preventDefault();
  });

  window.addEventListener('mouseup', () => {
    isDown = false;
    wrap.classList.remove('is-dragging');
  });

  window.addEventListener('mousemove', e => {
    if (!isDown || !container) return;
    container.scrollLeft = startScrollLeft - (e.clientX - startX);
  });

  // Touch
  let tx = 0, tsl = 0;
  wrap.addEventListener('touchstart', e => {
    container = getScrollContainer();
    tx = e.touches[0].clientX;
    tsl = container.scrollLeft;
  }, { passive: true });
  wrap.addEventListener('touchmove', e => {
    if (!container) return;
    container.scrollLeft = tsl - (e.touches[0].clientX - tx);
  }, { passive: true });

  // Path highlight
  _swissInitPathHighlight(wrap);
}

/* ── Highlight percorso elemento su hover ── */
function _swissInitPathHighlight(wrap) {
  let svg = document.getElementById('swissPathSvg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'swissPathSvg';
    svg.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:0;overflow:visible;';
    document.body.appendChild(svg);
  }

  // Nome correntemente evidenziato — serve per ridisegnare allo scroll
  let _currentHighlightName = null;

  // Ridisegna le sole linee SVG (senza toccare le classi CSS già applicate)
  function _redrawLines() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!_currentHighlightName) return;
    const allSlots = [
      ...Array.from(wrap.querySelectorAll('.swiss-slot'))
        .filter(s => s.querySelector('.swiss-slot-name')?.textContent === _currentHighlightName && _isVisible(s)),
      ...Array.from(document.querySelectorAll('.swiss-result-slot'))
        .filter(s => s.querySelector('.swiss-result-name')?.textContent === _currentHighlightName && _isVisible(s)),
    ].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    for (let i = 0; i < allSlots.length - 1; i++) {
      const a = allSlots[i].getBoundingClientRect();
      const b = allSlots[i + 1].getBoundingClientRect();
      const x1 = a.right, y1 = a.top + a.height / 2;
      const x2 = b.left,  y2 = b.top  + b.height / 2;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const cx = (x1 + x2) / 2;
      p.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + cx + ' ' + y1 + ', ' + cx + ' ' + y2 + ', ' + x2 + ' ' + y2);
      p.setAttribute('stroke', 'rgba(180,120,40,0.9)');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke-dasharray', '5 3');
      svg.appendChild(p);
    }
  }

  // Ascolta scroll su tutti i container scrollabili nel percorso del wrap + window
  // Usa un AbortController per poter rimuovere tutti i listener in blocco
  let _scrollAbort = null;
  function _bindScrollListeners() {
    if (_scrollAbort) _scrollAbort.abort();
    _scrollAbort = new AbortController();
    const signal = _scrollAbort.signal;
    let el = wrap.parentElement;
    while (el && el !== document.body) {
      const ov = window.getComputedStyle(el).overflowX;
      if (ov === 'auto' || ov === 'scroll') {
        el.addEventListener('scroll', _redrawLines, { passive: true, signal });
      }
      el = el.parentElement;
    }
    window.addEventListener('scroll', _redrawLines, { passive: true, signal });
  }
  _bindScrollListeners();

  // Hover sugli slot del bracket — delegazione su slot specifici
  function _bindSlotHover() {
    wrap.querySelectorAll('.swiss-slot').forEach(slot => {
      slot.addEventListener('mouseenter', function() {
        const nameEl = slot.querySelector('.swiss-slot-name');
        if (!nameEl) return;
        const name = nameEl.textContent.trim();
        if (!name || name === '—') return;
        _currentHighlightName = name;
        _swissHighlightPath(wrap, svg, name);
      });
      slot.addEventListener('mouseleave', function(e) {
        if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) {
          _currentHighlightName = null;
          _swissClearHighlight(svg);
        }
      });
    });
  }
  _bindSlotHover();

  // Espone _bindSlotHover sul wrap così swissRenderStageBracket può richiamarla dopo ogni render
  wrap._rebindHighlight = _bindSlotHover;

  if (!wrap._highlightMouseleave) {
    wrap._highlightMouseleave = true;
    wrap.addEventListener('mouseleave', function() { _currentHighlightName = null; _swissClearHighlight(svg); });
  }

  // Hover sugli slot dei risultati (QF/Eliminated) — usa event delegation sul panel
  const panelStage = document.getElementById('swissPanelStage');
  if (panelStage && !panelStage._resultHoverInit) {
    panelStage._resultHoverInit = true;
    panelStage.addEventListener('mouseover', function(e) {
      const slot = e.target.closest('.swiss-result-slot');
      if (!slot) return;
      const nameEl = slot.querySelector('.swiss-result-name');
      if (!nameEl) return;
      _currentHighlightName = nameEl.textContent.trim();
      _swissHighlightPath(wrap, svg, _currentHighlightName);
    });
    panelStage.addEventListener('mouseleave', function(e) {
      if (!e.relatedTarget || !panelStage.contains(e.relatedTarget)) {
        _currentHighlightName = null;
        _swissClearHighlight(svg);
      }
    });
  }
}

/* Restituisce true se l'elemento è effettivamente visibile nel DOM (nessun antenato con display:none) */
function _isVisible(el) {
  // checkVisibility() è disponibile in tutti i browser moderni ed è O(1) lato engine
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  // Fallback: risale il DOM
  while (el && el !== document.body) {
    if (window.getComputedStyle(el).display === 'none') return false;
    el = el.parentElement;
  }
  return true;
}

function _swissHighlightPath(wrap, svg, name) {
  _swissClearHighlight(svg);

  const bracketSlots = Array.from(wrap.querySelectorAll('.swiss-slot'))
    .filter(s => s.querySelector('.swiss-slot-name')?.textContent === name && _isVisible(s));
  const resultSlots = Array.from(document.querySelectorAll('.swiss-result-slot'))
    .filter(s => s.querySelector('.swiss-result-name')?.textContent === name && _isVisible(s));

  bracketSlots.forEach(s => s.classList.add('path-highlight'));
  resultSlots.forEach(s => s.classList.add('path-highlight-result'));

  // Ordina tutti gli slot da sinistra a destra per seguire il percorso cronologico
  const allSlots = [...bracketSlots, ...resultSlots]
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

  for (let i = 0; i < allSlots.length - 1; i++) {
    const a = allSlots[i].getBoundingClientRect();
    const b = allSlots[i + 1].getBoundingClientRect();
    const x1 = a.right, y1 = a.top + a.height / 2;
    const x2 = b.left,  y2 = b.top  + b.height / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const cx = (x1 + x2) / 2;
    path.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`);
    path.setAttribute('stroke', 'rgba(180,120,40,0.9)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-dasharray', '5 3');
    svg.appendChild(path);
  }
}

function _swissClearHighlight(svg) {
  document.querySelectorAll('.swiss-slot.path-highlight')
    .forEach(s => s.classList.remove('path-highlight'));
  document.querySelectorAll('.swiss-result-slot.path-highlight-result')
    .forEach(s => s.classList.remove('path-highlight-result'));
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function swissEndBack() {
  if (giocaState.tier === 'B' && _giocaBGroup) {
    document.body.style.overflowX = '';
    _renderGiocaBTurnList();
    showView('giocaDayView');
  } else if (giocaState.tier === 'C' && tierCState.group) {
    document.body.style.overflowX = '';
    _renderGiocaCTurnList();
    showView('giocaDayView');
  } else {
    showView('swissHubView');
    swissShowTab(swissState.phase === 'knock' ? 'knock' : 'stage');
  }
}

function swissEndContinua() {
  if (swissState.phase === 'knock') {
    const phaseOrder = ['qf','sf','final'];
    const curIdx = phaseOrder.indexOf(swissState.knockPhase);
    if (curIdx < phaseOrder.length - 1) {
      swissState.knockPhase = phaseOrder[curIdx + 1];
    }
    if (giocaState.tier === 'B' && _giocaBGroup) {
      const phaseKeyMap = { qf: 'kqfResults', sf: 'ksfResults', final: 'kfResults' };
      _campGiocaAvviaKnockB(phaseKeyMap[swissState.knockPhase]);
    } else {
      showView('swissHubView');
      swissShowTab('knock');
    }
  } else {
    const d = _swissData(swissState.group);
    if (giocaState.tier === 'B' && _giocaBGroup) {
      if (d.turn >= 5) {
        swissState.knockPhase = 'qf';
        _campGiocaAvviaKnockB('kqfResults');
      } else {
        _campGiocaAvviaTurnoB(d.turn);
      }
    } else {
      showView('swissHubView');
      swissShowTab(d.turn >= 5 ? 'knock' : 'stage');
    }
  }
}

function swissMatchEsci() {
  _gPlayers.giocaLeft.stop();
  _gPlayers.giocaRight.stop();
  swissState.forcedTurn = null;
  _swissRestoreGiocaView();
  if (giocaState.tier === 'B' && _giocaBGroup) {
    document.body.style.overflowX = '';
    _renderGiocaBTurnList();
    showView('giocaDayView');
  } else if (giocaState.tier === 'C' && tierCState.group) {
    document.body.style.overflowX = '';
    _renderGiocaCTurnList();
    showView('giocaDayView');
  } else {
    showView('swissHubView');
    swissShowTab(swissState.phase === 'knock' ? 'knock' : 'stage');
  }
}

/* ── Ripristina giocaMatchView per Tier S/A ── */
function _swissRestoreGiocaView() {
  const tieBtn = document.getElementById('giocaDrawBtn');
  if (tieBtn) tieBtn.style.display = '';
  const exitBtn = document.querySelector('#giocaMatchView .btn-secondary');
  if (exitBtn) exitBtn.onclick = campGiocaEsci;
  const left  = document.getElementById('giocaContLeft');
  const right = document.getElementById('giocaContRight');
  if (left)  left.onclick  = () => giocaPick(0);
  if (right) right.onclick = () => giocaPick(1);
}


/* ══════════════════════════════════════════════════════════════
   TIER C — KNOCKOUT PURO (16 partecipanti per gruppo)

   Struttura dati campionatoData._knockC:
   {
     "A": {   // group letter
       // MAIN BRACKET
       r16Results: {},   // Ottavi: 8 match (16→8 vincitori)
       qfResults:  {},   // Quarti: 4 match
       sfResults:  {},   // Semifinali: 2 match
       fResults:   {},   // Finale: 1 match
       // SILVER BRACKET (8 perdenti dagli ottavi)
       sv1Results: {},   // Silver R1: 4 match (8→4) — chi perde → D
       sv2Results: {},   // Silver R2: 4 match (4 vincitori + 4 perdenti sv1 NO — solo i 4 vincitori sv1)
                         // NB: in realtà Silver R2 ha 2 match con i 4 sopravvissuti di sv1
                         // Chi perde sv2 → Silver Final
       svfResults: {},   // Silver Final: 1 match — vincitore salvo, perdente → D
     }
   }

   Flusso Silver Bracket:
   - 8 perdenti ottavi entrano in Silver R1 (4 match)
   - Chi perde Silver R1 (4) → eliminato → retrocede a D
   - Chi vince Silver R1 (4) → Silver R2 (2 match)
   - Chi vince Silver R2 (2) → SALVO (rimane in C)
   - Chi perde Silver R2 (2) → Silver Final (1 match)
   - Chi vince Silver Final → SALVO
   - Chi perde Silver Final → retrocede a D

   Main Bracket:
   - Vincitore Finale → promosso a B
   - Tutti gli altri del main (posti 2-8) → rimangono in C

══════════════════════════════════════════════════════════════ */

/* ── Accesso dati Tier C ── */
function _knockCData(group) {
  if (!campionatoData._knockC) campionatoData._knockC = {};
  if (!campionatoData._knockC[group]) {
    const dist = distributeGroups('C');
    const p = dist[group] || [];
    campionatoData._knockC[group] = {
      participants: [...p],
      r16Results: {}, qfResults: {}, sfResults: {}, fResults: {},
      sv1Results: {}, sv2Results: {}, svfResults: {}
    };
  }
  return campionatoData._knockC[group];
}

/* ── Helper: ottieni vincitore di un match ── */
function _knockCGetWinner(results, a, b) {
  if (!a || !b) return null;
  const mk = _matchKey(a, b);
  const res = results[mk];
  if (!res) return null;
  const [sA, sB, tA] = res;
  const wa = tA === a ? sA : sB;
  return wa > (tA === a ? sB : sA) ? a : b;
}

function _knockCGetLoser(results, a, b) {
  if (!a || !b) return null;
  const w = _knockCGetWinner(results, a, b);
  if (!w) return null;
  return w === a ? b : a;
}

/* ── Calcola i partecipanti di ogni fase dal bracket ── */
function _knockCGetMainPairs(group, phase) {
  const d = _knockCData(group);
  const p = d.participants;
  // 16 partecipanti → 8 match ottavi
  if (phase === 'r16') {
    return Array.from({length: 8}, (_, i) => ({a: p[i*2]||null, b: p[i*2+1]||null}));
  }
  if (phase === 'qf') {
    const r16Pairs = _knockCGetMainPairs(group, 'r16');
    const winners = r16Pairs.map(({a,b}) => _knockCGetWinner(d.r16Results, a, b));
    return Array.from({length: 4}, (_, i) => ({a: winners[i*2]||null, b: winners[i*2+1]||null}));
  }
  if (phase === 'sf') {
    const qfPairs = _knockCGetMainPairs(group, 'qf');
    const winners = qfPairs.map(({a,b}) => _knockCGetWinner(d.qfResults, a, b));
    return Array.from({length: 2}, (_, i) => ({a: winners[i*2]||null, b: winners[i*2+1]||null}));
  }
  if (phase === 'f') {
    const sfPairs = _knockCGetMainPairs(group, 'sf');
    const winners = sfPairs.map(({a,b}) => _knockCGetWinner(d.sfResults, a, b));
    return [{a: winners[0]||null, b: winners[1]||null}];
  }
  return [];
}

function _knockCGetSilverPairs(group, phase) {
  const d = _knockCData(group);
  // Silver R1: 8 perdenti degli ottavi → 4 match
  if (phase === 'sv1') {
    const r16Pairs = _knockCGetMainPairs(group, 'r16');
    const losers = r16Pairs.map(({a,b}) => _knockCGetLoser(d.r16Results, a, b));
    return Array.from({length: 4}, (_, i) => ({a: losers[i*2]||null, b: losers[i*2+1]||null}));
  }
  // Silver R2: 4 vincitori di sv1 → 2 match
  if (phase === 'sv2') {
    const sv1Pairs = _knockCGetSilverPairs(group, 'sv1');
    const winners = sv1Pairs.map(({a,b}) => _knockCGetWinner(d.sv1Results, a, b));
    return Array.from({length: 2}, (_, i) => ({a: winners[i*2]||null, b: winners[i*2+1]||null}));
  }
  // Silver Final: 2 perdenti di sv2 → 1 match
  if (phase === 'svf') {
    const sv2Pairs = _knockCGetSilverPairs(group, 'sv2');
    const losers = sv2Pairs.map(({a,b}) => _knockCGetLoser(d.sv2Results, a, b));
    return [{a: losers[0]||null, b: losers[1]||null}];
  }
  return [];
}

/* ── Vincitore/retrocessi Tier C ── */
function _knockCGetChampion(group) {
  const d = _knockCData(group);
  const fPairs = _knockCGetMainPairs(group, 'f');
  return _knockCGetWinner(d.fResults, fPairs[0].a, fPairs[0].b);
}

function _knockCGetRelegated(group) {
  // Retrocedono in D:
  // - 4 perdenti di Silver R1
  // - 1 perdente Silver Final
  const d = _knockCData(group);
  const rel = [];
  const sv1Pairs = _knockCGetSilverPairs(group, 'sv1');
  sv1Pairs.forEach(({a,b}) => {
    const loser = _knockCGetLoser(d.sv1Results, a, b);
    if (loser) rel.push(loser);
  });
  const svfPairs = _knockCGetSilverPairs(group, 'svf');
  const svfLoser = _knockCGetLoser(d.svfResults, svfPairs[0]?.a, svfPairs[0]?.b);
  if (svfLoser) rel.push(svfLoser);
  return rel;
}

function _knockCIsTournamentComplete(group) {
  const d = _knockCData(group);
  const fPairs = _knockCGetMainPairs(group, 'f');
  if (!_knockCGetWinner(d.fResults, fPairs[0]?.a, fPairs[0]?.b)) return false;
  const svfPairs = _knockCGetSilverPairs(group, 'svf');
  if (!_knockCGetWinner(d.svfResults, svfPairs[0]?.a, svfPairs[0]?.b)) return false;
  return true;
}

/* ── NAVIGAZIONE ── */

function _campGiocaApriSceltaGruppoC() {
  const sl = document.getElementById('giocaCGroupSeasonLabel');
  if (sl) sl.textContent = getCurrentSeasonLabel();
  const btns = document.getElementById('giocaCGroupBtns');
  if (!btns) return;
  btns.innerHTML = TIER_CONFIG['C'].groups.map(g => {
    const d = _knockCData(g);
    const complete = _knockCIsTournamentComplete(g);
    const r16Done = Object.keys(d.r16Results).length >= 8;
    const qfDone  = r16Done && Object.keys(d.qfResults).length >= 4;
    const sfDone  = qfDone  && Object.keys(d.sfResults).length >= 2;
    const fDone   = sfDone  && Object.keys(d.fResults).length >= 1;
    const label = complete ? '🏆 Completato' : fDone ? '⚔️ Silver Final' : sfDone ? '⚔️ Finale' : qfDone ? '⚔️ Semifinali' : r16Done ? '⚔️ Quarti di Finale' : '○ Ottavi di Finale';
    return _campGruppoBtn('C', g, label);
  }).join('');
  showView('giocaCGroupView');
}


function _renderGiocaCTurnList() {
  const group = tierCState.group;
  const d     = _knockCData(group);
  const el    = document.getElementById('giocaDayList');
  if (!el) return;

  const r16Done = Object.keys(d.r16Results).length >= 8;
  const qfDone  = r16Done && Object.keys(d.qfResults).length >= 4;
  const sfDone  = qfDone  && Object.keys(d.sfResults).length >= 2;
  const fDone   = sfDone  && Object.keys(d.fResults).length >= 1;
  const sv1Done = r16Done && Object.keys(d.sv1Results).length >= 4;
  const sv2Done = sv1Done && Object.keys(d.sv2Results).length >= 2;
  const svfDone = sv2Done && Object.keys(d.svfResults).length >= 1;

  // Check se ogni fase ha dati sufficenti per essere giocabile
  const qfPlayable  = r16Done;
  const sfPlayable  = qfDone;
  const fPlayable   = sfDone;
  const sv1Playable = r16Done;
  const sv2Playable = sv1Done;
  const svfPlayable = sv2Done;

  function makeRow(label, played, playable, onclick, nextPlayed = false) {
    const locked = (!playable && !played) || (played && nextPlayed);
    return `<div class="gioca-day-row${played ? ' played' : ''}${locked ? ' locked' : ''}"
      onclick="${locked ? '' : onclick}"
      style="${locked ? 'opacity:.4;cursor:default' : 'cursor:pointer'}">
      <span class="gioca-day-num">${label}</span>
      <span class="gioca-day-status${played ? ' done' : locked ? ' locked' : ''}">${played ? '✅ Completato' : locked ? '🔒 Bloccato' : '○ Da giocare'}</span>
      <span style="color:#60608a;font-size:18px">${locked ? '' : '›'}</span>
    </div>`;
  }

  const hdrMain   = `<div style="grid-column:1;font-size:11px;font-weight:700;letter-spacing:.1em;color:#7c6fff;opacity:.7;padding:0 0 2px 12px;text-transform:uppercase">Main Bracket</div>`;
  const hdrSilver = `<div style="grid-column:2;font-size:11px;font-weight:700;letter-spacing:.1em;color:#b4b4d2;opacity:.7;padding:0 0 2px 12px;text-transform:uppercase">Silver Bracket</div>`;
  const emptySlot = `<div style="grid-column:2"></div>`;

  el.innerHTML =
    hdrMain + hdrSilver +
    makeRow('Ottavi di Finale', r16Done, true,        `_campGiocaAvviaKnockC('r16')`, qfDone) +
    makeRow('Round 1',          sv1Done, sv1Playable, `_campGiocaAvviaKnockC('sv1')`, sv2Done) +
    makeRow('Quarti di Finale', qfDone,  qfPlayable,  `_campGiocaAvviaKnockC('qf')`,  sfDone) +
    makeRow('Round 2',          sv2Done, sv2Playable, `_campGiocaAvviaKnockC('sv2')`, svfDone) +
    makeRow('Semifinali',       sfDone,  sfPlayable,  `_campGiocaAvviaKnockC('sf')`,  fDone) +
    makeRow('Round 3',          svfDone, svfPlayable, `_campGiocaAvviaKnockC('svf')`, false) +
    makeRow('Finale',           fDone,   fPlayable,   `_campGiocaAvviaKnockC('f')`,   false) +
    emptySlot;
}

/* ── Apri tabellone Tier C (hub view) ── */
function tierCOpenGroup(group) {
  tierCState.group = group;
  tierCState.phase  = 'main';
  const d = _knockCData(group);
  if (d.participants.length === 0) {
    const dist = distributeGroups('C');
    d.participants = [...(dist[group] || [])];
  }

  const label = document.getElementById('tierCHubLabel');
  if (label) { label.textContent = `TIER C — Group ${group}`; label.style.color = TIER_CONFIG['C'].color; }
  const sl = document.getElementById('tierCHubSeason');
  if (sl) sl.textContent = getCurrentSeasonLabel();

  document.body.style.overflowX = 'auto';
  showView('tierCHubView');
  document.body.classList.add('swiss-active');
  _initHubDragPan('#tierCHubView .swiss-hub-body');
  tierCShowPanel('main');
}

function tierCBack() {
  document.body.classList.remove('swiss-active');
  document.body.style.overflowX = '';
  showView('campionatoTierView');
  campionatoUI.currentGroup = tierCState.group;
  renderCampionatoTier();
}

function tierCTogglePanel() {
  const isMain = document.getElementById('tierCPanelMain').style.display !== 'none';
  tierCShowPanel(isMain ? 'silver' : 'main');
}

function tierCShowPanel(panel) {
  tierCState.phase = panel;
  document.getElementById('tierCPanelMain').style.display   = panel === 'main'   ? '' : 'none';
  document.getElementById('tierCPanelSilver').style.display = panel === 'silver' ? '' : 'none';

  const btn = document.getElementById('tierCNavBtn');
  if (btn) btn.textContent = panel === 'main' ? 'SILVER BRACKET →' : '← MAIN BRACKET';

  const lgGreen  = document.getElementById('tierCLegendGreen');
  const lgRed    = document.getElementById('tierCLegendRed');
  const lgSilver = document.getElementById('tierCLegendSilver');
  if (lgGreen)  lgGreen.style.display  = panel === 'main'   ? '' : 'none';
  if (lgSilver) lgSilver.style.display = panel === 'main'   ? '' : 'none';
  if (lgRed)    lgRed.style.display    = panel === 'silver' ? '' : 'none';

  if (panel === 'main')   tierCRenderMainBracket();
  if (panel === 'silver') tierCRenderSilverBracket();
}

/* ── Render Main Bracket ── */
// ── Helper colonna bracket knockout ─────────────────────────────────────
// Crea una colonna con pill-label, appende body, la aggiunge a wrap.
// Se addConnector=true aggiunge anche il connettore freccia.
function _swissAddKnockCol(wrap, label, body, addConnector = true, justify = 'center') {
  const col = _swissMakeCol();
  col.style.justifyContent = justify;
  if (label) col.appendChild(_swissKnockMakePill(label, []));
  col.appendChild(body);
  wrap.appendChild(col);
  if (addConnector) wrap.appendChild(_swissConnector());
}
function tierCRenderMainBracket() {
  const group = tierCState.group;
  const d = _knockCData(group);
  const wrap = document.getElementById('tierCMainWrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const r16Pairs = _knockCGetMainPairs(group, 'r16');
  const qfPairs  = _knockCGetMainPairs(group, 'qf');
  const sfPairs  = _knockCGetMainPairs(group, 'sf');
  const fPairs   = _knockCGetMainPairs(group, 'f');
  const champion = _knockCGetChampion(group);

  _swissAddKnockCol(wrap, 'OTTAVI',    _swissKnockMakeBox(r16Pairs, d.r16Results, false, true));
  _swissAddKnockCol(wrap, 'QUARTI',    _swissKnockMakeBox(qfPairs,  d.qfResults,  false));
  _swissAddKnockCol(wrap, 'SEMIFINALI',_swissKnockMakeBox(sfPairs,  d.sfResults,  false));
  _swissAddKnockCol(wrap, 'FINALE',    _swissKnockMakeBox(fPairs,   d.fResults,   false));

  // Champion
  const champBox = _makeEl('div', 'swiss-bracket-group swiss-knock-champ-box');
  const card = _makeEl('div', 'swiss-match-card');
  if (champion) {
    card.appendChild(_swissKnockMakeSlot(champion, true, false, false, true));
    champBox.appendChild(card);
    champBox.appendChild(_makeEl('div', 'swiss-promote-label', '▲ PROMOTED TO TIER B', 'text-align:center;padding:8px 0 2px;'));
  } else {
    card.appendChild(_swissKnockMakeSlot(null, false, false, false));
    champBox.appendChild(card);
  }
  _swissAddKnockCol(wrap, 'CAMPIONE', champBox, false);

  _swissInitDragPan(wrap);
}

/* ── Render Silver Bracket ── */
function tierCRenderSilverBracket() {
  const group = tierCState.group;
  const d = _knockCData(group);
  const wrap = document.getElementById('tierCSilverWrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const r16Done  = Object.keys(d.r16Results).length >= 8;
  const sv1Pairs = _knockCGetSilverPairs(group, 'sv1');
  const sv2Pairs = _knockCGetSilverPairs(group, 'sv2');
  const svfPairs = _knockCGetSilverPairs(group, 'svf');

  const innerWrap = _makeEl('div', null, null, 'display:flex;align-items:flex-start;gap:0;');
  wrap.appendChild(innerWrap);

  function makeSilverCol(label, pairs, results, connector, connLabel, connOffsetY, markLosers = true) {
    const col = _swissMakeCol();
    col.style.justifyContent = 'flex-start';
    const spacerT = _makeEl('div'); spacerT.style.flex = '1';
    col.appendChild(spacerT);
    const pill = _swissKnockMakePill(label, []);
    pill.style.cssText = (pill.style.cssText || '') + 'border-color:rgba(180,180,210,.4);';
    col.appendChild(pill);
    col.appendChild(_swissKnockMakeBox(pairs, results, markLosers));
    const spacerB = _makeEl('div'); spacerB.style.flex = '1';
    col.appendChild(spacerB);
    innerWrap.appendChild(col);
    if (connector) innerWrap.appendChild(_swissKnockArrowConnector(connLabel, connOffsetY));
  }

  makeSilverCol('SILVER R1', sv1Pairs, r16Done ? d.sv1Results : {}, true,  'VINCITORI', -10, true);
  makeSilverCol('SILVER R2', sv2Pairs, d.sv2Results,                 true,  'PERDENTI',  -10, false);
  makeSilverCol('SILVER R3', svfPairs, d.svfResults,                 false, '',           0,  true);

  _swissInitDragPan(wrap);
}

/* ── Stato sessione Tier C ── */

/* ── Avvia una fase Tier C ── */
function _campGiocaAvviaKnockC(phase) {
  const group = tierCState.group;
  const d = _knockCData(group);

  // Assicura che i participants siano sempre inizializzati
  if (!d.participants || d.participants.length === 0) {
    const dist = distributeGroups('C');
    d.participants = [...(dist[group] || [])];
  }

  let pairs;
  if (['r16','qf','sf','f'].includes(phase)) {
    pairs = _knockCGetMainPairs(group, phase);
  } else {
    pairs = _knockCGetSilverPairs(group, phase);
  }

  const validPairs = pairs.filter(({a,b}) => a && b);
  if (validPairs.length === 0) {
    if (typeof toast === 'function') {
      if (!d.participants || d.participants.length === 0)
        toast(`Group ${group} è vuoto — aggiungi opening prima`, 'error');
      else
        toast('Completa le fasi precedenti prima', 'warning');
    }
    return;
  }

  tierCState.matchPhase    = phase;
  tierCState.knockMatches  = validPairs.map(({a,b}) => [a,b]);
  tierCState.knockMatchIdx = 0;
  tierCState.knockResults  = [];

  const phaseNames = {
    r16: 'Ottavi di Finale', qf: 'Quarti di Finale', sf: 'Semifinali', f: 'Finale',
    sv1: 'Silver — Round 1', sv2: 'Silver — Round 2', svf: 'Silver — Round 3'
  };

  const tieBtn = document.getElementById('giocaDrawBtn');
  if (tieBtn) tieBtn.style.display = 'none';
  const exitBtn = document.querySelector('#giocaMatchView .btn-secondary');
  if (exitBtn) exitBtn.onclick = swissMatchEsci;
  const left  = document.getElementById('giocaContLeft');
  const right = document.getElementById('giocaContRight');
  if (left)  left.onclick  = () => tierCPick(0);
  if (right) right.onclick = () => tierCPick(1);

  const lbl = document.getElementById('giocaMatchDayLabel');
  if (lbl) lbl.textContent = `TIER C — Group ${group}`;
  const rnd = document.getElementById('giocaMatchProgress');
  if (rnd) rnd.textContent = phaseNames[phase];

  showView('giocaMatchView');
  _tierCRenderMatch();
}

function _tierCRenderMatch() {
  const total   = tierCState.knockMatches.length;
  const current = tierCState.knockMatchIdx;
  const [a, b]  = tierCState.knockMatches[current];

  const counter = document.getElementById('giocaMatchCounter');
  if (counter) counter.textContent = `Match ${current + 1} / ${total}`;

  _swissSetContestants(a, b);
}

function tierCPick(side) {
  const [a, b] = tierCState.knockMatches[tierCState.knockMatchIdx];
  const cardId = side === 0 ? 'giocaContLeft' : 'giocaContRight';
  document.getElementById(cardId).classList.add('picked');
  _gPlayers.giocaLeft.stop();
  _gPlayers.giocaRight.stop();

  const scoreA = side === 0 ? 2 : 0;
  const scoreB = side === 0 ? 0 : 2;
  tierCState.knockResults.push({a, b, scoreA, scoreB});
  tierCState.knockMatchIdx++;
  setTimeout(_tierCKnockAdvance, 420);
}

function _tierCKnockAdvance() {
  if (tierCState.knockMatchIdx >= tierCState.knockMatches.length) {
    _tierCSalvaFase();
  } else {
    _tierCRenderMatch();
  }
}

function _tierCSalvaFase() {
  const group = tierCState.group;
  const d = _knockCData(group);
  const resKeyMap = {
    r16: 'r16Results', qf: 'qfResults', sf: 'sfResults', f: 'fResults',
    sv1: 'sv1Results', sv2: 'sv2Results', svf: 'svfResults'
  };
  const key = resKeyMap[tierCState.matchPhase];
  tierCState.knockResults.forEach(r => {
    d[key][_matchKey(r.a, r.b)] = [r.scoreA, r.scoreB, r.a];
  });
  campionatoSave();
  _swissRestoreGiocaView();
  _tierCShowEndFase();
}

function _tierCShowEndFase() {
  const phaseNames = {
    r16: 'OTTAVI COMPLETATI', qf: 'QUARTI COMPLETATI', sf: 'SEMIFINALI COMPLETATE', f: 'FINALE COMPLETATO',
    sv1: 'SILVER R1 COMPLETATO', sv2: 'SILVER R2 COMPLETATO', svf: 'SILVER R3 COMPLETATO'
  };
  const el = document.getElementById('tierCEndLabel');
  if (el) el.textContent = phaseNames[tierCState.matchPhase] || 'FASE COMPLETATA';

  const res = document.getElementById('tierCEndResults');
  if (res) {
    res.replaceChildren();
    tierCState.knockResults.forEach(r => {
      const ea = getEntryByName(r.a);
      const eb = getEntryByName(r.b);
      const row = _swissMakeResultRow(r.a, r.b, r.scoreA, r.scoreB, ea, eb);
      res.appendChild(row);
    });
  }

  // Calcola fase successiva logica
  const nextPhase = _tierCNextPhase(tierCState.matchPhase);
  const nextBtn = document.getElementById('tierCEndNextBtn');
  if (nextBtn) {
    if (nextPhase) {
      nextBtn.style.display = '';
      const nextNames = {
        qf: 'Quarti di Finale', sf: 'Semifinali', f: 'Finale',
        sv1: 'Silver R1', sv2: 'Silver R2', svf: 'Silver Round 3'
      };
      nextBtn.textContent = `${nextNames[nextPhase] || nextPhase} →`;
    } else {
      nextBtn.style.display = 'none';
    }
  }

  showView('tierCEndView');
}

function _tierCNextPhase(phase) {
  // Dopo r16 → qf e sv1 sono disponibili, suggerisci qf
  const order = ['r16','qf','sf','f','sv1','sv2','svf'];
  const idx = order.indexOf(phase);
  return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
}

function tierCEndBack() {
  document.body.style.overflowX = '';
  _renderGiocaCTurnList();
  showView('giocaDayView');
}

function tierCEndContinua() {
  const next = _tierCNextPhase(tierCState.matchPhase);
  if (next) {
    _campGiocaAvviaKnockC(next);
  } else {
    tierCEndBack();
  }
}