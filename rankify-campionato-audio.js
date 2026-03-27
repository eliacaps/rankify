// ═══════════════════════════════════════════════════════════════════════════════
// rankify-campionato-audio.js
// Gestione audio per la Tier View del Campionato:
//   • Pulsante ▶ inline su ogni riga — apre la playlist bar posizionata su
//     quella traccia (stesso comportamento di aprire la playlist e saltare)
//   • Barra playlist (play/pausa, prev/next, shuffle, seek)
//
// Dipende da: rankify.js (createAudioPlayer, audioSrc, toast)
//             rankify-campionato.js (getEntryByName, campionatoUI, TIER_CONFIG,
//                                    distributeGroups, campionatoData, getOpenings,
//                                    getTierSorted, TIER_SCORE_KEY)
// ═══════════════════════════════════════════════════════════════════════════════
'use strict';

/* ══════════════════════════════════════════════════════════════
   STATO PLAYLIST
══════════════════════════════════════════════════════════════ */
const _campPlaylist = {
  tracks:    [],   // array di entry objects
  _orderIdx: 0,    // indice corrente in _order
  _order:    [],   // ordine di riproduzione (array di indici in tracks[])
  shuffle:   false,
  active:    false,
  _audio:    null,
  _dragging: false,
};

/* ══════════════════════════════════════════════════════════════
   INLINE PLAY — pulsante ▶ su singola riga
   Apre la playlist bar posizionata su quella traccia.
   Se quella traccia è già in riproduzione, fa toggle play/pausa.
══════════════════════════════════════════════════════════════ */

function campInlinePlay(name, btn) {
  const tracks = _campBuildTrackList();
  if (tracks.length === 0) {
    if (typeof toast === 'function') toast('Nessun elemento con audio in questa lista', 'info');
    return;
  }

  const trackIdx = tracks.findIndex(e => e.name === name);
  if (trackIdx === -1) {
    openCampPlaylist();
    return;
  }

  // Se la playlist è già attiva e questa traccia è quella corrente → toggle
  if (_campPlaylist.active) {
    const curEntry = _campPlaylist.tracks[_campPlaylist._order[_campPlaylist._orderIdx]];
    if (curEntry && curEntry.name === name) {
      campPlaylistToggle();
      return;
    }
  }

  // Apri (o riapri) la playlist partendo da questa traccia
  _campPlaylistOpen(tracks, trackIdx);
}

/* ══════════════════════════════════════════════════════════════
   RACCOLTA TRACCE per la playlist
══════════════════════════════════════════════════════════════ */

function _campBuildTrackList() {
  const tier  = campionatoUI.currentTier;
  const cfg   = TIER_CONFIG[tier];
  const group = campionatoUI.currentGroup;

  let names;
  if (cfg.type === 'grouped' && group) {
    names = distributeGroups(tier)[group] || [];
  } else if (TIER_SCORE_KEY && TIER_SCORE_KEY[tier]) {
    names = getTierSorted(tier);
  } else {
    names = campionatoData[tier] || [];
  }

  return names
    .map(n => getEntryByName(n))
    .filter(e => e && e.audioPath);
}

/* ══════════════════════════════════════════════════════════════
   PLAYLIST — APERTURA / CHIUSURA
══════════════════════════════════════════════════════════════ */

/** Apre la playlist dalla prima traccia. */
function openCampPlaylist() {
  const tracks = _campBuildTrackList();
  if (tracks.length === 0) {
    if (typeof toast === 'function') toast('Nessun elemento con audio in questa lista', 'info');
    return;
  }
  _campPlaylistOpen(tracks, 0);
}

/** Inizializza e avvia la playlist all'indice startIdx. */
function _campPlaylistOpen(tracks, startIdx) {
  // Ferma qualsiasi altro audio attivo (gioco, torneo)
  if (typeof stopAudio        === 'function') stopAudio();
  if (typeof stopAllContAudio === 'function') stopAllContAudio();

  // Ferma eventuale audio precedente della playlist
  if (_campPlaylist._audio) {
    const a = _campPlaylist._audio;
    _campPlaylist._audio = null;
    a.pause();
    try { a.src = ''; } catch(_) {}
  }

  _campPlaylist.tracks    = tracks;
  _campPlaylist.shuffle   = false;
  _campPlaylist._order    = tracks.map((_, i) => i);
  _campPlaylist._orderIdx = startIdx;
  _campPlaylist.active    = true;

  const sb = document.getElementById('cplShuffleBtn');
  if (sb) sb.classList.remove('active');

  _campPlaylistRenderBar();
  _campPlaylistLoadTrack(startIdx);
}

