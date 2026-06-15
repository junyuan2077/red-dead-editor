/* ==========================================================================
   RED DEAD EDITOR — Application Logic
   Vanilla JS · No dependencies · Production-ready

   Handles:
   - Dual-layer overlay synchronization (textarea + highlight marks)
   - API calls for evaluate, rewrite, hone, TTS
   - IndexedDB audio caching
   - LocalStorage journal persistence
   - Responsive sidebar drawers
   - Toast notifications
   - Keyboard shortcuts
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   1. CONSTANTS & CONFIGURATION
   -------------------------------------------------------------------------- */

const API_BASE      = '';                // Base URL for API calls (empty = same origin)
const DB_NAME       = 'rdo_audio_cache'; // IndexedDB database name
const DB_VERSION    = 1;
const STORE_NAME    = 'audio';           // Object store for cached audio blobs
const TOAST_DURATION = 3000;             // Toast auto-dismiss in milliseconds
const STORAGE_KEY   = 'rdo_entries';     // LocalStorage key for journal entries

/* --------------------------------------------------------------------------
   2. APPLICATION STATE
   Single source of truth for the entire UI state.
   -------------------------------------------------------------------------- */

const AppState = {
  currentText:           '',
  errors:                [],       // Array of {type, start, end, original, suggestion, explanation}
  history:               [],       // Loaded from localStorage
  isLoading:             false,
  activeOperation:       null,     // 'evaluate' | 'rewrite' | 'hone' | null
  selectedText:          '',
  selectedRange:         null,     // {start, end}
  historySidebarOpen:    false,
  correctionsSidebarOpen: false,
  currentEntryId:        null,
  overallScore:          null,
  summary:               '',
};

/* --------------------------------------------------------------------------
   3. DOM REFERENCES
   Cached on DOMContentLoaded for performance.
   -------------------------------------------------------------------------- */

const DOM = {};

function initDOMReferences() {
  // Editor
  DOM.textarea       = document.getElementById('editor-textarea');
  DOM.highlightLayer = document.getElementById('highlight-layer');
  DOM.loadingOverlay = document.getElementById('loading-overlay');

  // Counts
  DOM.wordCount      = document.getElementById('word-count');
  DOM.charCount      = document.getElementById('char-count');

  // Buttons
  DOM.btnEvaluate    = document.getElementById('btn-evaluate');
  DOM.btnRewrite     = document.getElementById('btn-rewrite');
  DOM.btnHone        = document.getElementById('btn-hone');
  DOM.btnSave        = document.getElementById('btn-save');
  DOM.btnNewEntry    = document.getElementById('btn-new-entry');

  // Sidebars
  DOM.historySidebar     = document.getElementById('history-sidebar');
  DOM.correctionsSidebar = document.getElementById('corrections-sidebar');
  DOM.historyToggle      = document.getElementById('history-toggle-btn');
  DOM.correctionsToggle  = document.getElementById('corrections-toggle-btn');
  DOM.sidebarBackdrop    = document.getElementById('sidebar-backdrop');

  // History
  DOM.historyList    = document.getElementById('history-list');

  // Corrections
  DOM.correctionsList = document.getElementById('corrections-list');
  DOM.scoreDisplay    = document.getElementById('score-display');
  DOM.summaryText     = document.getElementById('summary-text');

  // TTS
  DOM.ttsPlayBtn     = document.getElementById('tts-play-btn');
  DOM.ttsAudio       = document.getElementById('tts-audio');
  DOM.ttsProgress    = document.getElementById('tts-progress');

  // Toast
  DOM.toastContainer = document.getElementById('toast-container');
}

/* --------------------------------------------------------------------------
   4. OVERLAY SYNCHRONIZATION
   Keeps the highlight layer visually aligned with the textarea content.
   Both layers share identical font metrics so marks line up perfectly.
   -------------------------------------------------------------------------- */

/**
 * Copy the textarea's scroll position to the highlight layer
 * so error marks stay aligned as the user scrolls.
 */
function syncHighlightScroll() {
  if (!DOM.highlightLayer || !DOM.textarea) return;
  DOM.highlightLayer.scrollTop  = DOM.textarea.scrollTop;
  DOM.highlightLayer.scrollLeft = DOM.textarea.scrollLeft;
}

