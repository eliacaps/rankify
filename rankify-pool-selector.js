// ═══════════════════════════════════════════════════════════════════════════════
// rankify-pool-selector.js
// Dipende da: rankify.js  (db, getCatFields, entryHasCategory, buildSubcatAccordion)
//
// Sostituisce — in rankify.js:
//   getGamePool, getTourneyPool, renderSubcatGrid, renderTourneySubcatGrid,
//   updatePoolInfo, updateTourneyPoolInfo, _refreshModeBar, _refreshTourneyModeBar,
//   selectCategory, toggleSubcategory (le parti di stato)
// Sostituisce — in rankify-quiz.js:
//   _quizGetPool, _quizRenderSubcatSection (la parte pool/subcat)
// ═══════════════════════════════════════════════════════════════════════════════

class PoolSelector {
  /**
   * @param {object} cfg
   * @param {string}   cfg.modeBarId     id del div OR/AND da creare/riusare
   * @param {string}   cfg.sectionId     id del section wrapper subcategorie
   * @param {string}   cfg.gridId        id del div griglia subcategorie
   * @param {string}   cfg.orBtnId       id del pulsante OR
   * @param {string}   cfg.andBtnId      id del pulsante AND
   * @param {Function} [cfg.baseFilter]  filtro extra sull'intero db (es. solo entry con audio)
   *                                     signature: (entry) => bool
   * @param {Function} [cfg.onChange]    callback chiamata ad ogni cambio selezione
   */
  constructor(cfg) {
    this._cfg        = cfg;
    this.categories  = new Set();   // Set<string> — categorie selezionate
    this.subcats     = new Set();   // Set<string> — chiavi "field:value"
    this.filterMode  = 'OR';        // 'OR' | 'AND'
  }

  // ── SELEZIONE CATEGORIE ────────────────────────────────────────────────────

  /** Seleziona/deseleziona una categoria (null = TUTTE). */
  toggleCategory(cat) {
    if (cat === null) {
      this.categories = new Set();
    } else {
      this.categories.has(cat) ? this.categories.delete(cat) : this.categories.add(cat);
    }
    this.subcats     = new Set();
    this.filterMode  = 'OR';
    this._notify();
  }

  // ── SELEZIONE SUBCATEGORIE ─────────────────────────────────────────────────

  /** Seleziona/deseleziona una sottochiave "field:value". */
  toggleSubcat(key) {
    this.subcats.has(key) ? this.subcats.delete(key) : this.subcats.add(key);
    this._notify();
  }

  /** Cambia la modalità filtro OR/AND. */
  setFilterMode(mode) {
    this.filterMode = mode;
    this._notify();
  }

  // ── POOL ──────────────────────────────────────────────────────────────────

  /** Restituisce l'array di entry corrispondente alla selezione corrente. */
  getPool() {
    const activeCats = [...this.categories];

    // Base: tutte le categorie selezionate, oppure intero db
    let base = activeCats.length === 0
      ? [...db]
      : db.filter(e => activeCats.some(cat => entryHasCategory(e, cat)));

    // Filtro extra (es. solo entry con audio)
    if (this._cfg.baseFilter) base = base.filter(this._cfg.baseFilter);

    if (this.subcats.size === 0) return base;

    // Raggruppa i filtri per campo: { field: [val, ...] }
    const byField = {};
    for (const s of this.subcats) {
      const ci = s.indexOf(':');
      if (ci > 0) {
        const f = s.substring(0, ci), v = s.substring(ci + 1);
        (byField[f] = byField[f] || []).push(v);
      }
    }
    const fieldEntries = Object.entries(byField);

    if (this.filterMode === 'OR') {
      return base.filter(e => fieldEntries.some(([f, vs]) => vs.includes(e[f])));
    } else {
      // AND: l'entry deve soddisfare TUTTI i campi filtrati
      return base.filter(e => fieldEntries.every(([f, vs]) => vs.includes(e[f])));
    }
  }

  // ── COMPATIBILITÀ ─────────────────────────────────────────────────────────

  /**
   * Alias per chi usava selectedCategory (singola categoria o null).
   * Restituisce la categoria se ne è selezionata esattamente una, altrimenti null.
   */
  get singleCategory() {
    return this.categories.size === 1 ? [...this.categories][0] : null;
  }

  // ── RENDER GRIGLIA SUBCATEGORIE ───────────────────────────────────────────

