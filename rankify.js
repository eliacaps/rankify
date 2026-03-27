// ═══════════════════════════════════════════════════════════════════════════════
// RANKIFY
// ═══════════════════════════════════════════════════════════════════════════════

// ── CATEGORY ICON PATHS ───────────────────────────────────────────────────────
const OPENING_IMG    = 'img/icon/opening.png';
const LOL_IMG        = 'img/icon/leagueoflegends.png';
const TWITCH_IMG     = 'img/icon/streamer.png';
const YOUTUBE_IMG    = 'img/icon/youtuber.png';
const SIMPSON_IMG    = 'img/icon/simpson.png';
const ONEPIECE_IMG   = 'img/icon/onepiece.png';
const GOT_IMG        = 'img/icon/gameofthrones.png';
const TWD_IMG        = 'img/icon/thewalkingdead.png';

// ── SECURITY HELPERS ─────────────────────────────────────────────────────────
/**
 * Escapa caratteri HTML pericolosi per prevenire XSS.
 * Usare sempre prima di interpolare dati utente in innerHTML.
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let db          = [];
// categoryFields: { "Opening": ["data","anime","artista"], "Film": ["data"] }
let categoryFields = {};
const ALL_FIELDS        = ['data','anime','artista','genere','valutazione','regione','classe','ruolo'];
const FIELD_LABELS      = { data:'Data', anime:'Anime', artista:'Artista', genere:'Genere', valutazione:'Valutazione', regione:'Regione', classe:'Classe', ruolo:'Ruolo' };
const FIELD_PLACEHOLDERS = { data:'es. 2024', anime:'es. Attack on Titan', artista:'es. Linked Horizon', genere:'es. Shonen', valutazione:'es. S', regione:'es. Demacia', classe:'es. Mago', ruolo:'es. Mid' };
// selectedCategories/selectedSubcategories/subcatFilterMode → gamePool (PoolSelector)
const PYRAMID_ROWS    = [1, 2, 3, 4];         // totale 10
// Doppia piramide: forma a rombo 1-2-3-4-3-2-1 = 16 slot totali
const DOUBLE_PYRAMID_ROWS  = [1, 2, 3, 4, 3, 2, 1];
const DOUBLE_PYRAMID_TOTAL = 16; // 1+2+3+4+3+2+1
const TOP5_TOTAL   = 5;
const DB_FILE = 'rankify.json';

// ── CATEGORY FIELDS HELPERS ───────────────────────────────────────────────────
function getCatFields(cat) { return categoryFields[cat] || []; }

// Auto-detect which of the 5 fields a category actually uses in existing data
function autoDetectFields(cat) {
  const entries = db.filter(e => entryHasCategory(e, cat));
  return ALL_FIELDS.filter(f => entries.some(e => e[f]));
}

// Called after load: ensure every category in db has an entry in categoryFields
function migrateCategoryFields() {
  getCategories().forEach(cat => {
    if (!categoryFields[cat]) {
      categoryFields[cat] = autoDetectFields(cat);
    }
  });
}

// ── STORAGE ───────────────────────────────────────────────────────────────────

// ── Serializzazione entry (unica fonte di verità per i campi) ────────────────
const ENTRY_FIXED_FIELDS = ['name', 'categories', 'subcategories'];
function serializeEntry(e) {
  const out = {
    name:          e.name,
    categories:    e.categories,
    subcategories: e.subcategories,
  };
  ALL_FIELDS.forEach(f => { out[f] = e[f] || null; });
  out.imgPath   = e.imgPath   || null;
  out.audioPath = e.audioPath || null;
  return out;
}
function deserializeEntry(e) {
  return {
    name:          e.name,
    categories:    e.categories || (e.category ? [e.category] : ['Generale']),
    subcategories: e.subcategories || [],
    ...Object.fromEntries(ALL_FIELDS.map(f => [f, e[f] || null])),
    imgPath:   e.imgPath   || null,
    audioPath: e.audioPath || null,
  };
}

// ── Password protezione scritture (cloud) ─────────────────────────────────────
// Impostata automaticamente da server_railway.py tramite variabile d'ambiente.
// In locale con server.py originale viene ignorata (il server non la controlla).
const RANKIFY_PASSWORD = typeof window._RANKIFY_PASSWORD !== 'undefined'
  ? window._RANKIFY_PASSWORD : '';

/* ── Save con coda anti-race-condition ──
   Garantisce che le richieste arrivino al server nell'ordine in cui
   sono state generate, prevenendo che una save "vecchia" sovrascriva
   una "nuova". Stesso pattern di campionatoSave.
*/
let _dbSaveQueue   = Promise.resolve();
let _dbSavePending = false;

function saveDB(onSuccess, onError) {
  _invalidateCatCache();

  // Se c'è già un save in coda (non ancora partito), scartalo:
  // tanto quello che partirà dopo avrà i dati più aggiornati.
  if (_dbSavePending) {
    if (onSuccess) onSuccess();
    return;
  }
  _dbSavePending = true;

  // Snapshot dei dati al momento della chiamata, non al momento dell'invio
  const snapshot = JSON.stringify({ categoryFields, entries: db.map(serializeEntry) }, null, 2);

  _dbSaveQueue = _dbSaveQueue.then(() => {
    _dbSavePending = false;
    return fetch('/save-db', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rankify-Password': RANKIFY_PASSWORD
      },
      body: snapshot
    })
    .then(r => { if (!r.ok) throw new Error('Salvataggio fallito'); if (onSuccess) onSuccess(); })
    .catch(err => { if (onError) onError(err.message || 'Errore salvataggio'); });
  });
}

function loadDB() {
  fetch(DB_FILE + '?_=' + Date.now())
    .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
    .then(parsed => {
      let rawEntries, rawCatFields;
      if (Array.isArray(parsed)) {
        rawEntries = parsed; rawCatFields = {};
      } else {
        rawEntries = parsed.entries || []; rawCatFields = parsed.categoryFields || {};
      }
      categoryFields = rawCatFields;
      db = rawEntries.map(deserializeEntry);
      migrateCategoryFields();
      _finishLoad();
    })
    .catch(() => { db = []; _finishLoad(); });
}

function _finishLoad() {
  _invalidateCatCache();
  db.sort(compareEntries);
  // FIX: rimuovi dai forcedPicks gli elementi che non esistono più nel DB
  const dbNames = new Set(db.map(e => e.name));
  if (typeof forcedPicks !== 'undefined' && Array.isArray(forcedPicks)) {
    forcedPicks.splice(0, forcedPicks.length, ...forcedPicks.filter(e => dbNames.has(e.name)));
  }
  // Anche i forcedPicks del torneo (oggetto separato)
  if (typeof tourney !== 'undefined' && Array.isArray(tourney.forcedPicks)) {
    tourney.forcedPicks.splice(0, tourney.forcedPicks.length, ...tourney.forcedPicks.filter(e => dbNames.has(e.name)));
  }
  updateHomeStatus();
  refreshEditorUI();
}

function imgSrc(entry)   { return entry.imgPath   || ''; }
function audioSrc(entry) { return entry.audioPath || ''; }

// ── HELPERS ───────────────────────────────────────────────────────────────────
function compareEntries(a, b) {
  const cA = a.categories || ['Generale'], cB = b.categories || ['Generale'];
  for (let i = 0; i < Math.max(cA.length, cB.length); i++) {
    const ca = cA[i]||'', cb = cB[i]||'';
    if (ca && !cb) return -1; if (!ca && cb) return 1;
    const c = ca.localeCompare(cb,'it',{sensitivity:'base'}); if (c) return c;
  }
  // Priority fields: data, anime, artista, genere, valutazione, regione, classe, ruolo (before subcategories)
  const priorityFields = ['data','anime','artista','genere','valutazione','regione','classe','ruolo'];
  for (const f of priorityFields) {
    const fa = a[f]||'', fb = b[f]||'';
    if (fa && !fb) return -1; if (!fa && fb) return 1;
    if (fa && fb) { const c = fa.localeCompare(fb,'it',{sensitivity:'base'}); if (c) return c; }
  }
  const sA = a.subcategories||[], sB = b.subcategories||[];
  for (let i = 0; i < Math.max(sA.length, sB.length); i++) {
    const sa = sA[i]||'', sb = sB[i]||'';
    if (sa && !sb) return -1; if (!sa && sb) return 1;
    const c = sa.localeCompare(sb,'it',{sensitivity:'base'}); if (c) return c;
  }
  const an = /^\d/.test(a.name), bn = /^\d/.test(b.name);
  if (an && !bn) return -1; if (!an && bn) return 1;
  return a.name.localeCompare(b.name,'it',{sensitivity:'base',numeric:true});
}
// ── CATEGORY CACHE ────────────────────────────────────────────────────────────
// Invalidata ad ogni load/save per evitare scan ripetuti sul db
let _catCache = null;
function _invalidateCatCache() { _catCache = null; }

function getCategories() {
  if (_catCache) return _catCache;
  const s = new Set();
  db.forEach(e => (e.categories || ['Generale']).forEach(c => s.add(c)));
  _catCache = [...s].sort();
  return _catCache;
}
function getCategoryCount(cat) { return db.filter(e => (e.categories||['Generale']).includes(cat)).length; }
function entryHasCategory(e, cat) { return (e.categories||['Generale']).includes(cat); }
function entryCategories(e) { return e.categories||(e.category?[e.category]:['Generale']); }
function shuffleArray(arr) {
  const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a;
}

