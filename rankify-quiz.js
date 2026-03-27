// ═══════════════════════════════════════════════════════════════════════════════
// RANKIFY — QUIZ MODE  (rankify-quiz.js)
// Dipende da: rankify.js  (db, imgSrc, audioSrc, showView, shuffleArray)
// ═══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── CONSTANTS ────────────────────────────────────────────────────────────────
  const CHOICES         = 4;
  const REVEAL_DELAY    = 1400;
  const SUGGESTIONS_MAX = 6;

  // ── STATE ────────────────────────────────────────────────────────────────────
  let _quizEntries  = [];
  let quizQuestions = [];
  let quizIndex     = 0;
  let quizScore     = 0;
  let quizAudio     = null;
  let quizAnswered  = false;
  let quizTimer     = null;
  let quizClipTimer = null;
  let quizVolume    = 0.8;
  let quizClipMs    = 20000;
  let answerMode    = 'multi';  // 'multi' | 'free'
  let freeHighlight = -1;

  // ── QUIZ SUBCAT FILTER STATE ─────────────────────────────────────────────────
  // quizSelectedSubcats → gestito da quizPool (PoolSelector)


  // ── QUIZ POOL SELECTOR ───────────────────────────────────────────────────────
  const quizPool = new PoolSelector({
    modeBarId:  'quizSubcatModeBar',
    sectionId:  'quizSubcatSection',
    gridId:     'quizSubcatGrid',
    orBtnId:    'quizSubcatModeOR',
    andBtnId:   'quizSubcatModeAND',
    baseFilter: e => !!(e.audioPath && e.audioPath.trim()),
    showAllWhenEmpty: true,
    onChange:   () => _quizBuildPool(),
  });

  // ── ENTRY POINT ──────────────────────────────────────────────────────────────
  const MIN_POOL = 5;

  window.startQuizMode = function () {
    const allAudio = db.filter(e => e.audioPath && e.audioPath.trim());
    if (allAudio.length < MIN_POOL) {
      openModal(
        'Audio insufficienti',
        `Servono almeno ${MIN_POOL} elementi con un file audio caricato per giocare al Quiz.`,
        () => closeModal(), 'OK'
      );
      return;
    }
    quizPool.categories = new Set(); quizPool.subcats = new Set(); quizPool.filterMode = 'OR';
    _quizBuildPool();
    _quizRenderSubcatSection();
    showView('quizSetupView');
  };

  // ── POOL HELPERS ─────────────────────────────────────────────────────────────
  function _quizGetPool() { return quizPool.getPool(); }

  function _quizBuildPool() {
    _quizEntries = quizPool.getPool();
    const count = _quizEntries.length;

    const poolEl = _el('quizSetupPool');
    if (poolEl) poolEl.innerHTML = `<span>${count}</span> opening con audio disponibili`;

    const slider = _el('quizRoundsSlider');
    if (slider) {
      const canPlay = count >= MIN_POOL;
      const maxRounds = Math.min(count, 100);
      slider.min      = MIN_POOL;
      slider.max      = canPlay ? maxRounds : MIN_POOL;
      slider.step     = 1;
      slider.disabled = !canPlay;
      // aggiusta valore corrente se supera il nuovo max
      if (parseInt(slider.value) > maxRounds) slider.value = maxRounds;
      if (parseInt(slider.value) < MIN_POOL) slider.value = MIN_POOL;
      quizUpdateRounds(slider.value);

      // tick: solo 5 (sinistra) e il max effettivo (destra)
      const ticks = _el('quizRoundsTicks');
      if (ticks && canPlay) {
        ticks.innerHTML = `<span>${MIN_POOL}</span><span>${maxRounds}</span>`;
      }
    }

    const btn = _el('quizStartBtn');
    if (btn) {
      btn.disabled     = count < MIN_POOL;
      btn.style.opacity = count < MIN_POOL ? '0.4' : '1';
    }
  }

  // ── SUBCAT SECTION ────────────────────────────────────────────────────────────
  function _quizRenderSubcatSection() { quizPool.renderSubcatGrid(); }
  // ── SETUP ────────────────────────────────────────────────────────────────────
  window.quizUpdateRounds = function (val) {
    const n = parseInt(val);
    const display = _el('quizRoundsDisplay');
    if (!display) return;
    display.textContent = n;
    display.classList.remove('bump');
    void display.offsetWidth;
    display.classList.add('bump');
    setTimeout(() => display.classList.remove('bump'), 150);
  };

  window.quizSetAnswerMode = function (mode) {
    answerMode = mode;
    _el('quizModeMulti').classList.toggle('active', mode === 'multi');
    _el('quizModeFree').classList.toggle('active', mode === 'free');
  };

  window.quizSetDuration = function (ms) {
    quizClipMs = ms;
    document.querySelectorAll('.quiz-duration-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.ms) === ms);
    });
  };

  window.quizLaunch = function () {
    _quizEntries = quizPool.getPool();
    if (_quizEntries.length < MIN_POOL) {
      openModal('Audio insufficienti',
        `Servono almeno ${MIN_POOL} elementi con audio nel filtro selezionato.`,
        () => closeModal(), 'OK');
      return;
    }
    const slider = _el('quizRoundsSlider');
    const rounds = slider ? parseInt(slider.value) : 10;
    _buildQuestions(rounds);
    quizIndex = 0;
    quizScore = 0;
    showView('quizView');
    _renderQuestion();
  };

  // ── BUILD QUESTIONS ──────────────────────────────────────────────────────────
  function _buildQuestions(rounds) {
    const shuffled = shuffleArray(_quizEntries);
    const total    = Math.min(rounds, shuffled.length);
    quizQuestions  = [];

    // Teniamo traccia delle entry già usate come risposta corretta:
    // così non ricompaiono come distrattori nelle domande successive,
    // eliminando la sensazione di "sentire sempre gli stessi opening".
    const usedAsCorrect = new Set();

    for (let i = 0; i < total; i++) {
      const correct = shuffled[i];
      usedAsCorrect.add(correct);

      // Distrattori: escludi tutte le entry già usate come risposta corretta
      const distractorPool = _quizEntries.filter(e => !usedAsCorrect.has(e));

      // Fallback: se il pool ripulito non ha abbastanza distrattori
      // (es. pool molto piccolo), allarga a tutto tranne la corretta
      const source = distractorPool.length >= CHOICES - 1
        ? distractorPool
        : _quizEntries.filter(e => e !== correct);

      const others  = shuffleArray(source);
      const choices = shuffleArray([correct, ...others.slice(0, CHOICES - 1)]);
      quizQuestions.push({ correct, choices });
    }
  }

  // ── RENDER QUESTION ──────────────────────────────────────────────────────────
  function _renderQuestion() {
    _stopAudio();
    quizAnswered  = false;
    freeHighlight = -1;

    const q     = quizQuestions[quizIndex];
    const total = quizQuestions.length;

    _el('quizProgressFill').style.width  = (((quizIndex + 1) / total) * 100) + '%';
    _el('quizProgressText').textContent  = `${quizIndex + 1} / ${total}`;
    _el('quizScoreDisplay').textContent  = `${quizScore} / ${quizIndex}`;

    _el('quizFeedback').className   = 'quiz-feedback';
    _el('quizFeedback').textContent = '';
    _el('quizRevealImg').style.display = 'none';
    _el('quizRevealImg').src           = '';
    const ring = _el('quizAudioRing');
    if (ring) ring.classList.remove('imgs-visible');
    if (_el('quizChoicesImgs')) _el('quizChoicesImgs').replaceChildren();

    if (answerMode === 'multi') {
      _el('quizChoicesGrid').style.display = '';
      _el('quizFreeWrap').style.display    = 'none';
      _renderMultiChoices(q);
    } else {
      _el('quizChoicesGrid').style.display = 'none';
      _el('quizFreeWrap').style.display    = '';
      _renderFreeInput();
    }

    _playCurrentAudio();
  }

  function _renderMultiChoices(q) {
    const grid    = _el('quizChoicesGrid');
    const imgWrap = _el('quizChoicesImgs');
    grid.replaceChildren();
    if (imgWrap) { imgWrap.replaceChildren(); }

    q.choices.forEach((entry) => {
      // ── bottone testo ─────────────────────────────────────────
      const btn = document.createElement('button');
      btn.className   = 'quiz-choice-btn';
      btn.textContent = entry.name;
      btn.onclick     = () => _handleAnswer(entry, q.correct);
      grid.appendChild(btn);

      // ── cella immagine (pre-caricata, visibile solo dopo audio) ──
      if (!imgWrap) return;
      const cell = document.createElement('div');
      cell.className    = 'quiz-choice-img-cell';
      cell.dataset.name = entry.name;
      cell.onclick      = () => _handleAnswer(entry, q.correct);

      const src = imgSrc(entry);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = entry.name;
        cell.appendChild(img);
      } else {
        cell.style.background = 'var(--card)';
      }
      imgWrap.appendChild(cell);
    });
  }

  function _renderFreeInput() {
    const input = _el('quizFreeInput');
    input.value             = '';
    input.disabled          = false;
    input.style.borderColor = '';
    input.style.color       = '';
    _el('quizFreeSuggestions').replaceChildren();
    _el('quizFreeSubmit').disabled       = false;
    setTimeout(() => input.focus(), 80);
  }

  // ── FREE ANSWER ───────────────────────────────────────────────────────────────
  window.quizFreeSearch = function (val) {
    freeHighlight = -1;
    const sugg = _el('quizFreeSuggestions');
    sugg.replaceChildren();
    const q = val.trim().toLowerCase();
    if (!q) return;

    _quizEntries
      .filter(e => e.name.toLowerCase().includes(q))
      .slice(0, SUGGESTIONS_MAX)
      .forEach(entry => {
        const div = document.createElement('div');
        div.className   = 'quiz-free-suggestion';
        div.textContent = entry.name;
        div.onmousedown = (e) => {
          e.preventDefault();
          _el('quizFreeInput').value = entry.name;
          sugg.replaceChildren();
          window.quizFreeConfirm();
        };
        sugg.appendChild(div);
      });
  };

  window.quizFreeKeydown = function (e) {
    const sugg  = _el('quizFreeSuggestions');
    const items = sugg.querySelectorAll('.quiz-free-suggestion');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      freeHighlight = Math.min(freeHighlight + 1, items.length - 1);
      _updateFreeHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      freeHighlight = Math.max(freeHighlight - 1, -1);
      _updateFreeHighlight(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (freeHighlight >= 0 && items[freeHighlight]) {
        _el('quizFreeInput').value = items[freeHighlight].textContent;
        sugg.replaceChildren();
        freeHighlight  = -1;
      }
      window.quizFreeConfirm();
    } else if (e.key === 'Escape') {
      sugg.replaceChildren();
      freeHighlight  = -1;
    }
  };

  function _updateFreeHighlight(items) {
    items.forEach((el, i) => el.classList.toggle('highlighted', i === freeHighlight));
    if (freeHighlight >= 0) _el('quizFreeInput').value = items[freeHighlight].textContent;
  }

  window.quizFreeConfirm = function () {
    if (quizAnswered) return;
    const val = _el('quizFreeInput').value.trim();
    if (!val) return;
    const correct = quizQuestions[quizIndex].correct;
    const chosen  = _quizEntries.find(e => e.name.toLowerCase() === val.toLowerCase()) || { name: val };
    _handleAnswer(chosen, correct);
  };

  // ── AUDIO ─────────────────────────────────────────────────────────────────────
  // ── CIRCULAR EQUALIZER ────────────────────────────────────────────────────────
  let _audioCtx  = null;
  let _analyser  = null;
  let _freqData  = null;
  let _beatRaf   = null;
  const CORE_R      = 58;   // radius of the inner circle in canvas px
  const CANVAS_SIZE = 300;
  const BAR_COUNT   = 120;
  const MAX_BAR_H   = 70;
  // Only use bins 0..BIN_MAX — covers ~0 to 8kHz which is where music lives
  // fftSize=1024 → 512 bins, sampleRate≈44100 → bin width ≈ 86Hz
  // 8000Hz / 86Hz ≈ 93 bins — use first 100 to be safe
  const BIN_MAX     = 100;

  // Frequency-band color palette (bass → mid → treble)
  const BAR_COLORS = [
    [245, 200,  66],  // gold   — sub-bass
    [245, 140,  40],  // orange — bass
    [220,  80,  40],  // red-orange
    [180,  60, 180],  // purple — low-mid
    [ 90,  80, 220],  // blue   — mid
    [ 50, 180, 220],  // cyan   — upper-mid
    [ 60, 220, 140],  // teal   — presence
    [100, 220,  80],  // green  — high-mid
    [200, 220,  60],  // yellow-green — highs
  ];

  function _barColor(t, alpha) {
    const seg  = t * (BAR_COLORS.length - 1);
    const lo   = Math.floor(seg);
    const hi   = Math.min(lo + 1, BAR_COLORS.length - 1);
    const f    = seg - lo;
    const c0   = BAR_COLORS[lo], c1 = BAR_COLORS[hi];
    const r    = Math.round(c0[0] + (c1[0] - c0[0]) * f);
    const g    = Math.round(c0[1] + (c1[1] - c0[1]) * f);
    const b    = Math.round(c0[2] + (c1[2] - c0[2]) * f);
    return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
  }

  function _initAudioCtx() {
    if (_audioCtx) return;
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    _analyser = _audioCtx.createAnalyser();
    _analyser.fftSize = 1024;
    _analyser.smoothingTimeConstant = 0.82;
    _freqData = new Uint8Array(_analyser.frequencyBinCount);
    _analyser.connect(_audioCtx.destination);
  }

  function _connectAudioToAnalyser(audioEl) {
    if (!_audioCtx) return;
    try {
      const src = _audioCtx.createMediaElementSource(audioEl);
      src.connect(_analyser);
    } catch(e) {}
  }

  const _barSmooth  = new Float32Array(BAR_COUNT);
  const _barMax     = new Float32Array(BAR_COUNT).fill(0.01); // rolling max per bar
  const _barMaxDecay = 0.9995; // how fast the max decays (slowly)

  function _beatLoop() {
    _beatRaf = requestAnimationFrame(_beatLoop);
    const canvas = document.getElementById('quizBeatCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const cx = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    if (_analyser && _freqData) _analyser.getByteFrequencyData(_freqData);

    const totalBins = _freqData ? _freqData.length : 1;
    const angleStep = (Math.PI * 2) / BAR_COUNT;
    const barW = Math.max(1.8, (2 * Math.PI * CORE_R / BAR_COUNT) * 0.55);

    for (let i = 0; i < BAR_COUNT; i++) {
      const binIdx = Math.round(Math.pow(i / BAR_COUNT, 1.4) * (BIN_MAX - 1));
      const raw    = _freqData ? _freqData[Math.min(binIdx, totalBins - 1)] / 255 : 0;

      // Update rolling max with slow decay
      _barMax[i] = Math.max(_barMax[i] * _barMaxDecay, raw, 0.01);

      // Normalize: each bar is relative to its own historical peak
      const normalized = raw / _barMax[i];

      _barSmooth[i] += (normalized - _barSmooth[i]) * 0.22;
      const h = _barSmooth[i] * MAX_BAR_H;
      if (h < 0.8) continue;

      const angle = angleStep * i - Math.PI / 2;
      const cosA  = Math.cos(angle), sinA = Math.sin(angle);
      const x1 = cx + cosA * (CORE_R + 1);
      const y1 = cy + sinA * (CORE_R + 1);
      const x2 = cx + cosA * (CORE_R + 1 + h);
      const y2 = cy + sinA * (CORE_R + 1 + h);

      const t     = i / BAR_COUNT;
      const alpha = 0.55 + _barSmooth[i] * 0.45;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = _barColor(t, alpha);
      ctx.lineWidth   = barW;
      ctx.lineCap     = 'round';
      ctx.stroke();
    }
  }

  function _startBeatLoop() {
    _barSmooth.fill(0);
    _barMax.fill(0.01);
    if (!_beatRaf) _beatLoop();
  }

  function _stopBeatLoop() {
    if (_beatRaf) { cancelAnimationFrame(_beatRaf); _beatRaf = null; }
    _barSmooth.fill(0);
    const canvas = document.getElementById('quizBeatCanvas');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  function _playCurrentAudio() {
    _stopAudio();
    if (typeof stopCampPlaylist === 'function') stopCampPlaylist();
    const q   = quizQuestions[quizIndex];
    const src = audioSrc(q.correct);
    if (!src) return;

    const ring        = _el('quizAudioRing');
    const loadingWrap = _el('quizLoadingWrap');
    const clipWrap    = _el('quizClipBarWrap');

    // Loading state
    if (ring)        { ring.classList.remove('playing'); ring.classList.add('loading'); }
    if (loadingWrap)   loadingWrap.classList.add('active');
    if (clipWrap)      clipWrap.classList.remove('active');

    quizAudio = new Audio(src);
    quizAudio.volume  = quizVolume;
    quizAudio.preload = 'auto';
    quizAudio.crossOrigin = 'anonymous';

    // Init Web Audio on first interaction (needs user gesture — already happened)
    _initAudioCtx();
    if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
    _connectAudioToAnalyser(quizAudio);

    let playbackStarted = false;
    let audioStartTime  = 0;
    let seekDone        = false;

    // Seek a un punto casuale appena sappiamo la durata e il file è seekable
    quizAudio.addEventListener('loadedmetadata', () => {
      if (!quizAudio || seekDone) return;
      const clipSec  = quizClipMs / 1000;
      const totalSec = quizAudio.duration || 0;
      if (totalSec > clipSec) {
        const maxStart = totalSec - clipSec;
        quizAudio.currentTime = Math.random() * maxStart;
        seekDone = true;
      }
    });

    // Fallback: se loadedmetadata non ha potuto seekare, riprova a canplay
    quizAudio.addEventListener('canplay', () => {
      if (!quizAudio || seekDone) return;
      const clipSec  = quizClipMs / 1000;
      const totalSec = quizAudio.duration || 0;
      if (totalSec > clipSec) {
        const maxStart = totalSec - clipSec;
        quizAudio.currentTime = Math.random() * maxStart;
        seekDone = true;
      }
    });

    quizAudio.addEventListener('timeupdate', () => {
      if (!quizAudio) return;
      if (!playbackStarted) {
        playbackStarted = true;
        audioStartTime  = quizAudio.currentTime;
        if (ring)        { ring.classList.remove('loading'); ring.classList.add('playing'); }
        if (loadingWrap)   loadingWrap.classList.remove('active');
        if (clipWrap)      clipWrap.classList.add('active');
        quizClipTimer = setTimeout(() => _stopAudio(true), quizClipMs);
        _startBeatLoop();
      }
      const elapsed  = (quizAudio.currentTime - audioStartTime) * 1000;
      const pct      = Math.min(elapsed / quizClipMs * 100, 100);
      const elapsedS = Math.min(Math.floor(elapsed / 1000), Math.floor(quizClipMs / 1000));
      const totalS   = Math.floor(quizClipMs / 1000);
      const fill = _el('quizClipBarFill');
      const time = _el('quizClipTime');
      if (fill) fill.style.width = pct + '%';
      if (time) time.textContent = `${elapsedS} / ${totalS}s`;
    });

    quizAudio.addEventListener('ended', () => _stopAudio(true));
    quizAudio.addEventListener('error', () => _stopAudio(false));
    quizAudio.play().catch(() => {});
  }

  function _stopAudio(showImages) {
    clearTimeout(quizClipTimer);
    _stopBeatLoop();
    if (quizAudio) {
      quizAudio.pause();
      quizAudio.src = '';
      quizAudio.load();
      quizAudio = null;
    }
    const ring = _el('quizAudioRing');
    if (ring) { ring.classList.remove('playing'); ring.classList.remove('loading'); }
    const loadingWrap = _el('quizLoadingWrap');
    if (loadingWrap) loadingWrap.classList.remove('active');
    const fill = _el('quizClipBarFill');
    const time = _el('quizClipTime');
    const wrap = _el('quizClipBarWrap');
    if (fill) fill.style.width = '0%';
    if (time) time.textContent = `0 / ${Math.floor(quizClipMs / 1000)}s`;
    if (wrap) wrap.classList.remove('active');

    // Mostra le 4 immagini solo se esplicitamente richiesto (audio finito davvero)
    if (showImages && !quizAnswered && answerMode === 'multi') {
      _showChoiceImages();
    }
  }

  function _showChoiceImages() {
    const ring    = _el('quizAudioRing');
    const imgWrap = _el('quizChoicesImgs');
    if (!ring || !imgWrap || !imgWrap.children.length) return;
    ring.classList.add('imgs-visible');
  }

  function _hideChoiceImages() {
    const ring    = _el('quizAudioRing');
    const imgWrap = _el('quizChoicesImgs');
    if (ring)    ring.classList.remove('imgs-visible');
    if (imgWrap) imgWrap.replaceChildren();
  }

  // ── ANSWER HANDLING ───────────────────────────────────────────────────────────
  function _handleAnswer(chosen, correct) {
    if (quizAnswered) return;
    quizAnswered = true;
    _stopAudio();

    const isCorrect = chosen.name.toLowerCase() === correct.name.toLowerCase();
    if (isCorrect) quizScore++;

    if (answerMode === 'multi') {
      _el('quizChoicesGrid').querySelectorAll('.quiz-choice-btn').forEach(b => {
        b.disabled = true;
        if (b.textContent === correct.name)                   b.classList.add('correct');
        else if (b.textContent === chosen.name && !isCorrect) b.classList.add('wrong');
      });

      // fade out le immagini sbagliate, la corretta rimane un attimo poi lascia posto al reveal
      const imgWrap = _el('quizChoicesImgs');
      if (imgWrap) {
        imgWrap.querySelectorAll('.quiz-choice-img-cell').forEach(cell => {
          cell.style.pointerEvents = 'none';
          if (cell.dataset.name !== correct.name) {
            cell.classList.add('fade-out');
          }
        });
      }
    } else {
      const input = _el('quizFreeInput');
      input.disabled          = true;
      input.style.borderColor = isCorrect ? 'var(--success)' : 'var(--danger)';
      input.style.color       = isCorrect ? 'var(--success)' : 'var(--danger)';
      _el('quizFreeSubmit').disabled       = true;
      _el('quizFreeSuggestions').replaceChildren();
    }

    const scoreEl = _el('quizScoreDisplay');
    if (scoreEl) scoreEl.textContent = `${quizScore} / ${quizIndex + 1}`;

    const fb = _el('quizFeedback');
    fb.textContent = isCorrect ? '✓ Corretto!' : `✗ Era: ${correct.name}`;
    fb.className   = 'quiz-feedback ' + (isCorrect ? 'correct' : 'wrong');

    const revealSrc = imgSrc(correct);
    if (revealSrc) {
      const delay = answerMode === 'multi' ? 400 : 0;
      setTimeout(() => {
        _hideChoiceImages();
        _el('quizRevealImg').src           = revealSrc;
        _el('quizRevealImg').style.display = 'block';
      }, delay);
    } else {
      setTimeout(() => _hideChoiceImages(), 400);
    }

    clearTimeout(quizTimer);
    quizTimer = setTimeout(_nextQuestion, REVEAL_DELAY);
  }

  // ── NEXT / END ────────────────────────────────────────────────────────────────
  function _nextQuestion() {
    quizIndex++;
    if (quizIndex >= quizQuestions.length) {
      _showResults();
    } else {
      _renderQuestion();
    }
  }

  function _showResults() {
    _stopAudio();
    const total = quizQuestions.length;
    const pct   = Math.round((quizScore / total) * 100);

    _el('quizResultScore').textContent = `${quizScore} / ${total}`;
    _el('quizResultPct').textContent   = `${pct}%`;

    const list = _el('quizResultList');
    list.replaceChildren();
    quizQuestions.forEach(q => {
      const row   = document.createElement('div');
      row.className = 'quiz-result-row';
      const imgEl = document.createElement('img');
      imgEl.src   = imgSrc(q.correct);
      const name  = document.createElement('span');
      name.textContent = q.correct.name;
      row.appendChild(imgEl);
      row.appendChild(name);
      list.appendChild(row);
    });

    showView('quizResultView');
  }

  // ── PUBLIC ────────────────────────────────────────────────────────────────────
  window.setQuizVolume = function (val) {
    quizVolume = parseFloat(val);
    if (quizAudio) quizAudio.volume = quizVolume;
  };

  window.quizRestart = function () {
    _stopAudio();
    _quizBuildPool();
    _quizRenderSubcatSection();
    showView('quizSetupView');
  };

  window.quizGoHome = function () {
    _stopAudio();
    showView('homeView');
  };

  // ── UTILS ─────────────────────────────────────────────────────────────────────
  function _el(id) { return document.getElementById(id); }

})();