  /**
   * Costruisce/aggiorna la griglia fisarmonicca delle sottocategorie
   * e il toggle OR/AND nel DOM.
   * Chiamare dopo ogni cambio di categoria.
   */
  renderSubcatGrid() {
    const sec  = document.getElementById(this._cfg.sectionId);
    const grid = document.getElementById(this._cfg.gridId);
    if (!sec || !grid) return;

    // Se showAllWhenEmpty=true (es. quiz), categories vuoto = tutte le categorie
    const activeCats = this.categories.size > 0
      ? [...this.categories]
      : (this._cfg.showAllWhenEmpty ? getCategories() : []);

    if (activeCats.length === 0) {
      sec.classList.remove('visible');
      sec.style.display = '';
      grid.replaceChildren();
      const old = document.getElementById(this._cfg.modeBarId);
      if (old) old.remove();
      return;
    }

    // Costruisce la mappa dei gruppi: field -> { key, label, count }
    // Se c'è un baseFilter (es. solo entry con audio), applicalo anche ai conteggi
    const allGroupsMap = {};
    activeCats.forEach(cat => {
      const fields = getCatFields(cat);
      const inCat  = this._cfg.baseFilter
        ? db.filter(e => entryHasCategory(e, cat) && this._cfg.baseFilter(e))
        : db.filter(e => entryHasCategory(e, cat));
      fields.forEach(f => {
        const vals = [...new Set(inCat.map(e => e[f]).filter(Boolean))].sort();
        if (!vals.length) return;
        if (!allGroupsMap[f]) allGroupsMap[f] = {};
        vals.forEach(v => {
          const key = f + ':' + v;
          if (!allGroupsMap[f][key]) allGroupsMap[f][key] = { key, label: v, count: 0 };
          allGroupsMap[f][key].count += inCat.filter(e => e[f] === v).length;
        });
      });
    });

    const groups = {};
    Object.entries(allGroupsMap).forEach(([f, km]) => {
      const items = Object.values(km).sort((a, b) =>
        a.label.localeCompare(b.label, 'it', { sensitivity: 'base' }));
      if (items.length) groups[f] = items;
    });

    if (!Object.keys(groups).length) {
      sec.classList.remove('visible');
      sec.style.display = 'none';
      grid.replaceChildren();
      return;
    }

    sec.classList.add('visible');
    sec.style.display = '';

    this._renderModeBar(grid);

    const colClasses = {
      data:'col-data', anime:'col-anime', artista:'col-artista', genere:'col-genere',
      valutazione:'col-valutazione', regione:'col-regione', classe:'col-classe', ruolo:'col-ruolo',
    };
    buildSubcatAccordion(grid, groups, this.subcats, key => {
      this.toggleSubcat(key);
      this.renderSubcatGrid();
    }, colClasses);
  }

  // ── PRIVATI ───────────────────────────────────────────────────────────────

  /** Crea o aggiorna la modeBar OR/AND sopra la griglia. */
  _renderModeBar(grid) {
    let bar = document.getElementById(this._cfg.modeBarId);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = this._cfg.modeBarId;
      bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;';

      const lbl = document.createElement('span');
      lbl.style.cssText = 'color:#8080a0;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;';
      lbl.textContent   = 'Modalità filtri (più filtri =';

      const btnOR  = document.createElement('button');
      btnOR.id     = this._cfg.orBtnId;
      btnOR.title  = 'Elementi che hanno ALMENO UNO dei filtri selezionati';

      const btnAND = document.createElement('button');
      btnAND.id    = this._cfg.andBtnId;
      btnAND.title = 'Elementi che hanno TUTTI i filtri selezionati';

      const baseStyle = 'border:1.5px solid;border-radius:8px;padding:4px 14px;font-size:.78rem;font-weight:700;letter-spacing:.1em;cursor:pointer;transition:all .18s;';
      btnOR.style.cssText  = baseStyle;
      btnAND.style.cssText = baseStyle;

      const close = document.createElement('span');
      close.style.cssText = 'color:#8080a0;font-size:.78rem;';
      close.textContent   = ')';

      btnOR.onclick  = () => { this.setFilterMode('OR');  this._refreshModeBar(); this.renderSubcatGrid(); };
      btnAND.onclick = () => { this.setFilterMode('AND'); this._refreshModeBar(); this.renderSubcatGrid(); };

      bar.appendChild(lbl);
      bar.appendChild(btnOR);
      bar.appendChild(btnAND);
      bar.appendChild(close);
      grid.parentElement.insertBefore(bar, grid);
    }
    this._refreshModeBar();
  }

  /** Aggiorna i colori/testi dei pulsanti OR/AND. */
  _refreshModeBar() {
    const btnOR  = document.getElementById(this._cfg.orBtnId);
    const btnAND = document.getElementById(this._cfg.andBtnId);
    if (!btnOR || !btnAND) return;
    if (this.filterMode === 'OR') {
      btnOR.textContent  = 'OR';
      btnOR.style.cssText  += ';background:var(--gold,#c9a84c);color:#1a1a2e;border-color:var(--gold,#c9a84c);';
      btnAND.textContent = 'AND';
      btnAND.style.cssText += ';background:transparent;color:#8080a0;border-color:#444;';
    } else {
      btnAND.textContent = 'AND ✓';
      btnAND.style.cssText += ';background:var(--gold,#c9a84c);color:#1a1a2e;border-color:var(--gold,#c9a84c);';
      btnOR.textContent  = 'OR';
      btnOR.style.cssText  += ';background:transparent;color:#8080a0;border-color:#444;';
    }
  }

  /** Chiama onChange se definito. */
  _notify() {
    if (this._cfg.onChange) this._cfg.onChange(this);
  }
}