function categoryEmoji(name) {
  const k = name.toLowerCase();
  // Pattern con immagine custom (controllati prima)
  const imgPatterns = [
    [['opening'],                                          '__OPENING_IMG__'],
    [['leagueoflegends','league of legends','lol'],        '__LOL_IMG__'],
    [['streamer','twitch'],                                '__TWITCH_IMG__'],
    [['youtuber','youtube'],                               '__YOUTUBE_IMG__'],
    [['simpson'],                                          '__SIMPSON_IMG__'],
    [['one piece','onepiece'],                             '__ONEPIECE_IMG__'],
    [['game of thrones','gameofthrones','got'],            '__GOT_IMG__'],
    [['walking dead','walkingdead','twd'],                 '__TWD_IMG__'],
  ];
  for (const [patterns, result] of imgPatterns) {
    if (patterns.some(p => k.includes(p))) return result;
  }
  // Pattern emoji generici
  const emojiPatterns = [
    [['arte'],         '🎨'], [['sport'],       '⚽'], [['musica'],     '🎵'],
    [['scienza'],      '🔬'], [['storia'],      '📜'], [['cinema'],     '🎬'],
    [['natura'],       '🌿'], [['tecnologia'],  '💻'], [['cucina'],     '🍕'],
    [['geografia'],    '🌍'], [['letteratura'], '📚'], [['animali'],    '🦁'],
    [['generale'],     '📦'], [['politica'],    '🏛'],  [['moda'],       '👗'],
    [['astronomia'],   '🚀'], [['medicina'],    '⚕️'],  [['matematica'], '📐'],
    [['filosofia'],    '🧠'], [['architettura'],'🏗'],  [['fumetti'],    '💬'],
    [['videogiochi'],  '🎮'], [['ending'],      '🎶'], [['anime'],      '🌸'],
    [['manga'],        '📖'], [['film'],        '🎬'], [['serie'],      '📺'],
    [['cantante'],     '🎤'],
  ];
  for (const [patterns, emoji] of emojiPatterns) {
    if (patterns.some(p => k.includes(p))) return emoji;
  }
  return '🗂️';
}

// ── VIEWS ─────────────────────────────────────────────────────────────────────
function showView(id) {
  if (id === 'editorView' && !window._RANKIFY_IS_ADMIN) return;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id==='homeView'){
    updateHomeStatus();
    const btn = document.getElementById('playBtn');
    if(btn) btn.textContent = '▶ Gioca';
    const bottom = document.querySelector('.btn-group-bottom');
    if(bottom) bottom.style.display = '';
  }
  if (id==='editorView') refreshEditorUI();
  const mp = document.getElementById('modePicker');
  if(mp) mp.classList.remove('open');
}

function toggleModePicker(){
  const mp      = document.getElementById('modePicker');
  const btn     = document.getElementById('playBtn');
  const bottom  = document.querySelector('.btn-group-bottom');
  const open    = mp.classList.toggle('open');
  btn.textContent = open ? '✕ Chiudi' : '▶ Gioca';
  if(bottom) bottom.style.display = open ? 'none' : '';
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function updateHomeStatus() {
  const cats = getCategories();
  document.getElementById('homeStatus').innerHTML =
    `<span style="color:#8080a0">${db.length} element${db.length===1?'o':'i'}</span> &nbsp;·&nbsp; <span style="color:#8080a0">${cats.length} categor${cats.length===1?'ia':'ie'}</span>`;
}

// ── CATEGORY PICKER ───────────────────────────────────────────────────────────
function startMode(mode){
  game.mode = mode;
  const mp = document.getElementById('modePicker');
  if(mp) mp.classList.remove('open');
  const btn = document.getElementById('playBtn');
  if(btn) btn.textContent = '▶ Gioca';
  goToCategoryPicker();
}

function getMinItems() {
  if(game.mode === 'top5')      return TOP5_TOTAL;
  if(game.mode === 'dpyramid')  return DOUBLE_PYRAMID_TOTAL;
  return 10;
}

function goToCategoryPicker() {
  const minItems = getMinItems();
  if (db.length < minItems){
    openModal('Elementi insufficienti', `Servono almeno ${minItems} elementi nel database per questa modalità.`, ()=>closeModal(), 'OK');
    return;
  }


  const isTop5     = game.mode === 'top5';
  const isDPyramid = game.mode === 'dpyramid';

  let titleText = 'PYRAMID';
  if(isDPyramid) titleText = 'DIAMOND';
  else if(isTop5) titleText = 'TOP 5';
  document.getElementById('catPickerTitle').textContent = titleText;

  const btn = document.getElementById('startGameBtn');
  btn.style.background = '';
  btn.style.color = '';

  gamePool.toggleCategory(null);
  forcedPicks.splice(0);
  renderCategoryGrid(); gamePool.renderSubcatGrid(); updateStartBtn();
  renderForcedPanel(); showView('categoryView');
}

function renderCatEmoji(name) {
  const e = categoryEmoji(name);
  if(e === '__OPENING_IMG__') return `<img src="${OPENING_IMG}" style="width:66px;height:66px;object-fit:contain;vertical-align:middle;margin:-10px 0;">`;
  if(e === '__LOL_IMG__') return `<span style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;"><img src="${LOL_IMG}" style="width:44px;height:44px;object-fit:contain;background:none;display:block;"></span>`;
  if(e === '__TWITCH_IMG__') return `<img src="${TWITCH_IMG}" style="width:66px;height:66px;object-fit:contain;vertical-align:middle;margin:-8px 0;">`;
  if(e === '__YOUTUBE_IMG__') return `<img src="${YOUTUBE_IMG}" style="width:66px;height:66px;object-fit:contain;vertical-align:middle;margin:-8px 0;">`;
  if(e === '__SIMPSON_IMG__') return `<img src="${SIMPSON_IMG}" style="width:66px;height:66px;object-fit:contain;vertical-align:middle;margin:-8px 0;">`;
  if(e === '__ONEPIECE_IMG__') return `<img src="${ONEPIECE_IMG}" style="width:50px;height:50px;object-fit:contain;vertical-align:middle;margin:-8px 0;">`;
  if(e === '__GOT_IMG__') return `<img src="${GOT_IMG}" style="width:66px;height:66px;object-fit:contain;vertical-align:middle;margin:-8px 0;">`;
  if(e === '__TWD_IMG__') return `<img src="${TWD_IMG}" style="width:66px;height:66px;object-fit:contain;vertical-align:middle;margin:-8px 0;">`;
  return e;
}
function renderCategoryGrid() {
  const min  = getMinItems();
  const grid = document.getElementById('catGrid'); grid.replaceChildren();
  const allOk = db.length >= min;
  // "TUTTE" card — selects all (clears individual selections)
  const isAllSelected = gamePool.categories.size === 0;
  const allCard=document.createElement('div');
  allCard.className='cat-card all-card'+(isAllSelected&&allOk?' selected':'')+(!allOk?' disabled':'');
  allCard.innerHTML=`<div class="cat-emoji">🌐</div><div class="cat-name">TUTTE</div><div class="cat-count">${db.length} elementi${!allOk?' — non sufficiente':''}</div>`;
  if(allOk) allCard.onclick=()=>selectCategory(null);
  grid.appendChild(allCard);
  getCategories().forEach(cat=>{
    const count=getCategoryCount(cat), ok=count>=min;
    const card=document.createElement('div');
    card.className='cat-card'+(gamePool.categories.has(cat)?' selected':'')+(!ok?' disabled':'');
    card.innerHTML=`<div class="cat-emoji">${renderCatEmoji(cat)}</div><div class="cat-name">${cat}</div><div class="cat-count">${count} element${count===1?'o':'i'}${!ok?` — min ${min}`:''}</div>`;
    if(ok) card.onclick=()=>selectCategory(cat);
    grid.appendChild(card);
  });
}
function buildSubcatAccordion(grid, groups, selectedSet, onToggle, colClasses){
  grid.replaceChildren();
  const accordion=document.createElement('div'); accordion.className='subcat-accordion';
  Object.entries(groups).forEach(([f,items])=>{
    const selectedInGroup=items.filter(({key})=>selectedSet.has(key));
    const group=document.createElement('div'); group.className='subcat-group'+(colClasses[f]?' '+colClasses[f]:'');
    // header
    const hdr=document.createElement('div');
    hdr.className='subcat-group-header'+(selectedInGroup.length>0?' open':'');
    const left=document.createElement('div'); left.className='subcat-group-left';
    const nameEl=document.createElement('span');
    nameEl.className=`subcat-group-name ${colClasses[f]||''}`;
    nameEl.textContent=FIELD_LABELS[f];
    left.appendChild(nameEl);
    // badges delle selezionate visibili anche da chiuso
    const badges=document.createElement('div'); badges.className='subcat-group-badges';
    selectedInGroup.forEach(({label})=>{
      const b=document.createElement('span'); b.className='subcat-selected-badge';
      b.textContent=label; badges.appendChild(b);
    });
    const countEl=document.createElement('span');
    countEl.className='subcat-group-count';
    countEl.textContent=`${items.length} voci`;
    const arrow=document.createElement('span'); arrow.className='subcat-group-arrow'; arrow.textContent='▾';
    left.appendChild(badges);
    hdr.appendChild(left); hdr.appendChild(countEl); hdr.appendChild(arrow);
    // body
    const body=document.createElement('div');
    body.className='subcat-group-body'+(selectedInGroup.length>0?' open':'');
    items.forEach(({key,label,count})=>{
      const card=document.createElement('div');
      card.className='subcat-card'+(selectedSet.has(key)?' selected':'');
      card.innerHTML=`${label} <span class="subcat-count">(${count})</span>`;
      card.onclick=(e)=>{ e.stopPropagation(); onToggle(key); };
      body.appendChild(card);
    });
    // toggle apri/chiudi
    hdr.onclick=()=>{
      const isOpen=body.classList.contains('open');
      body.classList.toggle('open',!isOpen);
      hdr.classList.toggle('open',!isOpen);
    };
    group.appendChild(hdr); group.appendChild(body);
    accordion.appendChild(group);
  });
  grid.appendChild(accordion);
}


// ── GAME ──────────────────────────────────────────────────────────────────────

/**
 * Doppia piramide — layout slot indices:
 *
 *  TOP:     row1=[0]        row2=[1,2]      row3=[3,4,5]
 *  CENTER:  [6,7,8,9]
 *  BOTTOM:  row1=[10,11,12] row2=[13,14]   row3=[15]
 *
 * Visually:
 *         [0]
 *       [1] [2]
 *     [3] [4] [5]
 *  [6] [7] [8] [9]   ← center (4 wide)
 *     [10][11][12]
 *       [13][14]
 *          [15]
 */

function makePyramidSlot(idx){
  const slot=document.createElement('div');
  slot.className='pyramid-slot'; slot.dataset.idx=idx;
  slot.addEventListener('click',()=>placeCurrentCard(+slot.dataset.idx));
  slot.addEventListener('dragover',e=>{e.preventDefault();slot.classList.add('drag-over');});
  slot.addEventListener('dragleave',()=>slot.classList.remove('drag-over'));
  slot.addEventListener('drop',e=>{e.preventDefault();slot.classList.remove('drag-over');placeCurrentCard(+slot.dataset.idx);});
  return slot;
}

function buildPyramidUI(){
  const isTop5     = game.mode === 'top5';
  const isDPyramid = game.mode === 'dpyramid';
  const area       = document.getElementById('pyramidArea'); area.replaceChildren();

  if(isTop5){
    const row = document.createElement('div'); row.className = 'top5-row';
    for(let i = 0; i < TOP5_TOTAL; i++){
      const slot = document.createElement('div');
      slot.className = 'top5-slot'; slot.dataset.idx = i;
      slot.innerHTML = `<div class="t5-rank">${i+1}</div>`;
      slot.addEventListener('click', () => placeCurrentCard(+slot.dataset.idx));
      slot.addEventListener('dragover',  e => { e.preventDefault(); slot.classList.add('drag-over'); });
      slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
      slot.addEventListener('drop',      e => { e.preventDefault(); slot.classList.remove('drag-over'); placeCurrentCard(+slot.dataset.idx); });
      row.appendChild(slot);
    }
    area.appendChild(row);
  } else if(isDPyramid){
    // Rombo: righe 1-2-3-4-3-2-1
    const wrap = document.createElement('div'); wrap.className = 'dpyramid-area';
    let idx = 0;
    DOUBLE_PYRAMID_ROWS.forEach((count, rowIdx) => {
      const row = document.createElement('div'); row.className = 'pyramid-row';
      // Riga 4 (idx 3) è la riga centrale — aggiunge classe speciale
      if(rowIdx === 3) row.classList.add('dpyramid-center-row');
      for(let c = 0; c < count; c++){
        row.appendChild(makePyramidSlot(idx)); idx++;
      }
      wrap.appendChild(row);
    });
    area.appendChild(wrap);
  } else {
    // Normal pyramid
    let idx = 0;
    PYRAMID_ROWS.forEach(count=>{
      const row=document.createElement('div'); row.className='pyramid-row';
      for(let c=0;c<count;c++){
        row.appendChild(makePyramidSlot(idx)); idx++;
      }
      area.appendChild(row);
    });
  }
}













// ── RESULT ────────────────────────────────────────────────────────────────────

// ── FIELDS MODAL ──────────────────────────────────────────────────────────────
function openFieldsModal() {
  renderFieldsModal();
  document.getElementById('fieldsModal').classList.add('open');
}
function closeFieldsModal() {
  document.getElementById('fieldsModal').classList.remove('open');
  refreshEditorUI(); // refresh filters after possible changes
}
function renderFieldsModal() {
  const body = document.getElementById('fieldsModalBody');
  const cats = getCategories();
  if (!cats.length) {
    body.innerHTML = '<p style="font-size:12px;color:#50506a;text-align:center;padding:16px 0;">Nessuna categoria nel database.</p>';
    return;
  }
  body.replaceChildren();
  cats.forEach(cat => {
    const active = getCatFields(cat);
    const row = document.createElement('div');
    row.className = 'fields-cat-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'fields-cat-name';
    nameEl.textContent = cat;
    row.appendChild(nameEl);
    ALL_FIELDS.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'fields-pill' + (active.includes(f) ? ' active' : '');
      btn.textContent = FIELD_LABELS[f];
      btn.onclick = () => {
        if (!categoryFields[cat]) categoryFields[cat] = [];
        const idx = categoryFields[cat].indexOf(f);
        if (idx >= 0) categoryFields[cat].splice(idx, 1);
        else categoryFields[cat].push(f);
        renderFieldsModal(); // re-render modal in place
        updateAddFormFields(); // update add form if open
      };
      row.appendChild(btn);
    });
    body.appendChild(row);
  });
}