/**
 * Build the highlight layer HTML from the current text and error list.
 * Text is rendered as invisible (color: transparent in CSS),
 * with <mark> elements wrapping error spans to show colored underlines.
 *
 * @param {string} text   — The raw textarea content
 * @param {Array}  errors — Sorted array of error objects with {start, end, type}
 */
function renderHighlights(text, errors) {
  if (!DOM.highlightLayer) return;

  // No errors: mirror the plain text so scrolling still syncs
  if (!errors || errors.length === 0) {
    DOM.highlightLayer.innerHTML = escapeHTML(text) + '\n';
    return;
  }

  // Sort errors by start position (ascending), then by end position (desc for nesting)
  const sorted = [...errors].sort((a, b) => a.start - b.start || b.end - a.end);

  let html = '';
  let cursor = 0;

  for (let i = 0; i < sorted.length; i++) {
    const err = sorted[i];

    // Skip overlapping errors (simple non-overlapping strategy)
    if (err.start < cursor) continue;

    // Plain text before this error
    if (err.start > cursor) {
      html += escapeHTML(text.slice(cursor, err.start));
    }

    // The error-marked segment
    const errorText = text.slice(err.start, err.end);
    const typeClass = `mark-${err.type || 'grammar'}`;
    html += `<mark class="${typeClass}" data-error-index="${i}">${escapeHTML(errorText)}</mark>`;

    cursor = err.end;
  }

  // Remaining text after the last error
  if (cursor < text.length) {
    html += escapeHTML(text.slice(cursor));
  }

  // Trailing newline ensures the highlight layer matches textarea height
  DOM.highlightLayer.innerHTML = html + '\n';
}

/**
 * Escape HTML special characters to prevent XSS in the highlight layer.
 */
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* --------------------------------------------------------------------------
   5. API FUNCTIONS
   All return Promises; errors are thrown and caught by callers.
   -------------------------------------------------------------------------- */

/**
 * Send text for grammatical/stylistic evaluation.
 * Expected response: { score, summary, errors: [{type, start, end, original, suggestion, explanation}] }
 */
async function apiEvaluate(text) {
  const res = await fetch(`${API_BASE}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Evaluate failed: ${res.status}`);
  return res.json();
}

/**
 * Rewrite a selected sentence with surrounding context.
 * Expected response: { rewritten, explanation }
 */
async function apiRewrite(sentence, context) {
  const res = await fetch(`${API_BASE}/api/rewrite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentence, context }),
  });
  if (!res.ok) throw new Error(`Rewrite failed: ${res.status}`);
  return res.json();
}

/**
 * Polish/hone the entire text.
 * Expected response: { honed, improvements: [{original, improved, reason}] }
 */
async function apiHone(text) {
  const res = await fetch(`${API_BASE}/api/hone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Hone failed: ${res.status}`);
  return res.json();
}

/**
 * Request TTS audio for a given text.
 * Returns an audio Blob (e.g., MP3 or WAV).
 */
async function apiTTS(text) {
  const res = await fetch(`${API_BASE}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  return res.blob();
}

/* --------------------------------------------------------------------------
   6. INDEXEDDB AUDIO CACHE
   Caches TTS audio blobs locally to avoid redundant API calls.
   -------------------------------------------------------------------------- */

/**
 * Open (or create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openAudioDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Generate a simple hash string from text for use as a cache key.
 * Uses a fast FNV-1a inspired hash.
 */
function hashText(text) {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as unsigned 32-bit
  }
  return 'tts_' + hash.toString(36);
}

/**
 * Retrieve a cached audio blob from IndexedDB.
 * @returns {Promise<Blob|null>}
 */