function stopCampPlaylist() {
  if (_campPlaylist._audio) {
    const a = _campPlaylist._audio;
    _campPlaylist._audio = null;
    a.pause();
    try { a.src = ''; } catch(_) {}
  }
  _campPlaylist.active = false;
  document.querySelectorAll('.camp-inline-play-btn.playing').forEach(b => {
    b.textContent = '▶'; b.classList.remove('playing');
  });

  const bar = document.getElementById('campPlaylistBar');
  if (bar) bar.classList.remove('open');
  document.body.classList.remove('cpl-bar-open');
}

function closeCampPlaylist() {
  stopCampPlaylist();
}

/* ══════════════════════════════════════════════════════════════
   PLAYLIST — RENDER BARRA
══════════════════════════════════════════════════════════════ */

function _campPlaylistRenderBar() {
  let bar = document.getElementById('campPlaylistBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'campPlaylistBar';
    bar.innerHTML = `
      <div class="cpl-left">
        <div class="cpl-thumb" id="cplThumb"></div>
        <div class="cpl-info">
          <div class="cpl-title" id="cplTitle">—</div>
          <div class="cpl-sub"   id="cplSub">—</div>
        </div>
      </div>

      <div class="cpl-center">
        <button class="cpl-btn cpl-shuffle" id="cplShuffleBtn" title="Casuale" onclick="campPlaylistToggleShuffle()">⇄</button>
        <button class="cpl-btn cpl-prev"    id="cplPrevBtn"    title="Precedente" onclick="campPlaylistPrev()">⏮</button>
        <button class="cpl-btn cpl-play"    id="cplPlayBtn"    title="Play/Pausa" onclick="campPlaylistToggle()">▶</button>
        <button class="cpl-btn cpl-next"    id="cplNextBtn"    title="Prossima"   onclick="campPlaylistNext()">⏭</button>
        <button class="cpl-btn cpl-close"   title="Chiudi"     onclick="closeCampPlaylist()">✕</button>
      </div>

      <div class="cpl-right">
        <div class="cpl-progress-wrap">
          <span class="cpl-time" id="cplTimeCurrent">0:00</span>
          <div class="cpl-track" id="cplTrack">
            <div class="cpl-fill"        id="cplFill"></div>
            <div class="cpl-thumb-track" id="cplThumbTrack"></div>
          </div>
          <span class="cpl-time" id="cplTimeTotal">0:00</span>
        </div>

      </div>
    `;
    document.body.appendChild(bar);

    const track = document.getElementById('cplTrack');
    if (track) {
      track.addEventListener('mousedown', e => {
        _campPlaylist._dragging = true;
        _cplSeekTo(e, track);
      });
      window.addEventListener('mousemove', e => {
        if (_campPlaylist._dragging) _cplSeekTo(e, track);
      });
      window.addEventListener('mouseup', () => { _campPlaylist._dragging = false; });
      track.addEventListener('touchstart', e => { _cplSeekTo(e.touches[0], track); }, { passive: true });
      track.addEventListener('touchmove',  e => { _cplSeekTo(e.touches[0], track); }, { passive: true });
    }
  }

  // Reset thumb/info prima di mostrare la barra (evita immagine residua dalla sessione precedente)
  const thumbEl = document.getElementById('cplThumb');
  if (thumbEl) { thumbEl.style.backgroundImage = 'none'; thumbEl.textContent = '🎵'; }
  const titleEl = document.getElementById('cplTitle');
  if (titleEl) titleEl.textContent = '—';
  const subEl = document.getElementById('cplSub');
  if (subEl) subEl.textContent = '—';

  bar.classList.add('open');
  document.body.classList.add('cpl-bar-open');
}

function _cplSeekTo(e, trackEl) {
  const audio = _campPlaylist._audio;
  if (!audio || !audio.duration) return;
  const rect = trackEl.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
  _cplUpdateProgress();
}

/* ══════════════════════════════════════════════════════════════
   PLAYLIST — CARICAMENTO E RIPRODUZIONE
══════════════════════════════════════════════════════════════ */