// ── DYNAMIC ADD/EDIT FORM FIELDS ──────────────────────────────────────────────
// Called when category input changes in the add form
function updateAddFormFields() {
  const cat = (document.getElementById('addCatInput') || {}).value || '';
  const fields = getCatFields(cat.trim());
  const container = document.getElementById('addDynamicFields');
  if (!container) return;
  container.replaceChildren();
  fields.forEach(f => {
    const vals = [...new Set(db.map(e => e[f]).filter(Boolean))].sort();
    const dlId = 'dl_add_' + f;
    const div = document.createElement('div');
    div.className = 'input-group';
    div.innerHTML = `<label>${FIELD_LABELS[f]}</label>
      <input type="text" class="input-field" id="add_${f}" list="${dlId}"
        placeholder="${FIELD_PLACEHOLDERS[f]}" autocomplete="off" maxlength="60"/>
      <datalist id="${dlId}">${vals.map(v => `<option value="${v}">`).join('')}</datalist>`;
    container.appendChild(div);
  });
}

// Called when category input changes in the edit modal
function updateEditFormFields() {
  const cat = (document.getElementById('editCatInput') || {}).value || '';
  const fields = getCatFields(cat.trim());
  const container = document.getElementById('editDynamicFields');
  if (!container) return;
  // Save current values before re-render
  const saved = {};
  ALL_FIELDS.forEach(f => { const el = document.getElementById('edit_' + f); if (el) saved[f] = el.value; });
  container.replaceChildren();
  fields.forEach(f => {
    const vals = [...new Set(db.map(e => e[f]).filter(Boolean))].sort();
    const dlId = 'dl_edit_' + f;
    const div = document.createElement('div');
    div.className = 'input-group';
    div.innerHTML = `<label>${FIELD_LABELS[f]}</label>
      <input type="text" class="input-field" id="edit_${f}" list="${dlId}"
        placeholder="${FIELD_PLACEHOLDERS[f]}" autocomplete="off" maxlength="60"/>
      <datalist id="${dlId}">${vals.map(v => `<option value="${v}">`).join('')}</datalist>`;
    container.appendChild(div);
    // Restore saved value
    if (saved[f]) { const el = document.getElementById('edit_' + f); if (el) el.value = saved[f]; }
  });
}

// ── EDITOR ────────────────────────────────────────────────────────────────────
// ── FilePending ──────────────────────────────────────────────────────────────
// Gestisce un file in attesa di upload: tiene il riferimento, l'ObjectURL
// e si occupa di revocare l'URL precedente prima di crearne uno nuovo.
class FilePending {
  constructor() { this.file = null; this.path = ''; this.url = ''; }
  set(file) {
    this.clear();
    this.file = file;
    this.path = file.name;
    this.url  = URL.createObjectURL(file);
  }
  clear() {
    if (this.url) { URL.revokeObjectURL(this.url); this.url = ''; }
    this.file = null; this.path = '';
  }
}

// ── File pending — add form ─────────────────────────────────────────────────
// Gestiti da FilePending (vedi sotto): .file, .path, .url, .set(file), .clear()
const _addImg   = new FilePending();
const _addAudio = new FilePending();
const _editImg  = new FilePending();
const _editAudio= new FilePending();
// Alias di compatibilità con saveEdit / addEntry che leggono .path
// (accedono come _addImg.path, _editImg.path, ecc.)