async function getCachedAudio(text) {
  try {
    const db  = await openAudioDB();
    const key = hashText(text);
    return new Promise((resolve) => {
      const tx    = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req   = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror   = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Store an audio blob in IndexedDB.
 */
async function cacheAudio(text, blob) {
  try {
    const db  = await openAudioDB();
    const key = hashText(text);
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ key, blob, text, timestamp: Date.now() });
  } catch (err) {
    console.warn('Audio cache write failed:', err);
  }
}

/* --------------------------------------------------------------------------
   7. CORE OPERATIONS
   -------------------------------------------------------------------------- */

/**
 * EVALUATE — Analyze the current text for grammar, style, and spelling errors.
 */
async function evaluate() {
  const text = DOM.textarea.value.trim();
  if (!text) {
    showToast('Write something first, partner.', 'error');
    return;
  }

  setLoading('evaluate');

  try {
    const data = await apiEvaluate(text);

    // Store results in state
    AppState.errors       = data.errors || [];
    AppState.overallScore = data.score ?? null;
    AppState.summary      = data.summary || '';

    // Render highlights on the overlay
    renderHighlights(DOM.textarea.value, AppState.errors);

    // Render corrections sidebar
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);

    // Update score display
    updateScoreDisplay(AppState.overallScore);

    // On mobile, auto-open corrections sidebar
    if (window.innerWidth <= 1024) {
      openCorrectionsSidebar();
    }

    // Toast feedback
    if (AppState.overallScore !== null) {
      showToast(`Score: ${AppState.overallScore}/100 — ${AppState.errors.length} issue${AppState.errors.length !== 1 ? 's' : ''} found`, 'success');
    }
  } catch (err) {
    console.error('Evaluate error:', err);
    showToast('The scribes encountered an error. Try again.', 'error');
  } finally {
    setLoading(null);
  }
}

/**
 * REWRITE — Rewrite the selected sentence using AI, then play TTS.
 */
async function rewrite() {
  // Get selection from textarea
  const start = DOM.textarea.selectionStart;
  const end   = DOM.textarea.selectionEnd;
  const selectedText = DOM.textarea.value.substring(start, end).trim();

  if (!selectedText) {
    showToast('Select a sentence to rewrite, partner.', 'error');
    return;
  }

  const context = DOM.textarea.value;
  setLoading('rewrite');

  try {
    const data = await apiRewrite(selectedText, context);
    const rewritten = data.rewritten || selectedText;

    // Replace selected text in the textarea
    const before = DOM.textarea.value.substring(0, start);
    const after  = DOM.textarea.value.substring(end);
    DOM.textarea.value = before + rewritten + after;

    // Clear stale evaluation errors (text has changed)
    AppState.errors = [];
    renderHighlights(DOM.textarea.value, []);
    updateCounts();

    // Show the rewrite result in the corrections sidebar
    renderRewriteResult(selectedText, rewritten, data.explanation || '');

    // Play TTS for the rewritten sentence
    await playTTS(rewritten);

    showToast('Sentence rewritten successfully.', 'success');
  } catch (err) {
    console.error('Rewrite error:', err);
    showToast('Rewrite failed. Try again.', 'error');
  } finally {
    setLoading(null);
  }
}

/**
 * HONE — Polish the entire text.
 */
async function hone() {
  const text = DOM.textarea.value.trim();
  if (!text) {
    showToast('Write something first, partner.', 'error');
    return;
  }

  setLoading('hone');

  try {
    const data  = await apiHone(text);
    const honed = data.honed || text;

    DOM.textarea.value = honed;

    // Clear stale errors
    AppState.errors = [];
    renderHighlights(honed, []);
    updateCounts();

    // Show improvements
    renderHoneResults(data.improvements || []);

    // On mobile, show corrections
    if (window.innerWidth <= 1024) {
      openCorrectionsSidebar();
    }

    showToast('Your writing has been polished.', 'success');
  } catch (err) {
    console.error('Hone error:', err);
    showToast('Honing failed. Try again.', 'error');
  } finally {
    setLoading(null);
  }
}

/* --------------------------------------------------------------------------
   8. TTS PLAYBACK
   -------------------------------------------------------------------------- */

/**
 * Play TTS audio for the given text.
 * Checks IndexedDB cache first; falls back to API.
 */
async function playTTS(text) {
  if (!text) return;

  try {
    // Check cache first
    let blob = await getCachedAudio(text);

    if (!blob) {
      blob = await apiTTS(text);
      await cacheAudio(text, blob);
    }

    const url = URL.createObjectURL(blob);
    DOM.ttsAudio.src = url;
    DOM.ttsAudio.play();
    DOM.ttsPlayBtn.classList.add('playing');

    // Update progress bar as audio plays
    DOM.ttsAudio.ontimeupdate = () => {
      if (DOM.ttsAudio.duration) {
        const pct = (DOM.ttsAudio.currentTime / DOM.ttsAudio.duration) * 100;
        DOM.ttsProgress.style.width = `${pct}%`;
      }
    };

    // Cleanup when playback ends
    DOM.ttsAudio.onended = () => {
      DOM.ttsPlayBtn.classList.remove('playing');
      DOM.ttsProgress.style.width = '0%';
      URL.revokeObjectURL(url);
    };

    DOM.ttsAudio.onerror = () => {
      DOM.ttsPlayBtn.classList.remove('playing');
      DOM.ttsProgress.style.width = '0%';
      URL.revokeObjectURL(url);
    };
  } catch (err) {
    console.warn('TTS playback failed:', err);
  }
}

/**
 * Toggle play/pause on the TTS audio element.
 */
function toggleTTSPlayback() {
  if (!DOM.ttsAudio.src || DOM.ttsAudio.src === window.location.href) return;

  if (DOM.ttsAudio.paused) {
    DOM.ttsAudio.play();
    DOM.ttsPlayBtn.classList.add('playing');
  } else {
    DOM.ttsAudio.pause();
    DOM.ttsPlayBtn.classList.remove('playing');
  }
}

/* --------------------------------------------------------------------------
   9. LOCALSTORAGE PERSISTENCE
   Journal entries are stored as a JSON array under STORAGE_KEY.
   -------------------------------------------------------------------------- */

/**
 * Generate a unique ID based on timestamp + random suffix.
 */
function generateId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
}

