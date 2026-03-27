// ═══════════════════════════════════════════════════════════════════════════════
// TourneySession
// Incapsula tutto lo stato e la logica di una sessione torneo (bracket elimination).
// Sostituisce le 11 variabili globali tSize, tBracket, tRound, tMatchIdx,
// tRoundMatches, tRoundWinners, tAllRounds, tTotalRounds, tRealMatchNum,
// tTotalRealMatches, tForcedPicks.
//
// Dipende da (globali di rankify.js):
//   BYE_ENTRY, shuffleArray, buildRoundMatches, countRealMatches,
//   tourneyPool, getTourneyPool,
//   stopAllContAudio, loadContAudio, imgSrc,
//   showView, openModal, closeModal, toast,
//   renderTourneySlots, renderTourneyCatGrid, updateTourneyPoolInfo,
//   updateTourneyStartBtn, renderTForcedPanel, db
// ═══════════════════════════════════════════════════════════════════════════════

class TourneySession {
  constructor() {
    this.size          = 8;
    this.forcedPicks   = [];
    // Stato sessione in corso (null = nessuna sessione attiva)
    this._bracket      = null;
    this._round        = 0;
    this._matchIdx     = 0;
    this._roundMatches = [];
    this._roundWinners = [];
    this._allRounds    = [];
    this._totalRounds  = 0;
    this._realMatchNum      = 0;
    this._totalRealMatches  = 0;
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  openSetup() {
    if (db.length < 2) { toast('Servono almeno 2 elementi nel database!', 'error'); return; }
    const mp  = document.getElementById('modePicker');
    const btn = document.getElementById('playBtn');
    if (mp)  mp.classList.remove('open');
    if (btn) btn.textContent = '▶ Gioca';
    this.size = 8;
    this.forcedPicks.splice(0);
    tourneyPool.toggleCategory(null);
    renderTourneySlots();
    renderTourneyCatGrid();
    tourneyPool.renderSubcatGrid();
    updateTourneyPoolInfo();
    updateTourneyStartBtn();
    renderTForcedPanel();
    showView('tourneySetupView');
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  launch() {
    const pool        = getTourneyPool();
    const forcedNames = new Set(this.forcedPicks.map(e => e.name));
    const remaining   = shuffleArray(pool.filter(e => !forcedNames.has(e.name)));
    const randomCount = Math.max(0, this.size - this.forcedPicks.length);
    const slots       = [...this.forcedPicks, ...remaining.slice(0, randomCount)];
    while (slots.length < this.size) slots.push({...BYE_ENTRY});

    this._bracket           = shuffleArray(slots);
    this._round             = 0;
    this._matchIdx          = 0;
    this._roundWinners      = [];
    this._allRounds         = [];
    this._totalRounds       = Math.log2(this.size);
    this._roundMatches      = buildRoundMatches(this._bracket);
    this._realMatchNum      = 0;
    this._totalRealMatches  = countRealMatches(this._bracket);

    // Label categoria
    const activeCats = [...tourneyPool.categories];
    let label = activeCats.length === 0 ? 'TUTTE LE CATEGORIE'
              : activeCats.length === 1  ? activeCats[0]
              : activeCats.join(' + ');
    if (tourneyPool.subcats.size > 0) {
      const subLabels = [...tourneyPool.subcats].map(s => {
        const i = s.indexOf(':'); return i > 0 ? s.substring(i + 1) : s;
      });
      label += ' · ' + subLabels.join(tourneyPool.filterMode === 'AND' ? ' AND ' : ' OR ');
    }
    document.getElementById('tourneyResultLabel').textContent = label;
    showView('tourneyMatchView');
    this._advance();
  }

  // ── Match flow ─────────────────────────────────────────────────────────────

  pick(side) {
    const [a, b] = this._roundMatches[this._matchIdx];
    const winner = side === 0 ? a : b;
    const cardId = side === 0 ? 'contLeft' : 'contRight';
    document.getElementById(cardId).classList.add('picked');
    stopAllContAudio();
    this._roundWinners.push(winner);
    this._matchIdx++;
    setTimeout(() => this._advance(), 420);
  }

  _advance() {
    while (this._matchIdx < this._roundMatches.length) {
      const [a, b] = this._roundMatches[this._matchIdx];
      if (a._isBye && b._isBye) {
        this._roundWinners.push({...BYE_ENTRY}); this._matchIdx++;
      } else if (a._isBye) {
        this._roundWinners.push(b); this._matchIdx++;
      } else if (b._isBye) {
        this._roundWinners.push(a); this._matchIdx++;
      } else {
        this._realMatchNum++;
        this._renderMatchScreen();
        return;
      }
    }
    // Fine round
    this._allRounds.push([...this._roundWinners]);
    this._round++;
    if (this._roundWinners.length === 1) {
      this._showResult(this._roundWinners[0]);
      return;
    }
    this._roundMatches = buildRoundMatches(shuffleArray(this._roundWinners));
    this._matchIdx     = 0;
    this._roundWinners = [];
    this._advance();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  _renderMatchScreen() {
    const [a, b]     = this._roundMatches[this._matchIdx];
    const roundName  = this._getRoundName();
    document.getElementById('matchRoundLabel').textContent = roundName;
    document.getElementById('matchCounter').textContent    =
      `Match ${this._realMatchNum} / ${this._totalRealMatches}`;

    const setCard = (idCard, idImg, idName, entry, audioSide) => {
      const card = document.getElementById(idCard);
      document.getElementById(idImg).src         = imgSrc(entry);
      document.getElementById(idName).textContent = entry.name;
      card.className = 'contestant' + (entry._isBye ? ' is-bye' : '');
      const old = card.querySelector('.bye-badge');
      if (old) old.remove();
      if (entry._isBye) {
        const badge = document.createElement('div');
        badge.className = 'bye-badge'; badge.textContent = 'BYE';
        card.appendChild(badge);
      }
      loadContAudio(audioSide, entry);
    };
    setCard('contLeft',  'contLeftImg',  'contLeftName',  a, 'left');
    setCard('contRight', 'contRightImg', 'contRightName', b, 'right');
    this.buildProgressDots();
  }

  buildProgressDots() {
    const container = document.getElementById('matchProgressDots');
    if (!container) return;
    container.replaceChildren();
    const maxDots = Math.min(this._totalRealMatches, 20);
    for (let i = 0; i < maxDots; i++) {
      const d   = document.createElement('div');
      const idx = i + 1;
      d.className = idx < this._realMatchNum ? 'match-dot done'
                  : idx === this._realMatchNum ? 'match-dot current'
                  : 'match-dot';
      container.appendChild(d);
    }
  }

  _showResult(winner) {
    stopAllContAudio();
    const wCard = document.getElementById('tourneyWinnerCard');
    wCard.replaceChildren();
    const wImg  = document.createElement('img');
    wImg.src = imgSrc(winner); wImg.alt = winner.name; wImg.loading = 'lazy';
    const wName = document.createElement('div');
    wName.className = 'w-name'; wName.textContent = winner.name;
    wCard.appendChild(wImg); wCard.appendChild(wName);

    const podiumEl = document.getElementById('tourneyPodium');
    podiumEl.replaceChildren();
    const finalists = [];
    if (this._allRounds.length >= 2) {
      const sfWinners = this._allRounds[this._allRounds.length - 2];
      const finalist  = sfWinners.find(e => e.name !== winner.name && !e._isBye);
      if (finalist) finalists.push({ entry: finalist, rank: '🥈 2°' });
      if (this._allRounds.length >= 3) {
        this._allRounds[this._allRounds.length - 3].forEach(e => {
          if (!e._isBye && e.name !== winner.name && e.name !== (finalist||{}).name)
            finalists.push({ entry: e, rank: '🥉 3°' });
        });
      }
    }
    if (finalists.length > 0) {
      podiumEl.style.display = 'flex';
      finalists.slice(0, 4).forEach(({ entry, rank }) => {
        const div = document.createElement('div');
        div.className = 'podium-entry';
        div.innerHTML = `<img src="${imgSrc(entry)}" alt="${entry.name}" loading="lazy"/>
          <div class="p-rank">${rank}</div>
          <div class="p-name">${entry.name}</div>`;
        podiumEl.appendChild(div);
      });
    } else {
      podiumEl.style.display = 'none';
    }
    showView('tourneyResultView');
  }

  _getRoundName() {
    const remaining = this._totalRounds - this._round;
    if (remaining === 1) return 'FINALE';
    if (remaining === 2) return 'SEMIFINALE';
    if (remaining === 3) return 'QUARTI DI FINALE';
    if (remaining === 4) return 'OTTAVI DI FINALE';
    return `ROUND ${this._round + 1} di ${this._totalRounds}`;
  }

  confirmQuit() {
    openModal('Esci dal Torneo?', 'Il progresso verrà perso.', () => {
      stopAllContAudio(); closeModal(); showView('homeView');
    }, 'Esci');
  }
}