function previewImage(e){
  const file=e.target.files[0]; if(!file)return;
  _addImg.set(file);
  document.getElementById('uploadContent').innerHTML=`<img src="${escapeHtml(_addImg.url)}" class="preview" alt=""/><div style="font-size:11px;color:#8080a0">✓ ${escapeHtml(file.name)}</div>`;
}
function previewAudio(e,mode){
  const file=e.target.files[0]; if(!file)return;
  if(mode==='add'){
    _addAudio.set(file);
    document.getElementById('addAudioStatus').textContent='✓ '+file.name;
    document.getElementById('addAudioUpload').classList.add('loaded');
  } else {
    _editAudio.set(file);
    document.getElementById('editAudioStatus').textContent='✓ '+file.name;
    document.getElementById('editAudioUpload').classList.add('loaded');
  }
}
function addEntry(){
  const name = document.getElementById('nameInput').value.trim();
  const cat  = document.getElementById('addCatInput').value.trim() || 'Generale';
  if(!name){ toast('Inserisci un nome','error'); return; }
  if(!_addImg.path){ toast("Carica un'immagine",'error'); return; }
  if(db.find(e=>e.name.toLowerCase()===name.toLowerCase())){ toast('Nome già presente','error'); return; }
  if(!categoryFields[cat]) categoryFields[cat] = [];
  const imgPath   = 'img/'+cat+'/'+_addImg.path;
  const audioPath = _addAudio.path ? 'audio/'+cat+'/'+_addAudio.path : null;
  const entry = { name, categories:[cat], subcategories:[], imgPath, audioPath };
  ALL_FIELDS.forEach(f => { const el = document.getElementById('add_'+f); entry[f] = el ? (el.value.trim()||null) : null; });
  const btn = document.querySelector('.add-btn');
  if(btn){ btn.disabled=true; btn.textContent='SALVATAGGIO…'; }
  db.push(entry);
  saveDB(
    ()=>{
      if(btn){ btn.disabled=false; btn.textContent='+ AGGIUNGI ELEMENTO'; }
      refreshEditorUI(); updateHomeStatus();
      document.getElementById('nameInput').value='';
      document.getElementById('addCatInput').value='';
      document.getElementById('addDynamicFields').replaceChildren();
      document.getElementById('imgInput').value='';
      document.getElementById('audioInput').value='';
      document.getElementById('uploadContent').innerHTML='<div class="upload-icon">🖼</div><div class="img-upload-placeholder">Clicca per caricare</div>';
      document.getElementById('addAudioStatus').textContent='Carica file audio';
      document.getElementById('addAudioUpload').classList.remove('loaded');
      _addImg.clear(); _addAudio.clear();
      toast('Elemento aggiunto!','success');
    },
    errMsg=>{ db.pop(); if(btn){ btn.disabled=false; btn.textContent='+ AGGIUNGI ELEMENTO'; } toast(errMsg||'Errore salvataggio','error'); }
  );
}

function deleteEntry(idx){
  const entry=db[idx];
  openModal(
    'Elimina elemento?',
    `"${entry.name}" verrà rimosso permanentemente dal database.`,
    ()=>{
      db.splice(idx,1);
      saveDB(
        ()=>{ refreshEditorUI(); updateHomeStatus(); closeModal(); toast('Elemento eliminato','success'); },
        ()=>{ db.splice(idx,0,entry); refreshEditorUI(); closeModal(); toast('Errore salvataggio','error'); }
      );
    },
    'Elimina'
  );
}

function refreshEditorUI(){
  const fc = document.getElementById('filterCat');
  const fx = document.getElementById('filterSearch');
  const cv = fc ? fc.value : '';
  const sx = fx ? fx.value.toLowerCase() : '';

  const cats = getCategories();
  if(fc){
    fc.innerHTML = '<option value="">Tutte le categorie</option>';
    cats.forEach(c=>{ const o=document.createElement('option'); o.value=c; o.textContent=`${c} (${getCategoryCount(c)})`; if(c===cv) o.selected=true; fc.appendChild(o); });
  }

  const dl = document.getElementById('catSuggestions');
  if(dl){ dl.replaceChildren(); cats.forEach(c=>{ const o=document.createElement('option'); o.value=c; dl.appendChild(o); }); }

  // Dynamic field filters — show selects only for fields active in the selected category
  const dynFilters = document.getElementById('dynamicFilters');
  const prevVals = {};
  if(dynFilters){
    dynFilters.querySelectorAll('select[data-field]').forEach(s => { prevVals[s.dataset.field] = s.value; });
    dynFilters.replaceChildren();
    const fieldsToShow = cv ? getCatFields(cv) : [];
    fieldsToShow.forEach(f => {
      const pool = cv ? db.filter(e => entryHasCategory(e,cv)) : db;
      const vals = [...new Set(pool.map(e=>e[f]).filter(Boolean))].sort();
      if(!vals.length) return;
      const sel = document.createElement('select'); sel.className='input-field'; sel.dataset.field=f;
      sel.innerHTML = `<option value="">${FIELD_LABELS[f]}</option>`;
      vals.forEach(v=>{ const o=document.createElement('option'); o.value=v; o.textContent=v; if(prevVals[f]===v) o.selected=true; sel.appendChild(o); });
      sel.onchange = () => refreshEditorUI();
      dynFilters.appendChild(sel);
    });
  }

  const entryCountEl = document.getElementById('entryCount');
  const footerCountEl = document.getElementById('footerCount');
  if(entryCountEl)  entryCountEl.textContent  = db.length;
  if(footerCountEl) footerCountEl.textContent = db.length;

  // Active field filters
  const fieldFilters = {};
  if(dynFilters) dynFilters.querySelectorAll('select[data-field]').forEach(s=>{ if(s.value) fieldFilters[s.dataset.field]=s.value; });

  // _i assegnato dopo il sort per puntare all'indice corretto in db
  const _dbIndex = new Map(db.map((e,i)=>[e,i]));
  let items = [...db].sort(compareEntries).map(e=>({...e,_i:_dbIndex.get(e)??db.indexOf(e)}));
  if(cv) items = items.filter(e => entryHasCategory(e,cv));
  Object.entries(fieldFilters).forEach(([f,v]) => { items = items.filter(e => e[f]===v); });
  if(sx) items = items.filter(e => e.name.toLowerCase().includes(sx));

  const list = document.getElementById('entriesList');
  if(!list) return;
  list.replaceChildren();
  items.forEach(entry => {
    const card = document.createElement('div'); card.className='entry-card';
    const catName = entryCategories(entry)[0]||'Generale';
    const catTags = `<span class="entry-cat-tag">${escapeHtml(catName)}</span>`;
    const activeFlds = getCatFields(catName);
    const priorityTags = activeFlds.map(f => entry[f] ? `<span class="entry-priority-${f}">${escapeHtml(entry[f])}</span>` : '').join('');
    const audDot = entry.audioPath ? '<span style="font-size:9px;color:var(--success);margin-left:2px">♪</span>' : '';
    card.innerHTML = `
      <img src="${escapeHtml(imgSrc(entry))}" alt="${escapeHtml(entry.name)}" loading="lazy"/>
      <div class="entry-name">${escapeHtml(entry.name)}${audDot}</div>
      <div class="entry-cats">${catTags}${priorityTags}</div>
      <button class="edit-btn" onclick="openEditModal(${entry._i})">✎</button>
      <button class="del-btn"  onclick="deleteEntry(${entry._i})">×</button>`;
    list.appendChild(card);
  });
}

function confirmClearAll(){
  openModal('Cancella tutto?','Tutti gli elementi verranno rimossi permanentemente.',()=>{
    const bk=[...db];
    db=[];
    saveDB(
      ()=>{_invalidateCatCache();refreshEditorUI();updateHomeStatus();closeModal();toast('Database svuotato','success');},
      ()=>{db=bk;refreshEditorUI();closeModal();toast('Errore salvataggio','error');}
    );
  },'Cancella');
}

// ── EDIT MODAL ────────────────────────────────────────────────────────────────
let editingIdx = null;