/**
 * Retrieve all saved entries from localStorage.
 * @returns {Array}
 */
function getEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Save the current editor content as a journal entry.
 */
function saveEntry() {
  const text = DOM.textarea.value;
  if (!text.trim()) {
    showToast('Nothing to save — write something first.', 'error');
    return;
  }

  const entry = {
    id:        AppState.currentEntryId || generateId(),
    text:      text,
    title:     text.split('\n')[0].substring(0, 50) || 'Untitled',
    date:      new Date().toISOString(),
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };

  let entries = getEntries();
  const existingIndex = entries.findIndex((e) => e.id === entry.id);

  if (existingIndex >= 0) {
    entries[existingIndex] = entry;
  } else {
    entries.unshift(entry);
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  AppState.currentEntryId = entry.id;
  renderHistory();
  showToast('Entry saved to journal.', 'success');
}

/**
 * Load a saved entry into the editor.
 */
function loadEntry(id) {
  const entries = getEntries();
  const entry   = entries.find((e) => e.id === id);
  if (!entry) return;

  DOM.textarea.value      = entry.text || '';
  AppState.currentEntryId = entry.id;

  // Clear stale evaluation data
  AppState.errors = [];
  renderHighlights(entry.text || '', []);
  updateCounts();
  renderHistory(); // Update active state

  // Close sidebar on mobile
  closeSidebars();
}

/**
 * Delete a saved entry.
 */
function deleteEntry(id) {
  let entries = getEntries();
  entries = entries.filter((e) => e.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));

  // If we just deleted the active entry, start a new one
  if (AppState.currentEntryId === id) {
    newEntry();
  }

  renderHistory();
  showToast('Entry removed.', 'info');
}

/**
 * Start a fresh new entry.
 */
function newEntry() {
  DOM.textarea.value      = '';
  AppState.currentEntryId = null;
  AppState.errors         = [];
  AppState.overallScore   = null;
  AppState.summary        = '';

  renderHighlights('', []);
  updateCounts();
  updateScoreDisplay(null);
  clearCorrections();
  renderHistory();

  DOM.textarea.focus();
  closeSidebars();
}

/* --------------------------------------------------------------------------
   10. UI RENDERING FUNCTIONS
   -------------------------------------------------------------------------- */

/**
 * Render the history list from saved entries.
 */