function _campPlaylistLoadTrack(orderIdx, autoplay = true) {
  const pl = _campPlaylist;
  if (!pl.tracks.length) return;
  pl._orderIdx = orderIdx;

  const entry = pl.tracks[pl._order[orderIdx]];

  // Ferma audio precedente — azzera PRIMA per bloccare i listener stale
  if (pl._audio) {
    const old = pl._audio;
    pl._audio = null;
    old.pause();
    try { old.src = ''; } catch(_) {}
  }

  // Resetta tutti i pulsanti inline — il listener 'playing' metterà ⏸ sulla traccia corrente
  document.querySelectorAll('.camp-inline-play-btn.playing').forEach(b => {
    b.textContent = '▶'; b.classList.remove('playing');
  });

  // Aggiorna UI header
  const titleEl = document.getElementById('cplTitle');
  const subEl   = document.getElementById('cplSub');
  const thumbEl = document.getElementById('cplThumb');

  if (titleEl) titleEl.textContent = entry.name;
  if (subEl)   subEl.textContent   = entry.data || '';
  if (thumbEl) {
    // Reset completo prima di impostare la nuova immagine
    thumbEl.style.backgroundImage = 'none';
    thumbEl.textContent = '';
    const _imgUrl = (typeof imgSrc === 'function') ? imgSrc(entry) : entry.imgPath;
    if (_imgUrl) {
      thumbEl.style.backgroundImage = `url(${_imgUrl})`;
    } else {
      thumbEl.textContent = '🎵';
    }
  }

  // Reset progress
  _cplSetPct(0);
  const tc = document.getElementById('cplTimeCurrent');
  const tt = document.getElementById('cplTimeTotal');
  if (tc) tc.textContent = '0:00';
  if (tt) tt.textContent = '0:00';

  const btnPlay = document.getElementById('cplPlayBtn');
  if (btnPlay) btnPlay.textContent = '▶';

  const _audioUrl = (typeof audioSrc === "function") ? audioSrc(entry) : entry.audioPath;
  if (!_audioUrl) { _campHighlightCurrentRow(); return; }

  const audio = new Audio(_audioUrl);
  audio.volume = 1.0;
  pl._audio = audio;

  const myAudio = audio; // guard di generazione
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  audio.addEventListener('timeupdate', () => {
    if (pl._audio !== myAudio) return;
    if (!pl._dragging) _cplUpdateProgress();
  });
  audio.addEventListener('loadedmetadata', () => {
    if (pl._audio !== myAudio) return;
    if (tt) tt.textContent = fmt(audio.duration || 0);
  });
  audio.addEventListener('playing', () => {
    if (pl._audio !== myAudio) return;
    if (btnPlay) btnPlay.textContent = '⏸';
    const row = document.querySelector(`.camp-rank-row[data-name="${CSS.escape(entry.name)}"]`);
    const ib  = row ? row.querySelector('.camp-inline-play-btn') : null;
    if (ib) { ib.textContent = '⏸'; ib.classList.add('playing'); }
  });
  audio.addEventListener('pause', () => {
    if (pl._audio !== myAudio) return;
    if (btnPlay) btnPlay.textContent = '▶';
    const row = document.querySelector(`.camp-rank-row[data-name="${CSS.escape(entry.name)}"]`);
    const ib  = row ? row.querySelector('.camp-inline-play-btn') : null;
    if (ib) { ib.textContent = '▶'; ib.classList.remove('playing'); }
  });
  audio.addEventListener('ended', () => {
    if (pl._audio !== myAudio) return;
    campPlaylistNext();
  });
  audio.addEventListener('error', () => {
    if (pl._audio !== myAudio) return;
    if (typeof toast === 'function') toast(`Audio non trovato: ${entry.name}`, 'error');
    campPlaylistNext();
  });

  if (autoplay) audio.play().catch(() => {});

  _campHighlightCurrentRow();
}