function openEditModal(idx){
  editingIdx=idx;
  _editImg.clear(); _editAudio.clear();
  const entry = db[idx];
  const cat   = entryCategories(entry)[0]||'';
  document.getElementById('editName').value    = entry.name;
  document.getElementById('editCatInput').value = cat;
  updateEditFormFields(); // render dynamic fields for this cat
  ALL_FIELDS.forEach(f => { const el=document.getElementById('edit_'+f); if(el) el.value=entry[f]||''; });
  document.getElementById('editImgPreview').src = imgSrc(entry);
  document.getElementById('editImgInput').value = '';
  document.getElementById('editAudioInput').value = '';
  const hasAudio = !!entry.audioPath;
  document.getElementById('editAudioStatus').textContent = hasAudio ? '🎵 '+entry.audioPath.split('/').pop() : 'Carica file audio';
  document.getElementById('editAudioUpload').classList.toggle('loaded', hasAudio);
  document.getElementById('editModal').classList.add('open');
}
function closeEditModal(){
  document.getElementById('editModal').classList.remove('open');
  editingIdx=null;
  _editImg.clear(); _editAudio.clear();
}
function editPreviewImage(e){
  const file=e.target.files[0]; if(!file)return;
  _editImg.set(file);
  document.getElementById('editImgPreview').src=_editImg.url;
}
function saveEdit(){
  if(editingIdx===null) return;
  const name = document.getElementById('editName').value.trim();
  if(!name){ toast('Nome vuoto','error'); return; }
  const dup = db.find((e,i)=>i!==editingIdx&&e.name.toLowerCase()===name.toLowerCase());
  if(dup){ toast('Nome già presente','error'); return; }
  const cats = [document.getElementById('editCatInput').value.trim()||'Generale'];
  const btn  = document.getElementById('editSaveBtn');
  if(btn){ btn.disabled=true; btn.textContent='SALVATAGGIO…'; }
  const bk = {...db[editingIdx]};
  const oldName = db[editingIdx].name;
  db[editingIdx].name = name;
  db[editingIdx].categories = cats;
  // Mantieni le sottocategorie esistenti — non azzerarle ad ogni salvataggio
  // Write fields that are visible in the form; keep existing values for hidden ones
  ALL_FIELDS.forEach(f => {
    const el = document.getElementById('edit_'+f);
    if(el) db[editingIdx][f] = el.value.trim()||null;
    // if field not shown (not active for cat), preserve existing value untouched
  });
  delete db[editingIdx].category;
  if(_editImg.path)   db[editingIdx].imgPath   = 'img/'+cats[0]+'/'+_editImg.path;
  if(_editAudio.path) db[editingIdx].audioPath = 'audio/'+cats[0]+'/'+_editAudio.path;
  saveDB(
    ()=>{
      if(btn){ btn.disabled=false; btn.textContent='SALVA'; }
      // Aggiorna riferimenti nel campionato solo dopo che il DB è salvato con successo
      if (oldName !== name && typeof campionatoData !== 'undefined') {
        const o = oldName, nw = name;

        function _renameKey(obj) {
          if (!obj || typeof obj !== 'object') return;
          if (o in obj) { obj[nw] = obj[o]; delete obj[o]; }
        }

        function _renameMatchResults(results) {
          if (!results || typeof results !== 'object') return;
          for (const mk of Object.keys(results)) {
            const parts = mk.split(' ⚔ ');
            const val = results[mk];
            if (Array.isArray(val) && val[2] === o) val[2] = nw;
            if (parts.includes(o)) {
              const newMk = parts.map(p => p === o ? nw : p).sort().join(' ⚔ ');
              results[newMk] = val;
              delete results[mk];
            }
          }
        }

        // 1. Tier arrays: S, A, B, C, ...
        for (const tier of Object.keys(campionatoData)) {
          if (Array.isArray(campionatoData[tier])) {
            campionatoData[tier] = campionatoData[tier].map(n => n === o ? nw : n);
          }
        }
        // 2. Punteggi: _sScores, _aScores
        _renameKey(campionatoData._sScores);
        _renameKey(campionatoData._aScores);
        // 3. Risultati giornate
        for (const dayResults of Object.values(campionatoData._matchdayResults  || {})) _renameMatchResults(dayResults);
        for (const dayResults of Object.values(campionatoData._aMatchdayResults || {})) _renameMatchResults(dayResults);
        // 4. Hall of Fame
        for (const season of (campionatoData._hallOfFame || [])) {
          if (Array.isArray(season.entries)) {
            season.entries.forEach(e => { if (e.name === o) e.name = nw; });
          }
        }
        // 5. Swiss B
        for (const group of Object.values(campionatoData._swissB || {})) {
          if (Array.isArray(group.participants)) {
            group.participants = group.participants.map(n => n === o ? nw : n);
          }
          for (const key of ['t0Results','t1Results','t2Results','t3Results','t4Results','kqfResults','ksfResults','kfResults']) {
            _renameMatchResults(group[key]);
          }
        }

        // 6. Knock C
        for (const group of Object.values(campionatoData._knockC || {})) {
          if (Array.isArray(group.participants)) {
            group.participants = group.participants.map(n => n === o ? nw : n);
          }
          for (const key of ['r16Results','qfResults','sfResults','fResults','sv1Results','sv2Results','svfResults']) {
            _renameMatchResults(group[key]);
          }
        }

        if (typeof campionatoSave === 'function') campionatoSave();
      }
      refreshEditorUI(); updateHomeStatus(); closeEditModal(); toast('Elemento aggiornato!','success');
    },
    err=>{ db[editingIdx]=bk; if(btn){ btn.disabled=false; btn.textContent='SALVA'; } toast(err||'Errore salvataggio','error'); }
  );
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
function openModal(title,body,onConfirm,label='Conferma'){
  document.getElementById('modalTitle').textContent=title;
  document.getElementById('modalBody').textContent=body;
  const btn=document.getElementById('modalConfirmBtn');
  btn.textContent=label;
  btn.onclick=()=>{ if(onConfirm) onConfirm(); };
  document.getElementById('confirmModal').classList.add('open');
}
function closeModal(){document.getElementById('confirmModal').classList.remove('open');}

function confirmQuit(){
  openModal('Esci dal gioco?','Il progresso verrà perso.',()=>{
    stopAudio();
    const gb = document.getElementById('gameView').querySelector('.game-body');
    gb.classList.remove('dpyramid-layout');
    const ca = gb.querySelector('.current-card-area');
    if(ca) ca.style.marginLeft = '';
    closeModal(); showView('homeView');
  },'Esci');
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast show'+(type?' '+type:'');
  clearTimeout(_toastTimer); _toastTimer=setTimeout(()=>el.classList.remove('show'),3000);
}

// ── EXPORT / IMPORT ───────────────────────────────────────────────────────────

// ── TOURNAMENT STATE ─────────────────────────────────────────────────────────
const TOURNEY_SIZES = [8, 16, 32, 64, 128, 256, 512];

const BYE_ENTRY = { name:'BYE', imgPath:'', audioPath:null, _isBye:true };

// ── TOURNEY SETUP ─────────────────────────────────────────────────────────────

function renderTourneySlots(){
  const grid = document.getElementById('tourneySlotGrid');
  grid.replaceChildren();
  TOURNEY_SIZES.forEach(n => {
    const card = document.createElement('div');
    const sel  = tourney.size === n;
    card.className = 'size-card' + (sel ? ' selected' : '');
    card.innerHTML = `<div class="size-num">${n}</div><div class="size-label">${Math.log2(n)} round</div>`;
    card.onclick   = () => { tourney.size = n; renderTourneySlots(); updateTourneyPoolInfo(); updateTourneyStartBtn(); renderTForcedPanel(); };
    grid.appendChild(card);
  });
}

function renderTourneyCatGrid(){
  const grid = document.getElementById('tourneyCatGrid');
  grid.replaceChildren();
  const isAllSelected = tourneyPool.categories.size === 0;
  const allCard = document.createElement('div');
  allCard.className = 'cat-card all-card' + (isAllSelected ? ' selected' : '');
  allCard.innerHTML = `<div class="cat-emoji">🌐</div><div class="cat-name">TUTTE</div><div class="cat-count">${db.length} elementi</div>`;
  allCard.onclick = () => {
    tourneyPool.toggleCategory(null);
    renderTourneyCatGrid(); tourneyPool.renderSubcatGrid(); updateTourneyPoolInfo(); updateTourneyStartBtn();
  };
  grid.appendChild(allCard);
  getCategories().forEach(cat => {
    const count = getCategoryCount(cat);
    const card  = document.createElement('div');
    card.className = 'cat-card' + (tourneyPool.categories.has(cat) ? ' selected' : '');
    card.innerHTML = `<div class="cat-emoji">${renderCatEmoji(cat)}</div><div class="cat-name">${cat}</div><div class="cat-count">${count} element${count===1?'o':'i'}</div>`;
    card.onclick = () => {
      tourneyPool.toggleCategory(cat);
      renderTourneyCatGrid(); tourneyPool.renderSubcatGrid(); updateTourneyPoolInfo(); updateTourneyStartBtn();
    };
    grid.appendChild(card);
  });
}






// ── LAUNCH TOURNAMENT ────────────────────────────────────────────────────────

function countRealMatches(participants){
  // Conta ricorsivamente tutti i match reali (non BYE vs BYE, non singolo BYE)
  let count = 0;
  let current = [...participants];
  while(current.length > 1){
    const next = [];
    for(let i = 0; i < current.length; i += 2){
      const a = current[i], b = current[i+1];
      if(!a._isBye && !b._isBye) count++;
      // winner
      if(a._isBye) next.push(b);
      else if(b._isBye) next.push(a);
      else next.push(a); // placeholder
    }
    current = next;
  }
  return count;
}

function buildRoundMatches(participants){
  const matches = [];
  for(let i = 0; i < participants.length; i += 2)
    matches.push([participants[i], participants[i+1]]);
  return matches;
}


// ── AUDIO PLAYER — factory condivisa tra torneo e gioca ──────────────────────
/**
 * Crea un player audio per una barra progress con seek.
 * @param {object} ids  — { bar, btn, track, fill, thumb, time } → ID degli elementi DOM
 * @param {object} store — oggetto in cui salvare { audio, dragging } per questo side
 */
/**
 * createAudioPlayer(ids, store)
 * Player audio generico usato da gioco, torneo e campionato.
 *
 * ids: { bar, btn, track, fill, thumb, time }
 * store: { audio: null, dragging: false }
 *
 * Metodi pubblici:
 *   load(entry, volume?)  — carica e avvia. Mostra loading state se ids.bar esiste.
 *   stop()                — ferma e resetta la UI.
 *   toggle(otherPlayer?)  — play/pause; mette in pausa otherPlayer se attivo.
 *   setVolume(v)          — imposta il volume (0–1).
 *   initSeek()            — registra i listener di seek sulla barra (chiamare una volta).
 *   reset() / resetBtn()  — utility di reset UI.
 */
function createAudioPlayer(ids, store) {
  const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  let _metaTimeout = null;
  let _abortCtrl   = null;

  // ── UI helpers ─────────────────────────────────────────────────────────────
  const el = id => document.getElementById(id);

  function setPct(pct) {
    const fill = el(ids.fill), thumb = el(ids.thumb);
    if (fill)  fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';
  }

  function updateTime() {
    const audio = store.audio;
    if (!audio || !audio.duration) return;
    setPct((audio.currentTime / audio.duration) * 100);
    const t = el(ids.time);
    if (t) t.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
  }

  function _setLoading(on) {
    const track = el(ids.track), time = el(ids.time);
    if (track) track.classList.toggle('loading', on);
    if (time)  { time.classList.toggle('loading-text', on); if (on) time.textContent = 'caricamento…'; }
  }

  function _setError(msg) {
    _setLoading(false);
    const bar = el(ids.bar);
    if (bar) bar.classList.add('errored');
    const time = el(ids.time); if (time) time.textContent = msg || 'errore audio';
    const btn  = el(ids.btn);  if (btn)  { btn.textContent = '▶'; btn.disabled = true; }
    setPct(0);
  }

  function _clearMeta() {
    if (_metaTimeout) { clearTimeout(_metaTimeout); _metaTimeout = null; }
  }

  function reset() {
    const btn = el(ids.btn), fill = el(ids.fill), thumb = el(ids.thumb), time = el(ids.time);
    if (btn)   { btn.textContent = '▶'; btn.disabled = false; }
    if (fill)  fill.style.width = '0%';
    if (thumb) thumb.style.left = '0%';
    if (time)  time.textContent = '0:00 / 0:00';
  }

  function resetBtn() { const b = el(ids.btn); if (b) b.textContent = '▶'; }

  // ── Core ───────────────────────────────────────────────────────────────────
  function stop() {
    _clearMeta();
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    if (store.audio) {
      store.audio.pause(); store.audio.src = ''; store.audio.load();
      store.audio = null;
    }
    const bar = el(ids.bar); if (bar) bar.classList.remove('errored');
    _setLoading(false);
    reset();
  }

  function load(entry, volume, autoplay = true) {
    stop();
    const bar = el(ids.bar);
    const src = (typeof audioSrc === 'function' ? audioSrc(entry) : entry?.audioPath) || '';
    if (!src || entry._isBye) { if (bar) bar.style.display = 'none'; return; }
    if (bar) { bar.style.display = 'flex'; bar.classList.remove('errored'); }

    const ctrl  = new AbortController();
    _abortCtrl  = ctrl;
    const opts  = { signal: ctrl.signal };

    const audio = new Audio();
    audio.preload = 'metadata';
    if (volume != null) audio.volume = Math.max(0, Math.min(1, parseFloat(volume) || 0.8));
    store.audio = audio;

    audio.addEventListener('timeupdate',     () => { if (!store.dragging) updateTime(); }, opts);
    audio.addEventListener('seeked',         () => updateTime(), opts);
    audio.addEventListener('loadedmetadata', () => { _clearMeta(); _setLoading(false); updateTime(); }, opts);
    audio.addEventListener('playing', () => {
      _clearMeta(); _setLoading(false);
      const btn = el(ids.btn); if (btn) btn.textContent = '⏸';
      updateTime();
    }, opts);
    audio.addEventListener('ended', () => {
      const btn = el(ids.btn); if (btn) btn.textContent = '▶';
      // Torneo: torna a 0; gioco: mostra durata totale
      if (ids.bar === 'gameAudioBar') {
        setPct(100);
        const dur = audio.duration;
        const t = el(ids.time); if (t) t.textContent = dur ? `${fmt(dur)} / ${fmt(dur)}` : '0:00';
      } else {
        audio.currentTime = 0; setPct(0);
        const t = el(ids.time); if (t) t.textContent = `0:00 / ${fmt(audio.duration || 0)}`;
      }
    }, opts);
    audio.addEventListener('error', () => {
      _clearMeta();
      if (ids.bar === 'gameAudioBar') _setError('file non trovato');
      else { if (bar) bar.style.display = 'none'; }
    }, opts);

    if (ids.bar === 'gameAudioBar') {
      _setLoading(true);
      const btn = el(ids.btn); if (btn) btn.disabled = false;
      _metaTimeout = setTimeout(() => {
        if (!store.audio) return;
        if (!store.audio.paused) { _setLoading(false); return; }
        _setError('impossibile caricare il file');
      }, 3000);
    }

    audio.src = src;
    audio.load();
    if (autoplay) {
      audio.play()
        .then(() => { const b = el(ids.btn); if (b) b.textContent = '⏸'; })
        .catch(() => { const b = el(ids.btn); if (b) b.textContent = '▶'; });
    }
  }

  function toggle(otherPlayer) {
    const audio = store.audio, btn = el(ids.btn);
    if (!audio) return;
    if (otherPlayer?.audio && !otherPlayer.audio.paused) {
      otherPlayer.audio.pause(); otherPlayer.resetBtn();
    }
    if (audio.paused) {
      audio.play().then(() => { if (btn) btn.textContent = '⏸'; }).catch(() => { if (btn) btn.textContent = '▶'; });
    } else {
      audio.pause(); if (btn) btn.textContent = '▶';
    }
  }

  function setVolume(v) { if (store.audio) store.audio.volume = Math.max(0, Math.min(1, parseFloat(v) || 0)); }

  function initSeek() {
    const track = el(ids.track);
    if (!track || track._audioSeekInit) return;
    track._audioSeekInit = true;
    const seek = cx => {
      const rect = track.getBoundingClientRect();
      const pct  = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
      setPct(pct * 100);
      if (store.audio?.duration) store.audio.currentTime = pct * store.audio.duration;
    };
    track.addEventListener('pointerdown',  e => { e.preventDefault(); e.stopPropagation(); track.setPointerCapture(e.pointerId); track.classList.add('seeking'); store.dragging = true;  seek(e.clientX); });
    track.addEventListener('pointermove',  e => { if (!store.dragging) return; e.stopPropagation(); seek(e.clientX); });
    track.addEventListener('pointerup',    e => { if (!store.dragging) return; e.stopPropagation(); store.dragging = false; track.classList.remove('seeking'); seek(e.clientX); });
    track.addEventListener('pointercancel',() => { store.dragging = false; track.classList.remove('seeking'); });
  }

  return { load, stop, toggle, setVolume, initSeek, reset, resetBtn, get audio() { return store.audio; } };
}

// ── GAME AUDIO PLAYER ────────────────────────────────────────────────────────
// Istanza per il gioco (pyramid/top5/diamond). Usa createAudioPlayer con gli
// ID del player del gioco principale e aggiunge supporto volume + loading state.
const _gameAudioPlayer = createAudioPlayer(
  {
    bar:   'gameAudioBar',
    btn:   'audioPlayBtn',
    track: 'audioProgressTrack',
    fill:  'audioProgressFill',
    thumb: 'audioSeekThumb',
    time:  'audioTime',
  },
  { audio: null, dragging: false }
);

// Wrapper pubblici — mantengono i nomi originali usati nell'HTML e nel resto del codice
function playEntryAudio(entry) {
  if (typeof stopCampPlaylist === 'function') stopCampPlaylist();
  const vol = parseFloat((document.getElementById('audioVolume')||{}).value) || 0.8;
  _gameAudioPlayer.load(entry, vol);
}
function stopAudio()   { _gameAudioPlayer.stop();   }
function toggleAudio() { _gameAudioPlayer.toggle();  }
function setVolume(v)  { _gameAudioPlayer.setVolume(v); }


// ── TOURNAMENT AUDIO ─────────────────────────────────────────────────────────
const _tStore = {
  left:  { audio: null, dragging: false },
  right: { audio: null, dragging: false },
};

function _tIds(side) {
  const L = side === 'left';
  return {
    bar:   L ? 'contLeftAudio'      : 'contRightAudio',
    btn:   L ? 'contLeftAudioBtn'   : 'contRightAudioBtn',
    track: L ? 'contLeftAudioTrack' : 'contRightAudioTrack',
    fill:  L ? 'contLeftAudioFill'  : 'contRightAudioFill',
    thumb: L ? 'contLeftAudioThumb' : 'contRightAudioThumb',
    time:  L ? 'contLeftAudioTime'  : 'contRightAudioTime',
  };
}

const _tPlayers = {
  left:  createAudioPlayer(_tIds('left'),  _tStore.left),
  right: createAudioPlayer(_tIds('right'), _tStore.right),
};

function stopAllContAudio() {
  _tPlayers.left.stop();
  _tPlayers.right.stop();
}

function toggleContAudio(side) {
  if (!_tPlayers[side]) return;
  _tPlayers[side].toggle(_tPlayers[side === 'left' ? 'right' : 'left']);
}

function loadContAudio(side, entry) {
  if (typeof stopCampPlaylist === 'function') stopCampPlaylist();
  _tPlayers[side].load(entry, undefined, false);
}

// Mantieni _tAudio per retrocompatibilità con codice che legge _tAudio[side]
const _tAudio = new Proxy({}, {
  get: (_, side) => _tStore[side]?.audio ?? null,
});

function _tInitSeek(side) {
  _tPlayers[side].initSeek();
}





// ── TOURNEY RESULT ────────────────────────────────────────────────────────────


// ── FORCED PICKS — factory generica ──────────────────────────────────────────
/**
 * Crea il controller per un pannello "forced picks".
 * @param {object} cfg — configurazione del pannello
 */
function createForcedController(cfg) {
  // cfg: { picks, getMax, ids: { panel, subtitle, list, label, divider,
  //         searchInput, searchResults, catSelect }, onAdd?, onRemove? }

  function renderList() {
    const list    = document.getElementById(cfg.ids.list);
    const label   = document.getElementById(cfg.ids.label);
    const divider = document.getElementById(cfg.ids.divider);
    if (!list) return;
    list.replaceChildren();
    const empty = cfg.picks.length === 0;
    if (label)   { label.style.display = empty ? 'none' : 'block'; label.textContent = `Elementi aggiunti (${cfg.picks.length})`; }
    if (divider)   divider.style.display = empty ? 'none' : 'block';
    cfg.picks.forEach((entry, idx) => {
      const item = document.createElement('div');
      item.className = 'forced-list-item';
      item.innerHTML = `<img src="${escapeHtml(imgSrc(entry))}" alt="" loading="lazy"/><span>${escapeHtml(entry.name)}</span>`;
      const rem = document.createElement('button');
      rem.className = 'forced-remove-btn';
      rem.textContent = '✕';
      rem.onclick = () => {
        cfg.picks.splice(idx, 1);
        renderList();
        renderSearch();
        if (cfg.onRemove) cfg.onRemove();
      };
      item.appendChild(rem);
      list.appendChild(item);
    });
  }

  function renderSearch() {
    const input   = document.getElementById(cfg.ids.searchInput);
    const results = document.getElementById(cfg.ids.searchResults);
    const catSel  = document.getElementById(cfg.ids.catSelect);
    if (!input || !results) return;
    const q   = input.value.trim().toLowerCase();
    const cat = catSel ? catSel.value : '';
    results.replaceChildren();
    if (!q && !cat) return;
    const max         = cfg.getMax();
    const forcedNames = new Set(cfg.picks.map(e => e.name));
    let matches = db;
    if (cat) matches = matches.filter(e => entryHasCategory(e, cat));
    if (q)   matches = matches.filter(e => e.name.toLowerCase().includes(q));
    matches = matches.slice(0, 30);
    matches.forEach(entry => {
      const already = forcedNames.has(entry.name);
      const full    = max > 0 && cfg.picks.length >= max;
      const item = document.createElement('div');
      item.className = 'forced-result-item' + (already ? ' already' : '') + (full && !already ? ' full' : '');
      item.innerHTML = `<img src="${escapeHtml(imgSrc(entry))}" alt="" loading="lazy"/><span>${escapeHtml(entry.name)}</span>`;
      if (!already && !full) {
        item.style.cursor = 'pointer';
        item.onclick = () => {
          if (cfg.picks.length >= cfg.getMax()) return;
          cfg.picks.push(entry);
          input.value = '';
          results.replaceChildren();
          renderList();
          renderSearch();
          if (cfg.onAdd) cfg.onAdd();
        };
      }
      results.appendChild(item);
    });
  }

  function renderPanel() {
    const sub = document.getElementById(cfg.ids.subtitle);
    if (sub) {
      const max = cfg.getMax();
      sub.innerHTML = max
        ? `Aggiungi fino a <strong>${max}</strong> ${cfg.subtitleSuffix || 'elementi certi'}`
        : cfg.subtitleEmpty || 'Seleziona prima il tabellone';
    }
    _populateForcedCatSelect(cfg.ids.catSelect);
    renderList();
    renderSearch();
  }

  return { renderPanel, renderList, renderSearch };
}

// ── FORCED PICKS helpers ─────────────────────────────────────────────────────
function getForcedMax(){
  if(game.mode==='top5') return TOP5_TOTAL;
  if(game.mode==='dpyramid') return DOUBLE_PYRAMID_TOTAL;
  return 10;
}

function _populateForcedCatSelect(selectId){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Tutte le categorie</option>';
  getCategories().forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat; opt.textContent = cat;
    if(cat === current) opt.selected = true;
    sel.appendChild(opt);
  });
}
function goToTourneySetup()    { tourney.openSetup(); }
function launchTourney()       { tourney.launch(); }
function pickContestant(side)  { tourney.pick(side); }
function confirmTourneyQuit()  { tourney.confirmQuit(); }
function buildRoundDots()      { tourney.buildProgressDots(); }