function renderHistory() {
  const entries = getEntries();
  if (!DOM.historyList) return;

  if (entries.length === 0) {
    DOM.historyList.innerHTML = `
      <div class="history-empty" style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.85rem;font-style:italic;">
        No entries yet.<br>Start writing and save your work.
      </div>`;
    return;
  }

  DOM.historyList.innerHTML = entries
    .map((entry) => {
      const isActive = entry.id === AppState.currentEntryId;
      const dateStr  = formatDate(entry.date);
      const preview  = (entry.text || '').replace(/\n/g, ' ').substring(0, 80);

      return `
        <div class="history-item${isActive ? ' active' : ''}" data-id="${entry.id}">
          <div class="history-item-header">
            <span class="history-item-title">${escapeHTML(entry.title || 'Untitled')}</span>
            <button class="history-item-delete" data-delete-id="${entry.id}" aria-label="Delete entry" title="Delete">&times;</button>
          </div>
          <span class="history-item-date">${dateStr}</span>
          <p class="history-item-preview">${escapeHTML(preview)}</p>
        </div>`;
    })
    .join('');
}

/**
 * Render correction cards in the corrections sidebar.
 */
function renderCorrections(errors, score, summary) {
  if (!DOM.correctionsList) return;

  // Summary text
  if (DOM.summaryText) {
    DOM.summaryText.innerHTML = summary
      ? `<p>${escapeHTML(summary)}</p>`
      : `<p>No assessment available.</p>`;
  }

  if (!errors || errors.length === 0) {
    DOM.correctionsList.innerHTML = `
      <div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.88rem;font-style:italic;">
        ${score !== null ? 'No issues found — well done, partner!' : 'Evaluate your writing to see corrections here.'}
      </div>`;
    return;
  }

  DOM.correctionsList.innerHTML = errors
    .map((err, i) => {
      const typeName  = capitalize(err.type || 'grammar');
      const typeClass = `error-${err.type || 'grammar'}`;

      return `
        <div class="correction-card" data-error-index="${i}" style="animation-delay:${i * 0.05}s">
          <span class="error-badge ${typeClass}">${typeName}</span>
          <div class="correction-original"><del>${escapeHTML(err.original || '')}</del></div>
          <div class="correction-suggestion"><ins>${escapeHTML(err.suggestion || '')}</ins></div>
          <p class="correction-explanation">${escapeHTML(err.explanation || '')}</p>
          <button class="btn btn-apply-fix" data-fix-index="${i}">Apply Fix</button>
        </div>`;
    })
    .join('');
}

/**
 * Show rewrite result in the corrections sidebar.
 */
function renderRewriteResult(original, rewritten, explanation) {
  if (!DOM.correctionsList) return;

  if (DOM.summaryText) {
    DOM.summaryText.innerHTML = `<p><strong>Sentence Rewritten</strong></p>`;
  }

  DOM.correctionsList.innerHTML = `
    <div class="correction-card">
      <span class="error-badge error-style">Rewrite</span>
      <div class="correction-original"><del>${escapeHTML(original)}</del></div>
      <div class="correction-suggestion"><ins>${escapeHTML(rewritten)}</ins></div>
      <p class="correction-explanation">${escapeHTML(explanation)}</p>
    </div>`;
}

/**
 * Show hone improvements in the corrections sidebar.
 */
function renderHoneResults(improvements) {
  if (!DOM.correctionsList) return;

  if (DOM.summaryText) {
    DOM.summaryText.innerHTML = `<p><strong>Text polished</strong> — ${improvements.length} improvement${improvements.length !== 1 ? 's' : ''} made.</p>`;
  }

  // Reset score display for hone mode
  updateScoreDisplay(null);

  if (!improvements || improvements.length === 0) {
    DOM.correctionsList.innerHTML = `
      <div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.88rem;font-style:italic;">
        Your text has been polished.
      </div>`;
    return;
  }

  DOM.correctionsList.innerHTML = improvements
    .map((imp, i) => `
      <div class="correction-card" style="animation-delay:${i * 0.05}s">
        <span class="error-badge error-style">Improved</span>
        <div class="correction-original"><del>${escapeHTML(imp.original || '')}</del></div>
        <div class="correction-suggestion"><ins>${escapeHTML(imp.improved || '')}</ins></div>
        <p class="correction-explanation">${escapeHTML(imp.reason || '')}</p>
      </div>`)
    .join('');
}