function _cplUpdateProgress() {
  const audio = _campPlaylist._audio;
  if (!audio || !audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  _cplSetPct(pct);
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const tc = document.getElementById('cplTimeCurrent');
  if (tc) tc.textContent = fmt(audio.currentTime);
}

function _cplSetPct(pct) {
  const fill  = document.getElementById('cplFill');
  const thumb = document.getElementById('cplThumbTrack');
  if (fill)  fill.style.width = pct + '%';
  if (thumb) thumb.style.left = pct + '%';
}

/* ══════════════════════════════════════════════════════════════
   PLAYLIST — CONTROLLI
══════════════════════════════════════════════════════════════ */

function campPlaylistToggle() {
  const audio = _campPlaylist._audio;
  if (!audio) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function campPlaylistNext() {
  const pl   = _campPlaylist;
  const next = pl._orderIdx + 1;
  if (next >= pl._order.length) {
    if (pl._audio) {
      const a = pl._audio;
      pl._audio = null;
      a.pause();
      try { a.src = ''; } catch(_) {}
    }
    document.querySelectorAll('.camp-inline-play-btn.playing').forEach(b => {
      b.textContent = '▶'; b.classList.remove('playing');
    });
    pl.active = false;
    const btnPlay = document.getElementById('cplPlayBtn');
    if (btnPlay) btnPlay.textContent = '▶';
    return;
  }
  _campPlaylistLoadTrack(next);
}

function campPlaylistPrev() {
  const pl    = _campPlaylist;
  const audio = pl._audio;
  if (audio && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (pl._orderIdx <= 0) {
    if (audio) audio.currentTime = 0;
    return;
  }
  _campPlaylistLoadTrack(pl._orderIdx - 1);
}

function campPlaylistToggleShuffle() {
  const pl = _campPlaylist;
  pl.shuffle = !pl.shuffle;

  const btn = document.getElementById('cplShuffleBtn');
  if (btn) btn.classList.toggle('active', pl.shuffle);

  if (pl.shuffle) {
    const cur  = pl._order[pl._orderIdx];
    const rest = shuffleArray(
      pl.tracks.map((_, i) => i).filter(i => i !== cur)
    );
    pl._order    = [cur, ...rest];
    pl._orderIdx = 0;
  } else {
    const cur    = pl._order[pl._orderIdx];
    pl._order    = pl.tracks.map((_, i) => i);
    pl._orderIdx = pl._order.indexOf(cur);
  }
}

/* ══════════════════════════════════════════════════════════════
   HIGHLIGHT RIGA CORRENTE nella tier list
══════════════════════════════════════════════════════════════ */

function _campHighlightCurrentRow() {
  document.querySelectorAll('.camp-rank-row').forEach(r => r.classList.remove('cpl-row-playing'));
  const entry = _campPlaylist.tracks[_campPlaylist._order[_campPlaylist._orderIdx]];
  if (!entry) return;
  const row = document.querySelector(`.camp-rank-row[data-name="${CSS.escape(entry.name)}"]`);
  if (!row) return;
  row.classList.add('cpl-row-playing');
  // Scrolla solo se la riga non è già visibile nel viewport
  const rect = row.getBoundingClientRect();
  const inView = rect.top >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight);
  if (!inView) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ══════════════════════════════════════════════════════════════
   HOOK — inietta pulsanti nella tier list dopo il render
   Chiamata da renderTierList() in rankify-campionato.js
══════════════════════════════════════════════════════════════ */

/**
 * Aggiunge i pulsanti ▶ inline a ogni riga con audio.
 * Va chiamata DOPO renderTierList().
 */
function campAudioInjectUI() {
  _campInjectInlineButtons();
  // Ripristina lo stato visivo se la playlist è attiva (rientro nella pagina)
  if (_campPlaylist.active && _campPlaylist._audio && !_campPlaylist._audio.paused) {
    _campHighlightCurrentRow();
    const entry = _campPlaylist.tracks[_campPlaylist._order[_campPlaylist._orderIdx]];
    if (entry) {
      const row = document.querySelector('.camp-rank-row[data-name="' + CSS.escape(entry.name) + '"]');
      const ib  = row ? row.querySelector('.camp-inline-play-btn') : null;
      if (ib) { ib.textContent = '⏸'; ib.classList.add('playing'); }
    }
  }
}

/** Aggiunge data-name e pulsante ▶ a ogni riga che ha audio. */
function _campInjectInlineButtons() {
  const rows = document.querySelectorAll('#campionatoRankList .camp-rank-row');
  rows.forEach(row => {
    let name = row.dataset.name;
    if (!name) {
      const nameEl = row.querySelector('.camp-rank-name');
      if (nameEl) { name = nameEl.textContent.trim(); row.dataset.name = name; }
    }
    if (!name) return;

    if (row.querySelector('.camp-inline-play-btn')) return;

    const entry = typeof getEntryByName === 'function' ? getEntryByName(name) : null;
    if (!entry || !entry.audioPath) return;

    const btn = document.createElement('button');
    btn.className   = 'camp-inline-play-btn';
    btn.title       = 'Ascolta';
    btn.textContent = '▶';
    btn.onclick = e => {
      e.stopPropagation();
      campInlinePlay(name, btn);
    };

    const scoreWrap   = row.querySelector('.camp-s-score-wrap');
    const actionsWrap = row.querySelector('.camp-rank-actions');
    if (scoreWrap)        row.insertBefore(btn, scoreWrap);
    else if (actionsWrap) row.insertBefore(btn, actionsWrap);
    else                  row.appendChild(btn);
  });
}