// ── GameSession ──────────────────────────────────────────────────────────────
class GameSession {
  constructor() {
    this.mode        = 'pyramid'; // 'pyramid' | 'dpyramid' | 'top5'
    this.queue       = [];
    this.data        = [];        // game.data
    this.forcedPicks = [];
  }

  get isTop5()     { return this.mode === 'top5'; }
  get isDPyramid() { return this.mode === 'dpyramid'; }
  get total()      { return this.isTop5 ? TOP5_TOTAL : this.isDPyramid ? DOUBLE_PYRAMID_TOTAL : 10; }

  // ── Launch ────────────────────────────────────────────────────────────
  launch() {
    const pool        = gamePool.getPool();
    const forcedNames = new Set(this.forcedPicks.map(e => e.name));
    const remaining   = pool.filter(e => !forcedNames.has(e.name));
    const needed      = this.total - this.forcedPicks.length;
    if (remaining.length < needed) {
      openModal('Elementi insufficienti',
        `Servono almeno ${needed} elementi casuali aggiuntivi, ma la selezione ne contiene solo ${remaining.length} (esclusi i ${this.forcedPicks.length} forzati).`,
        () => closeModal(), 'OK');
      return;
    }
    this.queue = shuffleArray([...this.forcedPicks, ...shuffleArray(remaining).slice(0, needed)]);
    this.data  = new Array(this.total).fill(null);

    // Label categoria
    const activeCats = [...gamePool.categories];
    let label = activeCats.length === 0 ? 'TUTTE LE CATEGORIE'
              : activeCats.length === 1  ? activeCats[0]
              : activeCats.join(' + ');
    if (gamePool.subcats.size > 0) {
      const sub = [...gamePool.subcats].map(s => { const ci = s.indexOf(':'); return ci > 0 ? s.substring(ci+1) : s; });
      label += ' · ' + sub.join(', ');
    }
    document.getElementById('gameCatLabel').textContent  = label;
    document.getElementById('resultCatTag').textContent  = label;

    const titleMap  = { dpyramid: 'DIAMOND', top5: 'TOP 5', pyramid: 'PYRAMID' };
    const resultMap = { dpyramid: 'IL TUO DIAMOND', top5: 'LA TUA TOP 5', pyramid: 'PYRAMID' };
    document.getElementById('gameTitle').textContent   = titleMap[this.mode]  || 'RANKIFY';
    document.getElementById('gameTitle').style.color   = 'var(--gold)';
    document.getElementById('resultTitle').textContent = resultMap[this.mode] || 'LA TUA TIER LIST';

    const gameBody = document.getElementById('gameView').querySelector('.game-body');
    if (this.isDPyramid) gameBody.classList.add('dpyramid-layout');
    else                 gameBody.classList.remove('dpyramid-layout');

    buildPyramidUI(); showNextCard(); updateProgress(); showView('gameView');

    if (this.isDPyramid) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const cardArea  = gameBody.querySelector('.current-card-area');
        const pyramidEl = document.getElementById('pyramidArea');
        const diff      = (pyramidEl ? pyramidEl.offsetWidth : 0) - (cardArea ? cardArea.offsetWidth : 0);
        if (cardArea && diff > 0) cardArea.style.marginLeft = Math.round(diff/2) + 'px';
      }));
    }
  }

  // ── Card placement ────────────────────────────────────────────────────
  placeCard(slotIdx) {
    if (this.data[slotIdx] !== null) { toast('Slot già occupato!', 'error'); return; }
    if (!this.queue.length) return;
    const entry   = this.queue.shift();
    this.data[slotIdx] = entry;
    const slotSel = this.isTop5 ? `.top5-slot[data-idx="${slotIdx}"]`
                                : `.pyramid-slot[data-idx="${slotIdx}"]`;
    const slot    = document.querySelector(slotSel);
    slot.classList.add('filled');
    slot.innerHTML = this.isTop5
      ? `<img src="${escapeHtml(imgSrc(entry))}" alt="${escapeHtml(entry.name)}" loading="lazy"/><div class="t5-label">${escapeHtml(entry.name)}</div>`
      : `<img src="${escapeHtml(imgSrc(entry))}" alt="${escapeHtml(entry.name)}" loading="lazy"/><div class="slot-label">${escapeHtml(entry.name)}</div>`;
    updateProgress();
    if (!this.queue.length) setTimeout(() => this.showResult(), 600);
    else showNextCard();
  }

  // ── Progress ──────────────────────────────────────────────────────────
  updateProgress() {
    const p = this.total - this.queue.length;
    document.getElementById('progressFill').style.width = (p / this.total * 100) + '%';
    document.getElementById('progressText').textContent = `${p} / ${this.total}`;
  }

  showNextCard() {
    if (!this.queue.length) return;
    const e = this.queue[0];
    document.getElementById('currentImg').src = imgSrc(e);
    document.getElementById('currentName').textContent = e.name;
    const cc = document.getElementById('currentCard');
    cc.style.animation = 'none';
    requestAnimationFrame(() => { cc.style.animation = ''; });
    playEntryAudio(e);
  }

  // ── Result ────────────────────────────────────────────────────────────
  showResult() {
    stopAudio();
    const gb2 = document.getElementById('gameView').querySelector('.game-body');
    gb2.classList.remove('dpyramid-layout');
    const ca2 = gb2.querySelector('.current-card-area');
    if (ca2) ca2.style.marginLeft = '';
    const cont = document.getElementById('resultPyramid'); cont.replaceChildren();

    if (this.isTop5) {
      const row = document.createElement('div'); row.className = 'result-top5-row';
      for (let i = 0; i < TOP5_TOTAL; i++) {
        const entry = this.data[i];
        const slot  = document.createElement('div');
        slot.className = 'result-top5-slot'; slot.style.animationDelay = (i*0.1) + 's';
        if (entry) slot.innerHTML = `<img src="${escapeHtml(imgSrc(entry))}" alt="${escapeHtml(entry.name)}" loading="lazy"/><div class="t5-res-rank">${i+1}</div><div class="slot-name">${escapeHtml(entry.name)}</div>`;
        row.appendChild(slot);
      }
      cont.appendChild(row);
    } else if (this.isDPyramid) {
      const wrap = document.createElement('div'); wrap.className = 'result-dpyramid';
      let idx = 0;
      DOUBLE_PYRAMID_ROWS.forEach((count, rowIdx) => {
        const row = document.createElement('div');
        row.className = rowIdx === 3 ? 'result-row result-dpyramid-center-row' : 'result-row';
        for (let c = 0; c < count; c++) {
          const entry = this.data[idx];
          const slot  = document.createElement('div');
          slot.className         = rowIdx === 3 ? 'result-slot dp-center' : 'result-slot dp-slot';
          slot.style.animationDelay = (idx * 0.05) + 's';
          if (entry) slot.innerHTML = `<img src="${escapeHtml(imgSrc(entry))}" alt="${escapeHtml(entry.name)}" loading="lazy"/><div class="slot-name">${escapeHtml(entry.name)}</div>`;
          row.appendChild(slot); idx++;
        }
        wrap.appendChild(row);
      });
      cont.appendChild(wrap);
    } else {
      const wrap = document.createElement('div'); wrap.className = 'result-pyramid';
      let idx = 0;
      PYRAMID_ROWS.forEach(count => {
        const row = document.createElement('div'); row.className = 'result-row';
        for (let c = 0; c < count; c++) {
          const entry = this.data[idx];
          const slot  = document.createElement('div');
          slot.className = 'result-slot'; slot.style.animationDelay = (idx*0.07) + 's';
          if (entry) slot.innerHTML = `<img src="${escapeHtml(imgSrc(entry))}" alt="${escapeHtml(entry.name)}" loading="lazy"/><div class="slot-name">${escapeHtml(entry.name)}</div>`;
          row.appendChild(slot); idx++;
        }
        wrap.appendChild(row);
      });
      cont.appendChild(wrap);
    }
    showView('resultView');
  }
}