/**
 * Clear the corrections sidebar to its default state.
 */
function clearCorrections() {
  if (DOM.summaryText) {
    DOM.summaryText.innerHTML = `<p>Write something and hit <strong>Evaluate</strong> to receive your assessment.</p>`;
  }
  if (DOM.correctionsList) {
    DOM.correctionsList.innerHTML = '';
  }
}

/**
 * Update the word and character count displays.
 */
function updateCounts() {
  const text  = DOM.textarea ? DOM.textarea.value : '';
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = text.length;

  if (DOM.wordCount) {
    DOM.wordCount.querySelector('.count-value').textContent = words;
  }
  if (DOM.charCount) {
    DOM.charCount.querySelector('.count-value').textContent = chars;
  }
}

/**
 * Update the circular score display.
 * @param {number|null} score — 0-100 or null to reset
 */
function updateScoreDisplay(score) {
  if (!DOM.scoreDisplay) return;

  const valueEl = DOM.scoreDisplay.querySelector('.score-value');
  const fillEl  = DOM.scoreDisplay.querySelector('.score-fill');

  // Remove existing score classes
  DOM.scoreDisplay.classList.remove('score-high', 'score-mid', 'score-low');

  if (score === null || score === undefined) {
    if (valueEl) valueEl.textContent = '—';
    if (fillEl)  fillEl.style.strokeDashoffset = '326.73';
    return;
  }

  // Clamp score
  const s = Math.max(0, Math.min(100, Math.round(score)));

  if (valueEl) valueEl.textContent = s;

  // Animate the ring: full circle = 326.73 (2πr where r=52)
  if (fillEl) {
    const offset = 326.73 - (326.73 * s) / 100;
    fillEl.style.strokeDashoffset = offset.toFixed(2);
  }

  // Color coding
  if (s >= 80)      DOM.scoreDisplay.classList.add('score-high');
  else if (s >= 60) DOM.scoreDisplay.classList.add('score-mid');
  else              DOM.scoreDisplay.classList.add('score-low');
}

/**
 * Apply a correction fix by replacing the error text in the textarea.
 */
function applyFix(errorIndex) {
  const err = AppState.errors[errorIndex];
  if (!err) return;

  const text   = DOM.textarea.value;
  const before = text.substring(0, err.start);
  const after  = text.substring(err.end);

  DOM.textarea.value = before + (err.suggestion || '') + after;

  // Adjust positions of remaining errors
  const lengthDiff = (err.suggestion || '').length - (err.end - err.start);
  AppState.errors.splice(errorIndex, 1);
  AppState.errors.forEach((e) => {
    if (e.start > err.start) {
      e.start += lengthDiff;
      e.end   += lengthDiff;
    }
  });

  // Re-render
  renderHighlights(DOM.textarea.value, AppState.errors);
  renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  updateCounts();

  showToast('Fix applied.', 'success');
}

/* --------------------------------------------------------------------------
   11. TOAST NOTIFICATIONS
   -------------------------------------------------------------------------- */

/**
 * Show a toast notification that auto-dismisses.
 * @param {string} message — The message to display
 * @param {'success'|'error'|'info'} type — Toast type for styling
 */