// ── SESSIONI DI GIOCO — istanziate dopo le classi per evitare TDZ ────────────
const tourney = new TourneySession();
const game    = new GameSession();
const forcedPicks = game.forcedPicks;

// ── POOL SELECTOR INSTANCES ──────────────────────────────────────────────────
const gamePool = new PoolSelector({
  modeBarId:'subcatModeBar', sectionId:'subcatSection', gridId:'subcatGrid',
  orBtnId:'subcatModeOR', andBtnId:'subcatModeAND',
  onChange:()=>{ renderCategoryGrid(); updateStartBtn(); updatePoolInfo(); },
});
const tourneyPool = new PoolSelector({
  modeBarId:'tourneySubcatModeBar', sectionId:'tourneySubcatSection', gridId:'tourneySubcatGrid',
  orBtnId:'tourneySubcatModeOR', andBtnId:'tourneySubcatModeAND',
  onChange:()=>{ renderTourneyCatGrid(); updateTourneyPoolInfo(); updateTourneyStartBtn(); },
});

// ── Wrapper game su gamePool ─────────────────────────────────────────────────
function updateStartBtn(){
  const total = getMinItems();
  const pool  = gamePool.getPool();
  const forcedNames = new Set(forcedPicks.map(e=>e.name));
  const remaining = pool.filter(e => !forcedNames.has(e.name));
  const needed = total - forcedPicks.length;
  const ok = forcedPicks.length <= total && remaining.length >= needed;
  const btn = document.getElementById('startGameBtn');
  btn.disabled=!ok; btn.style.opacity=ok?'1':'0.4'; btn.style.cursor=ok?'pointer':'not-allowed';
}
function updatePoolInfo(){
  const el=document.getElementById('poolInfo'); if(!el)return;
  const pool=gamePool.getPool();
  const activeCats=[...gamePool.categories];
  if(activeCats.length===0){el.textContent='';return;}
  const catLabel=activeCats.length===1?activeCats[0]:activeCats.join(' + ');
  const subLabels=[...gamePool.subcats].map(s=>{const ci=s.indexOf(':');return ci>0?s.substring(ci+1):s;});
  const sub=subLabels.length>0?' · '+subLabels.join(gamePool.filterMode==='AND'?' AND ':' OR ')+` <span style="font-size:.72em;color:var(--gold)">[${gamePool.filterMode}]</span>`:'';
  // Aggiungi gli elementi forzati che non sono già nel pool (es. fuori categoria/filtro)
  const poolNames=new Set(pool.map(e=>e.name));
  const extraForced=forcedPicks.filter(e=>!poolNames.has(e.name)).length;
  const total=pool.length+extraForced;
  const forcedNote=extraForced>0?` <span style="font-size:.72em;color:var(--gold)">(+${extraForced} forzati)</span>`:'';
  el.innerHTML=`Pool attuale: <strong>${total}</strong> elementi · ${catLabel}${sub}${forcedNote}`;
}
function selectCategory(cat){ gamePool.toggleCategory(cat); renderCategoryGrid(); gamePool.renderSubcatGrid(); updateStartBtn(); }
function toggleSubcategory(sub){ gamePool.toggleSubcat(sub); gamePool.renderSubcatGrid(); updateStartBtn(); updatePoolInfo(); }