function showToast(message, type = 'info') {
  if (!DOM.toastContainer) return;

  const icons = {
    success: '✓',
    error:   '✗',
    info:    'ℹ',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ'}</span>
    <span>${escapeHTML(message)}</span>`;

  DOM.toastContainer.appendChild(toast);

  // Auto-dismiss
  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }, TOAST_DURATION);
}

/* --------------------------------------------------------------------------
   12. LOADING STATE
   -------------------------------------------------------------------------- */

/**
 * Show or hide the loading overlay and toggle button states.
 * @param {string|null} operation — Active operation name, or null to clear
 */
function setLoading(operation) {
  AppState.isLoading       = !!operation;
  AppState.activeOperation = operation;

  // Toggle loading overlay visibility
  if (DOM.loadingOverlay) {
    DOM.loadingOverlay.classList.toggle('visible', AppState.isLoading);
  }

  // Update loading text
  const loadingTextEl = DOM.loadingOverlay?.querySelector('.loading-text');
  if (loadingTextEl) {
    const messages = {
      evaluate: 'The scribes are reviewing...',
      rewrite:  'Rewriting your prose...',
      hone:     'Polishing your words...',
    };
    loadingTextEl.textContent = messages[operation] || 'The scribes are at work...';
  }

  // Disable/enable all action buttons
  const buttons = [DOM.btnEvaluate, DOM.btnRewrite, DOM.btnHone, DOM.btnSave];
  buttons.forEach((btn) => {
    if (btn) btn.disabled = AppState.isLoading;
  });

  // Add loading class to the active button
  buttons.forEach((btn) => {
    if (btn) btn.classList.remove('btn--loading');
  });

  if (operation && DOM[`btn${capitalize(operation)}`]) {
    // Map operation to button: 'evaluate' -> DOM.btnEvaluate, etc.
  }
  // Simple approach: add loading class based on operation name
  if (operation === 'evaluate' && DOM.btnEvaluate) DOM.btnEvaluate.classList.add('btn--loading');
  if (operation === 'rewrite'  && DOM.btnRewrite)  DOM.btnRewrite.classList.add('btn--loading');
  if (operation === 'hone'     && DOM.btnHone)     DOM.btnHone.classList.add('btn--loading');
}

/* --------------------------------------------------------------------------
   13. SIDEBAR MANAGEMENT (Mobile Drawers)
   -------------------------------------------------------------------------- */

function toggleHistorySidebar() {
  AppState.historySidebarOpen = !AppState.historySidebarOpen;

  // Close other sidebar first
  if (AppState.historySidebarOpen && AppState.correctionsSidebarOpen) {
    AppState.correctionsSidebarOpen = false;
    DOM.correctionsSidebar?.classList.remove('open');
  }

  DOM.historySidebar?.classList.toggle('open', AppState.historySidebarOpen);
  updateBackdrop();
}

function toggleCorrectionsSidebar() {
  AppState.correctionsSidebarOpen = !AppState.correctionsSidebarOpen;

  // Close other sidebar first
  if (AppState.correctionsSidebarOpen && AppState.historySidebarOpen) {
    AppState.historySidebarOpen = false;
    DOM.historySidebar?.classList.remove('open');
  }

  DOM.correctionsSidebar?.classList.toggle('open', AppState.correctionsSidebarOpen);
  updateBackdrop();
}

function openCorrectionsSidebar() {
  AppState.correctionsSidebarOpen = true;
  DOM.correctionsSidebar?.classList.add('open');
  updateBackdrop();
}

function closeSidebars() {
  AppState.historySidebarOpen     = false;
  AppState.correctionsSidebarOpen = false;
  DOM.historySidebar?.classList.remove('open');
  DOM.correctionsSidebar?.classList.remove('open');
  updateBackdrop();
}

function updateBackdrop() {
  const anyOpen = AppState.historySidebarOpen || AppState.correctionsSidebarOpen;
  DOM.sidebarBackdrop?.classList.toggle('visible', anyOpen);
}

/* --------------------------------------------------------------------------
   14. UTILITY FUNCTIONS
   -------------------------------------------------------------------------- */

/**
 * Capitalize the first letter of a string.
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format an ISO date string for display.
 * e.g., "Jun 15, 1899 · 3:42 PM"
 */
function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day:   'numeric',
      year:  'numeric',
    }) + ' · ' + d.toLocaleTimeString('en-US', {
      hour:   'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'Unknown date';
  }
}

/* --------------------------------------------------------------------------
   15. EVENT LISTENERS
   -------------------------------------------------------------------------- */

function setupEventListeners() {
  // --- Textarea events ---
  DOM.textarea?.addEventListener('input', () => {
    updateCounts();
    // Re-render highlights with current errors (keeps marks in sync with edits)
    renderHighlights(DOM.textarea.value, AppState.errors);
    syncHighlightScroll();
  });

  DOM.textarea?.addEventListener('scroll', () => {
    syncHighlightScroll();
  });

  // Track text selection for the Rewrite feature
  DOM.textarea?.addEventListener('mouseup', trackSelection);
  DOM.textarea?.addEventListener('keyup', trackSelection);

  // --- Action buttons ---
  DOM.btnEvaluate?.addEventListener('click', evaluate);
  DOM.btnRewrite?.addEventListener('click', rewrite);
  DOM.btnHone?.addEventListener('click', hone);
  DOM.btnSave?.addEventListener('click', saveEntry);
  DOM.btnNewEntry?.addEventListener('click', newEntry);

  // --- Sidebar toggles ---
  DOM.historyToggle?.addEventListener('click', toggleHistorySidebar);
  DOM.correctionsToggle?.addEventListener('click', toggleCorrectionsSidebar);

  // --- Backdrop click closes sidebars ---
  DOM.sidebarBackdrop?.addEventListener('click', closeSidebars);

  // --- Delegated click: History items (load & delete) ---
  DOM.historyList?.addEventListener('click', (e) => {
    // Delete button
    const deleteBtn = e.target.closest('[data-delete-id]');
    if (deleteBtn) {
      e.stopPropagation();
      deleteEntry(deleteBtn.dataset.deleteId);
      return;
    }

    // Load entry
    const item = e.target.closest('.history-item');
    if (item && item.dataset.id) {
      loadEntry(item.dataset.id);
    }
  });

  // --- Delegated click: Apply Fix in correction cards ---
  DOM.correctionsList?.addEventListener('click', (e) => {
    const fixBtn = e.target.closest('[data-fix-index]');
    if (fixBtn) {
      applyFix(parseInt(fixBtn.dataset.fixIndex, 10));
    }
  });

  // --- Delegated hover: highlight corresponding target mark ---
  DOM.correctionsList?.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.correction-card');
    if (card) {
      const index = card.getAttribute('data-error-index');
      if (index !== null) {
        const mark = DOM.highlightLayer?.querySelector(`mark[data-error-index="${index}"]`);
        if (mark) {
          mark.classList.add('mark-hover');
        }
      }
    }
  });

  DOM.correctionsList?.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.correction-card');
    if (card) {
      const index = card.getAttribute('data-error-index');
      if (index !== null) {
        const mark = DOM.highlightLayer?.querySelector(`mark[data-error-index="${index}"]`);
        if (mark) {
          mark.classList.remove('mark-hover');
        }
      }
    }
  });

  // --- TTS play/pause ---
  DOM.ttsPlayBtn?.addEventListener('click', toggleTTSPlayback);

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    // Ctrl+S / Cmd+S — Save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveEntry();
    }

    // Ctrl+E / Cmd+E — Evaluate
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
      e.preventDefault();
      evaluate();
    }

    // Escape — Close sidebars
    if (e.key === 'Escape') {
      closeSidebars();
    }
  });

  // --- Window resize: re-sync highlight layer ---
  window.addEventListener('resize', () => {
    syncHighlightScroll();
  });
}

/**
 * Track the user's text selection in the textarea for the Rewrite feature.
 */
function trackSelection() {
  if (!DOM.textarea) return;

  const start = DOM.textarea.selectionStart;
  const end   = DOM.textarea.selectionEnd;

  if (start !== end) {
    AppState.selectedText  = DOM.textarea.value.substring(start, end);
    AppState.selectedRange = { start, end };
  } else {
    AppState.selectedText  = '';
    AppState.selectedRange = null;
  }
}

/* --------------------------------------------------------------------------
   16. INITIALIZATION
   -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  // Cache all DOM references
  initDOMReferences();

  // Render saved history
  renderHistory();

  // Update counts (empty state)
  updateCounts();

  // Load the most recent entry if one exists
  const entries = getEntries();
  if (entries.length > 0) {
    loadEntry(entries[0].id);
  }

  // Wire up all event listeners
  setupEventListeners();

  // Initial highlight sync
  syncHighlightScroll();

  console.log(
    '%c🤠 Red Dead Editor loaded. Write well, partner.',
    'color: #c7a44a; font-family: Georgia, serif; font-size: 14px;'
  );
});