// ── Wrapper tourney su tourneyPool ───────────────────────────────────────────
function getTourneyPool(){ return tourneyPool.getPool(); }
function updateTourneyPoolInfo(){
  const el=document.getElementById('tourneyPoolInfo');
  if(!tourney.size){el.style.display='none';return;}
  const pool=tourneyPool.getPool();
  const real=Math.min(pool.length,tourney.size), byes=tourney.size-real;
  el.style.display='block';
  el.innerHTML=`Pool: <strong>${pool.length}</strong> elementi disponibili &nbsp;·&nbsp; Slot: <strong>${tourney.size}</strong> &nbsp;·&nbsp; Partecipanti reali: <strong>${real}</strong>${byes>0?`<div class="bye-note">⚠ ${byes} slot riempiti con BYE (vittoria automatica)</div>`:''}`;
}
function updateTourneyStartBtn(){
  const btn=document.getElementById('startTourneyBtn');
  const ok=tourney.size>=2&&tourneyPool.getPool().length>=1;
  btn.disabled=!ok; btn.style.opacity=ok?'1':'0.4'; btn.style.cursor=ok?'pointer':'not-allowed';
}

// ── Controller forced picks ───────────────────────────────────────────────────
const _forcedCtrl = createForcedController({
  picks:   forcedPicks,
  getMax:  getForcedMax,
  ids: {
    subtitle:      'forcedPanelSubtitle',
    list:          'forcedList',
    label:         'forcedListLabel',
    divider:       'forcedListDivider',
    searchInput:   'forcedSearchInput',
    searchResults: 'forcedSearchResults',
    catSelect:     'forcedCatSelect',
  },
  onAdd:    () => { updateStartBtn(); updatePoolInfo(); },
  onRemove: () => { updateStartBtn(); updatePoolInfo(); },
});
const _tForcedCtrl = createForcedController({
  picks:         tourney.forcedPicks,
  getMax:        () => tourney.size || 0,
  subtitleEmpty: 'Seleziona prima il tabellone',
  subtitleSuffix:'partecipanti certi',
  ids: {
    subtitle:      'tForcedPanelSubtitle',
    list:          'tForcedList',
    label:         'tForcedListLabel',
    divider:       'tForcedListDivider',
    searchInput:   'tForcedSearchInput',
    searchResults: 'tForcedSearchResults',
    catSelect:     'tForcedCatSelect',
  },
});

// Alias pubblici per retrocompatibilità
function renderForcedPanel()  { _forcedCtrl.renderPanel();  }
function renderForcedList()   { _forcedCtrl.renderList();   }
function renderForcedSearch() { _forcedCtrl.renderSearch(); }
function renderTForcedPanel() { _tForcedCtrl.renderPanel(); }
function renderTForcedList()  { _tForcedCtrl.renderList();  }
function renderTForcedSearch(){ _tForcedCtrl.renderSearch();}

// Wrapper pubblici — nomi usati nell'HTML e negli altri moduli
function launchGame()              { game.launch(); }
function placeCurrentCard(idx)     { game.placeCard(idx); }
function showNextCard()            { game.showNextCard(); }
function updateProgress()          { game.updateProgress(); }
function showResult()              { game.showResult(); }

document.addEventListener('DOMContentLoaded', () => {
  loadDB();
  const cc=document.getElementById('currentCard');
  cc.addEventListener('dragstart',()=>cc.classList.add('dragging'));
  cc.addEventListener('dragend',()=>cc.classList.remove('dragging'));

  _tInitSeek('left');
  _tInitSeek('right');

  _gameAudioPlayer.initSeek();
});
