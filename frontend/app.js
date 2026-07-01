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

const TOAST_DURATION = 3000;             // Toast auto-dismiss in milliseconds
const STORAGE_KEY   = 'rdo_entries';     // LocalStorage key for journal entries

/* --------------------------------------------------------------------------
   2. APPLICATION STATE
   Single source of truth for the entire UI state.
   -------------------------------------------------------------------------- */

const AppState = {
  currentText:           '',
  errors:                [],       // Array of {type, start, end, original, suggestion, explanation}
  appliedFixes:          [],       // Array of {start, end, original, suggestion, originalError}
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
  lastRestoredError:     null,
  inRewriteMode:         false,
  rewriteSentences:      [],
  rewriteOriginalText:   null,
  activeRewriteIndex:    null,
  honedText:             null,
  honeImprovements:      [],
  inHoneMode:            false,
  evaluatedOnce:         false,
  rewrittenOnce:         false,
  honedOnce:             false,
  textBeforeHone:         null,
  errorsBeforeHone:       [],
  appliedFixesBeforeHone: [],
  overallScoreBeforeHone: null,
  summaryBeforeHone:      '',
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
  DOM.journalContainer = document.querySelector('.journal-container');
  DOM.rewriteBanner    = document.getElementById('rewrite-banner');

  // Counts
  DOM.wordCount      = document.getElementById('word-count');
  DOM.charCount      = document.getElementById('char-count');

  // Buttons
  DOM.btnEvaluate    = document.getElementById('btn-evaluate');
  DOM.btnRewrite     = document.getElementById('btn-rewrite');
  DOM.btnHone        = document.getElementById('btn-hone');
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
  DOM.summaryText     = document.getElementById('summary-text');



  // Toast
  DOM.toastContainer = document.getElementById('toast-container');

  // Mary-Beth avatar
  DOM.maryBethAvatar = document.getElementById('marybeth-avatar');
  DOM.maryBethSprite = document.getElementById('marybeth-sprite');
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
function renderHighlights(text, errors, appliedFixes = []) {
  if (!DOM.highlightLayer) return;
  removeMobilePopover();

  if (AppState.inRewriteMode) {
    renderInterleavedRewrite(text, errors, appliedFixes);
    return;
  }

  const combined = [];
  if (errors) {
    errors.forEach((err, idx) => {
      combined.push({
        start: err.start,
        end: err.end,
        type: 'error',
        errorType: err.type || 'grammar',
        index: idx
      });
    });
  }
  if (appliedFixes) {
    appliedFixes.forEach((fix, idx) => {
      combined.push({
        start: fix.start,
        end: fix.end,
        type: 'fix',
        index: idx
      });
    });
  }

  if (combined.length === 0) {
    DOM.highlightLayer.innerHTML = escapeHTML(text) + '\n';
    return;
  }

  // Sort by start position (ascending), then by end position (descending for nesting)
  combined.sort((a, b) => a.start - b.start || b.end - a.end);

  let html = '';
  let cursor = 0;

  for (let i = 0; i < combined.length; i++) {
    const item = combined[i];

    // Skip overlapping highlights
    if (item.start < cursor) continue;

    // Plain text before this highlight
    if (item.start > cursor) {
      html += escapeHTML(text.slice(cursor, item.start));
    }

    const itemText = text.slice(item.start, item.end);
    if (item.type === 'error') {
      const typeClass = `mark-${(item.errorType || 'grammar').toLowerCase()}`;
      html += `<mark class="${typeClass}" data-error-index="${item.index}">${escapeHTML(itemText)}</mark>`;
    } else if (item.type === 'fix') {
      html += `<mark class="mark-applied-fix" data-fix-index="${item.index}" title="Click to undo correction">${escapeHTML(itemText)}</mark>`;
    }

    cursor = item.end;
  }

  // Remaining text after the last highlight
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

/**
 * Render a specific substring of text with error highlights.
 */
function renderSubstringWithHighlights(text, startOffset, endOffset, errors, appliedFixes) {
  const subtext = text.substring(startOffset, endOffset);
  
  const combined = [];
  if (errors) {
    errors.forEach((err, idx) => {
      if (err.start >= startOffset && err.end <= endOffset) {
        combined.push({
          start: err.start - startOffset,
          end: err.end - startOffset,
          type: 'error',
          errorType: err.type || 'grammar',
          index: idx
        });
      }
    });
  }
  if (appliedFixes) {
    appliedFixes.forEach((fix, idx) => {
      if (fix.start >= startOffset && fix.end <= endOffset) {
        combined.push({
          start: fix.start - startOffset,
          end: fix.end - startOffset,
          type: 'fix',
          index: idx
        });
      }
    });
  }

  if (combined.length === 0) {
    return escapeHTML(subtext);
  }

  combined.sort((a, b) => a.start - b.start || b.end - a.end);

  let html = '';
  let cursor = 0;

  for (let i = 0; i < combined.length; i++) {
    const item = combined[i];
    if (item.start < cursor) continue;

    if (item.start > cursor) {
      html += escapeHTML(subtext.slice(cursor, item.start));
    }

    const itemText = subtext.slice(item.start, item.end);
    if (item.type === 'error') {
      const typeClass = `mark-${(item.errorType || 'grammar').toLowerCase()}`;
      html += `<mark class="${typeClass}" data-error-index="${item.index}">${escapeHTML(itemText)}</mark>`;
    } else if (item.type === 'fix') {
      html += `<mark class="mark-applied-fix" data-fix-index="${item.index}" title="Click to undo correction">${escapeHTML(itemText)}</mark>`;
    }

    cursor = item.end;
  }

  if (cursor < subtext.length) {
    html += escapeHTML(subtext.slice(cursor));
  }

  return html;
}

/**
 * Render the full-text interleaved original and rewritten sentences.
 */
function renderInterleavedRewrite(text, errors, appliedFixes) {
  // Use the original text that rewrite offsets were computed against,
  // falling back to the passed-in text if not available.
  const displayText = AppState.rewriteOriginalText || text;
  let cursor = 0;
  let html = '';
  
  for (let i = 0; i < AppState.rewriteSentences.length; i++) {
    const item = AppState.rewriteSentences[i];
    
    let itemStart;
    let itemEnd;
    
    if (typeof item.start === 'number' && typeof item.end === 'number') {
      itemStart = item.start;
      itemEnd = item.end;
    } else {
      let originalText = item.original;
      itemStart = displayText.indexOf(originalText, cursor);
      let matchedLength = originalText.length;
      
      if (itemStart === -1) {
        const prefix = originalText.trim().substring(0, 30);
        const tempIndex = displayText.indexOf(prefix, cursor);
        if (tempIndex !== -1) {
          itemStart = tempIndex;
          matchedLength = Math.min(originalText.length, displayText.length - itemStart);
        }
      }
      
      if (itemStart === -1) {
        continue;
      }
      
      itemEnd = itemStart + matchedLength;
      item.start = itemStart;
      item.end = itemEnd;
    }
    
    if (itemStart > cursor) {
      const sepText = displayText.substring(cursor, itemStart);
      // Only render separator if it's not at the very beginning of the document, or if it contains non-whitespace content at the beginning
      if ((cursor > 0 && (sepText.trim() || sepText.includes('\n'))) || (cursor === 0 && sepText.trim())) {
        html += `<div class="interleaved-separator">${escapeHTML(sepText)}</div>`;
      }
    }
    
    const originalHtml = renderSubstringWithHighlights(displayText, itemStart, itemEnd, errors, appliedFixes);
    
    const isActive = (i === AppState.activeRewriteIndex);
    html += `
      <div class="interleaved-block${isActive ? ' active-block' : ''}" data-index="${i}">
        <div class="interleaved-original">${originalHtml}</div>
        <div class="interleaved-rewritten" tabindex="0">${escapeHTML(item.rewritten)}</div>
      </div>`;
      
    cursor = itemEnd;
  }
  
  if (cursor < displayText.length) {
    const sepText = displayText.substring(cursor);
    if (sepText.trim() || sepText.includes('\n')) {
      html += `<div class="interleaved-separator">${escapeHTML(sepText)}</div>`;
    }
  }

  DOM.highlightLayer.innerHTML = html + '\n';

  // Restore focus/active state after re-render if activeRewriteIndex is set
  if (AppState.activeRewriteIndex !== null && AppState.activeRewriteIndex !== undefined) {
    const activeBlock = DOM.highlightLayer.querySelector(`.interleaved-block[data-index="${AppState.activeRewriteIndex}"]`);
    if (activeBlock) {
      const rewrittenEl = activeBlock.querySelector('.interleaved-rewritten');
      if (rewrittenEl && document.activeElement !== rewrittenEl) {
        rewrittenEl.focus();
      }
    }
  }
}

/**
 * Activate a rewritten sentence block, highlighting it and rendering its explanation in the sidebar.
 * @param {number} idx - The index of the block to activate
 * @param {boolean} focusRewritten - If true, programmatically focus the .interleaved-rewritten element
 */
function activateRewriteBlock(idx, focusRewritten = false) {
  if (!AppState.inRewriteMode || !AppState.rewriteSentences) return;
  const sentence = AppState.rewriteSentences[idx];
  if (!sentence) return;

  AppState.activeRewriteIndex = idx;

  const blocks = DOM.highlightLayer.querySelectorAll('.interleaved-block');
  blocks.forEach((b) => {
    const bIdx = parseInt(b.getAttribute('data-index'), 10);
    if (bIdx === idx) {
      b.classList.add('active-block');
      if (focusRewritten) {
        const rewrittenEl = b.querySelector('.interleaved-rewritten');
        if (rewrittenEl && document.activeElement !== rewrittenEl) {
          rewrittenEl.focus();
        }
      }
    } else {
      b.classList.remove('active-block');
    }
  });

  renderRewriteResult(sentence.original, sentence.rewritten, sentence.explanation);
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



/* --------------------------------------------------------------------------
   7. CORE OPERATIONS
   -------------------------------------------------------------------------- */

/**
 * EVALUATE — Analyze the current text for grammar, style, and spelling errors.
 */
async function evaluate(force = false) {
  const isSwitchingBack = (AppState.inRewriteMode || AppState.inHoneMode);

  if (AppState.inRewriteMode) {
    exitRewriteMode();
  }
  if (AppState.inHoneMode) {
    exitHoneMode(true);
  }

  if (!force && isSwitchingBack) {
    return;
  }

  // If not forcing, and we already have evaluation results for this text, just restore them and return!
  if (!force && (AppState.overallScore !== null || (AppState.errors && AppState.errors.length > 0))) {
    renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
    return;
  }

  // Prevent re-triggering via standard click if already evaluated once
  if (!force && AppState.evaluatedOnce) {
    showToast('Hold Evaluate button to re-evaluate, partner.', 'warning');
    return;
  }

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
    AppState.appliedFixes = []; // Reset applied fixes on fresh evaluation
    AppState.overallScore = data.score ?? null;
    AppState.summary      = data.summary || '';
    AppState.evaluatedOnce = true;

    // Clear rewrite/hone cache since we have a fresh evaluation
    AppState.rewriteSentences = [];
    AppState.honedText = null;
    AppState.honeImprovements = [];

    // Render highlights on the overlay
    renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);

    // Render corrections sidebar
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary, true);

    // Toast feedback
    if (AppState.overallScore !== null) {
      showToast(`Score: ${AppState.overallScore}/100 — ${AppState.errors.length} issue${AppState.errors.length !== 1 ? 's' : ''} found`, 'success');
    }
    saveActiveSession();
  } catch (err) {
    console.error('Evaluate error:', err);
    showToast('The scribes encountered an error. Try again.', 'error');
  } finally {
    setLoading(null);
  }
}

async function rewrite(force = false) {
  // If clicking Rewrite while in Hone view:
  if (AppState.inHoneMode) {
    exitHoneMode(true);
    await rewrite(false);
    return;
  }

  // Toggle: if already in rewrite mode, exit back to editor
  if (AppState.inRewriteMode && !force) {
    if (AppState.rewrittenOnce || AppState.honedOnce) {
      // Rule 1: No action is taken; the interface remains unchanged.
      return;
    }
    exitRewriteMode();
    return;
  }

  // If not in rewrite mode, but we have existing rewriteSentences, and we are not forcing, just enter rewrite mode!
  if (!force && AppState.rewriteSentences && AppState.rewriteSentences.length > 0) {
    if (AppState.inHoneMode) {
      exitHoneMode(false);
    }
    enterRewriteMode(AppState.rewriteSentences);
    return;
  }

  // Prevent re-triggering via standard click if already rewritten once
  if (!force && AppState.rewrittenOnce) {
    showToast('Hold Rewrite button to re-generate, partner.', 'warning');
    return;
  }

  const text = DOM.textarea.value.trim();

  if (!text) {
    showToast('Write some text first, partner.', 'error');
    return;
  }

  setLoading('rewrite');

  try {
    const data = await apiRewrite(text, "");
    
    if (data.sentences && data.sentences.length > 0) {
      AppState.rewrittenOnce = true;
      if (AppState.inHoneMode) {
        exitHoneMode(false);
      }
      enterRewriteMode(data.sentences);
      showToast('Article rewritten successfully.', 'success');
    } else {
      showToast('No sentences rewritten.', 'info');
    }
  } catch (err) {
    console.error('Rewrite error:', err);
    showToast('Rewrite failed. Try again.', 'error');
  } finally {
    setLoading(null);
  }
}

/**
 * Enter the interleaved rewrite comparison view mode.
 */
function enterRewriteMode(sentences) {
  AppState.inRewriteMode = true;
  AppState.rewriteSentences = sentences;
  // Capture the original text that rewrite offsets are computed against
  if (!AppState.rewriteOriginalText) {
    AppState.rewriteOriginalText = DOM.textarea.value;
  }
  if (DOM.highlightLayer) {
    DOM.highlightLayer.removeAttribute('aria-hidden');
  }

  // Show the rewrite banner
  if (DOM.rewriteBanner) {
    DOM.rewriteBanner.style.display = 'flex';
  }

  // Toggle class on container
  DOM.journalContainer?.classList.add('view-rewrite');

  AppState.activeRewriteIndex = null;

  // Re-render highlights (which will trigger interleaved view)
  renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);

  // Clear corrections sidebar and show placeholder instructions
  if (DOM.summaryText) {
    DOM.summaryText.innerHTML = `<p><strong>Full-Text Rewrite Comparison</strong></p>`;
  }
  if (DOM.correctionsList) {
    DOM.correctionsList.innerHTML = `
      <div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.88rem;font-style:italic;">
        Interact with a rewritten sentence to view its explanation here.
      </div>`;
  }

  // Update button states
  updateButtonStates();
  saveActiveSession();
  autoSaveEntry();
}

/**
 * Exit the rewrite view mode and return to standard editor.
 */
function exitRewriteMode() {
  AppState.inRewriteMode = false;
  AppState.activeRewriteIndex = null;
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudioElement) {
      currentAudioElement.classList.remove('audio-playing', 'audio-loading');
    }
    currentAudio = null;
    currentAudioElement = null;
  }
  if (DOM.highlightLayer) {
    DOM.highlightLayer.setAttribute('aria-hidden', 'true');
  }

  // Hide the rewrite banner
  if (DOM.rewriteBanner) {
    DOM.rewriteBanner.style.display = 'none';
  }

  // Toggle class on container
  DOM.journalContainer?.classList.remove('view-rewrite');

  // Re-render standard highlights and corrections
  renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
  renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);

  // Focus textarea
  DOM.textarea?.focus();

  // Update button states
  updateButtonStates();
  saveActiveSession();
}

/**
 * HONE — Polish the entire text.
 */
async function hone(force = false) {
  // If clicking Hone while in Rewrite view:
  if (AppState.inRewriteMode) {
    exitRewriteMode();
    await hone(false);
    return;
  }

  // Toggle: if already in hone mode, exit back to standard editor view
  if (AppState.inHoneMode && !force) {
    if (AppState.rewrittenOnce || AppState.honedOnce) {
      // Rule 1: No action is taken; the interface remains unchanged.
      return;
    }
    exitHoneMode(true);
    return;
  }

  // If not in hone mode, but we have cached honed results, and we are not forcing, display them!
  if (!force && AppState.honedText) {
    AppState.inHoneMode = true;
    if (DOM.textarea) DOM.textarea.readOnly = true;
    if (AppState.inRewriteMode) {
      exitRewriteMode();
    }
    AppState.textBeforeHone = DOM.textarea.value;
    AppState.errorsBeforeHone = [...AppState.errors];
    AppState.appliedFixesBeforeHone = [...AppState.appliedFixes];
    AppState.overallScoreBeforeHone = AppState.overallScore;
    AppState.summaryBeforeHone = AppState.summary;

    DOM.textarea.value = AppState.honedText;
    renderHighlights(AppState.honedText, [], []);
    renderHoneResults(AppState.honeImprovements || []);
    updateCounts();
    updateButtonStates();
    saveActiveSession();
    return;
  }

  // Prevent re-triggering via standard click if already honed once
  if (!force && AppState.honedOnce) {
    showToast('Hold Hone button to re-generate, partner.', 'warning');
    return;
  }

  const text = DOM.textarea.value.trim();
  if (!text) {
    showToast('Write something first, partner.', 'error');
    return;
  }

  setLoading('hone');

  try {
    const data  = await apiHone(text);
    const honed = data.honed || text;

    AppState.textBeforeHone = DOM.textarea.value;
    AppState.errorsBeforeHone = [...AppState.errors];
    AppState.appliedFixesBeforeHone = [...AppState.appliedFixes];
    AppState.overallScoreBeforeHone = AppState.overallScore;
    AppState.summaryBeforeHone = AppState.summary;

    AppState.honedText = honed;
    AppState.honeImprovements = data.improvements || [];
    AppState.inHoneMode = true;
    if (DOM.textarea) DOM.textarea.readOnly = true;
    AppState.honedOnce = true;

    if (AppState.inRewriteMode) {
      AppState.inRewriteMode = false;
      AppState.activeRewriteIndex = null;
      if (DOM.highlightLayer) {
        DOM.highlightLayer.setAttribute('aria-hidden', 'true');
      }
      if (DOM.rewriteBanner) {
        DOM.rewriteBanner.style.display = 'none';
      }
      DOM.journalContainer?.classList.remove('view-rewrite');
    }

    DOM.textarea.value = honed;

    // Clear stale errors
    AppState.errors = [];
    AppState.appliedFixes = [];
    renderHighlights(honed, [], []);
    updateCounts();

    // Show improvements
    renderHoneResults(AppState.honeImprovements);

    showToast('Your writing has been polished.', 'success');
    saveActiveSession();
    autoSaveEntry();
  } catch (err) {
    console.error('Hone error:', err);
    showToast('Honing failed. Try again.', 'error');
  } finally {
    setLoading(null);
  }
}

/**
 * Exit the hone view mode.
 * @param {boolean} restoreText - If true, restores the editor text and evaluate state to what they were before honing
 */
function exitHoneMode(restoreText = false) {
  AppState.inHoneMode = false;
  if (DOM.textarea) DOM.textarea.readOnly = false;

  if (restoreText && AppState.textBeforeHone !== null && AppState.textBeforeHone !== undefined) {
    DOM.textarea.value = AppState.textBeforeHone;
    AppState.errors = AppState.errorsBeforeHone || [];
    AppState.appliedFixes = AppState.appliedFixesBeforeHone || [];
    AppState.overallScore = AppState.overallScoreBeforeHone;
    AppState.summary = AppState.summaryBeforeHone || '';
  }

  // Clear backups
  AppState.textBeforeHone = null;
  AppState.errorsBeforeHone = [];
  AppState.appliedFixesBeforeHone = [];
  AppState.overallScoreBeforeHone = null;
  AppState.summaryBeforeHone = '';

  clearCorrections();
  renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
  renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  updateButtonStates();
  saveActiveSession();
}

/* --------------------------------------------------------------------------
   8. TTS PLAYBACK
   -------------------------------------------------------------------------- */

class AudioCache {
  constructor(dbName = 'rdo_audio_cache', storeName = 'audio') {
    this._map = new Map();           // Fast synchronous mirror
    this._dbName = dbName;
    this._storeName = storeName;
    this._db = null;
    this._ready = this._open();      // Resolves once DB is open and memory is seeded
  }

  /** Open (or create) the IndexedDB database and seed the in-memory map. */
  async _open() {
    return new Promise((resolve) => {
      const req = indexedDB.open(this._dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(this._storeName);
      };
      req.onsuccess = () => {
        this._db = req.result;
        this._seed().then(resolve).catch(resolve); // resolve even if seed fails
      };
      req.onerror = () => {
        console.warn('[AudioCache] IndexedDB open failed, falling back to memory-only.');
        resolve();
      };
    });
  }

  /** Load all existing entries from IndexedDB into the in-memory Map. */
  async _seed() {
    if (!this._db) return;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(this._storeName, 'readonly');
      const store = tx.objectStore(this._storeName);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          this._map.set(cursor.key, cursor.value);
          cursor.continue();
        } else {
          console.log(`[AudioCache] Loaded ${this._map.size} cached audio entries from IndexedDB.`);
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Wait until the DB is open and memory is seeded. */
  async waitReady() {
    return this._ready;
  }

  /** Synchronous check — uses the in-memory mirror. */
  has(key) {
    return this._map.has(key);
  }

  /** Synchronous get — uses the in-memory mirror. */
  get(key) {
    return this._map.get(key);
  }

  /** Store a blob in both memory and IndexedDB. */
  set(key, blob) {
    this._map.set(key, blob);
    if (this._db) {
      try {
        const tx = this._db.transaction(this._storeName, 'readwrite');
        tx.objectStore(this._storeName).put(blob, key);
      } catch (err) {
        console.warn('[AudioCache] IndexedDB write failed:', err.message);
      }
    }
  }
}

const audioCache = new AudioCache();
let currentAudio = null;
let currentAudioElement = null;

// Pre-warm Web Speech API voices to ensure they are loaded when needed
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.getVoices();
    };
  }
}

/**
 * Play synthesized voice audio for the given text.
 * @param {string} text - The text to synthesize and play
 * @param {HTMLElement} element - The .interleaved-rewritten element clicked
 */
async function playTTS(text, element) {
  // If we are already playing this exact element, toggle pause/play
  if (currentAudioElement === element && currentAudio) {
    if (window.speechSynthesis && window.speechSynthesis.speaking && currentAudio.pause === window.speechSynthesis.cancel) {
      // Toggle native SpeechSynthesis
      window.speechSynthesis.cancel();
      element.classList.remove('audio-playing');
      currentAudio = null;
      currentAudioElement = null;
      return;
    } else if (currentAudio.paused !== undefined) {
      // Toggle Audio Element
      if (!currentAudio.paused) {
        currentAudio.pause();
        element.classList.remove('audio-playing');
        return;
      } else {
        element.classList.add('audio-playing');
        currentAudio.play().catch(err => {
          console.error('Audio play failed:', err);
          cleanup();
        });
        return;
      }
    }
  }

  // Stop any currently playing audio and clean up its styling
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudioElement) {
      currentAudioElement.classList.remove('audio-playing', 'audio-loading');
    }
    currentAudio = null;
    currentAudioElement = null;
  }

  currentAudioElement = element;
  element.classList.add('audio-loading');

  const cleanup = () => {
    element.classList.remove('audio-loading', 'audio-playing');
    if (currentAudioElement === element) {
      currentAudio = null;
      currentAudioElement = null;
    }
  };

  try {
    let blob;
    if (audioCache.has(text)) {
      blob = audioCache.get(text);
    } else {
      try {
        const res = await fetch(`${API_BASE}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || `HTTP error ${res.status}`);
        }

        blob = await res.blob();
        audioCache.set(text, blob);
      } catch (fetchErr) {
        console.warn('Backend TTS failed, trying browser SpeechSynthesis fallback:', fetchErr);
        // Verify user didn't click away or click another item during fetch
        if (currentAudioElement !== element) return;
        playSpeechSynthesisFallback(text, element);
        return;
      }
    }

    // Verify user didn't click away or click another item during fetch
    if (currentAudioElement !== element) return;

    element.classList.remove('audio-loading');
    element.classList.add('audio-playing');

    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    currentAudio = audio;

    audio.onended = () => {
      cleanup();
    };

    audio.onerror = () => {
      showToast('Error playing audio.', 'error');
      cleanup();
    };

    await audio.play();

  } catch (err) {
    console.error('TTS playback failed:', err);
    showToast(err.message || 'Voice synthesis failed.', 'error');
    cleanup();
  }
}

/**
 * Fallback to browser SpeechSynthesis API if backend TTS is unavailable.
 */
function playSpeechSynthesisFallback(text, element) {
  if (!('speechSynthesis' in window)) {
    showToast('Voice synthesis is not supported in this browser.', 'error');
    element.classList.remove('audio-loading', 'audio-playing');
    if (currentAudioElement === element) {
      currentAudio = null;
      currentAudioElement = null;
    }
    return;
  }

  // Stop any ongoing native speech
  window.speechSynthesis.cancel();

  element.classList.remove('audio-loading');
  element.classList.add('audio-playing');

  const utterance = new SpeechSynthesisUtterance(text);
  
  // Try to find a suitable English voice (e.g. Google, British, US)
  const voices = window.speechSynthesis.getVoices();
  const englishVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) ||
                      voices.find(v => v.lang.startsWith('en')) ||
                      voices[0];
  if (englishVoice) {
    utterance.voice = englishVoice;
  }

  // Adjust pitch/rate slightly for that classic storyteller feel
  utterance.pitch = 0.95;
  utterance.rate = 0.9;

  utterance.onend = () => {
    element.classList.remove('audio-playing');
    if (currentAudioElement === element) {
      currentAudio = null;
      currentAudioElement = null;
    }
  };

  utterance.onerror = (e) => {
    if (e.error !== 'interrupted') {
      showToast('Native speech synthesis failed.', 'error');
    }
    element.classList.remove('audio-playing');
    if (currentAudioElement === element) {
      currentAudio = null;
      currentAudioElement = null;
    }
  };

  // Keep a mock audio controller to pause / stop native speech
  currentAudio = {
    pause: () => window.speechSynthesis.cancel(),
    paused: false
  };

  window.speechSynthesis.speak(utterance);
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
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw && !localStorage.getItem('rde_seeded_diary')) {
      const defaultEntry = {
        id: 'seed_crush_diary',
        title: 'June 28, Sunday. Weather: Sunny day (晴天)',
        text: 'Dear Diary,\n\nToday is very very hot, but my heart is hotter because of Li Ming. He is my desk-mate, and he is the most handsom boy in our Grade 7 class. His eyes are like two big black grapes in the sweet grape soup, so shiny and bright. When he look at me, my heart is playing deer-jumping, bump-bump-bump, it want to fly out of my neck! I think he is the bright sun, and I am only a small grass who cannot breathe.\n\nIn the afternoon, we have a basketbal match. Li Ming is very good at play basketbal. When he shoot the ball, all the girls screem so loud. I also want to screem, but I am too cow to do that, so I only screem in my heart. He ran very fast, and his sweat is shining like diamonds. He is so cool, really cool, super cool!\n\nAfter school, I saw him walking home. I want to ride bycicle with him, and watch the sunset together. Just like Jay Chou sings in his famous song \'Simple Love\' (简单爱): \'I want to hold your hand like this and not let go, can I simple simple love you?\' But my English is so bad, I cannot tell him. If I talk to him, my face will become very red like a big tomato.\n\nI must good good study, day day up, so that he can notice me. Tomorow, I will try to say \'Hello\' to him first. Wish me good luck, dear diary!',
        date: new Date().toISOString(),
        wordCount: 260
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify([defaultEntry]));
      localStorage.setItem('rde_seeded_diary', 'true');
      return [defaultEntry];
    }
    return JSON.parse(raw || '[]');
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
  if (AppState.inRewriteMode) {
    exitRewriteMode();
  }
  if (AppState.inHoneMode) {
    exitHoneMode(false);
  }
  const entries = getEntries();
  const entry   = entries.find((e) => e.id === id);
  if (!entry) return;

  DOM.textarea.value      = entry.text || '';
  AppState.currentEntryId = entry.id;

  // Restore evaluation, rewrite and hone state data
  AppState.errors = entry.errors || [];
  AppState.appliedFixes = entry.appliedFixes || [];
  AppState.rewriteSentences = entry.rewriteSentences || [];
  AppState.rewriteOriginalText = entry.rewriteOriginalText || null;
  AppState.overallScore = entry.overallScore ?? null;
  AppState.summary = entry.summary || '';
  AppState.honedText = entry.honedText ?? null;
  AppState.honeImprovements = entry.honeImprovements || [];
  AppState.evaluatedOnce = (AppState.overallScore !== null || AppState.errors.length > 0);
  AppState.rewrittenOnce = (AppState.rewriteSentences && AppState.rewriteSentences.length > 0);
  AppState.honedOnce = (AppState.honedText !== null && AppState.honeImprovements.length > 0);

  renderHighlights(entry.text || '', AppState.errors, AppState.appliedFixes);
  renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  updateCounts();
  renderHistory(); // Update active state

  // Close sidebar on mobile
  closeSidebars();
  saveActiveSession();
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
  if (AppState.inRewriteMode) {
    exitRewriteMode();
  }
  if (AppState.inHoneMode) {
    exitHoneMode(false);
  }
  DOM.textarea.value      = '';
  AppState.currentEntryId = null;
  AppState.errors         = [];
  AppState.appliedFixes   = [];
  AppState.overallScore   = null;
  AppState.summary        = '';
  AppState.rewriteSentences = [];
  AppState.rewriteOriginalText = null;
  AppState.honedText = null;
  AppState.honeImprovements = [];
  AppState.evaluatedOnce = false;
  AppState.rewrittenOnce = false;
  AppState.honedOnce = false;

  renderHighlights('', [], []);
  updateCounts();
  clearCorrections();
  renderHistory();

  DOM.textarea.focus();
  closeSidebars();
  saveActiveSession();
}

/**
 * Rename a saved entry by replacing its title with an input field.
 */
function startRenameEntry(id, titleSpan) {
  if (titleSpan.querySelector('.history-item-title-input')) {
    return; // Already editing
  }

  const currentTitle = titleSpan.textContent.trim();
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'history-item-title-input';
  input.value = currentTitle;
  
  // Inline styling to blend in with the history-item layout
  input.style.width = '100%';
  input.style.background = 'rgba(26, 18, 16, 0.8)';
  input.style.border = '1px solid var(--gold)';
  input.style.color = 'var(--parchment)';
  input.style.fontFamily = 'inherit';
  input.style.fontSize = '16px';
  input.style.padding = '2px 6px';
  input.style.borderRadius = 'var(--radius-sm)';
  input.style.outline = 'none';

  // Replace text with the input element
  titleSpan.textContent = '';
  titleSpan.appendChild(input);
  input.focus();
  input.select();

  let finished = false;

  function finishRename(save) {
    if (finished) return;
    finished = true;
    
    const newTitle = input.value.trim();
    if (save && newTitle && newTitle !== currentTitle) {
      const entries = getEntries();
      const entry = entries.find((e) => e.id === id);
      if (entry) {
        entry.title = newTitle;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      }
      titleSpan.textContent = newTitle;
    } else {
      titleSpan.textContent = currentTitle;
    }
    
    renderHistory();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishRename(false);
    }
  });

  input.addEventListener('blur', () => {
    finishRename(true);
  });
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
 * Update active/disabled states of Evaluate, Rewrite, and Hone buttons.
 * Rewrite and Hone buttons are only active when all fixes are applied (AppState.errors is empty).
 */
function updateButtonStates() {
  const hasErrors = AppState.errors && AppState.errors.length > 0;
  const isLoading = AppState.isLoading;
  const isEvaluated = AppState.overallScore !== null;
  const hasRewrite = AppState.rewriteSentences && AppState.rewriteSentences.length > 0;
  const hasHone = !!AppState.honedText;

  if (DOM.btnEvaluate) {
    DOM.btnEvaluate.disabled = isLoading;
  }
  if (DOM.btnRewrite) {
    // Enable if currently in rewrite mode, if cached results exist (so user can view them again), or if evaluated and no errors remain
    DOM.btnRewrite.disabled = (AppState.inRewriteMode || hasRewrite) 
      ? false 
      : (isLoading || !isEvaluated || hasErrors);
  }
  if (DOM.btnHone) {
    // Enable if currently in hone mode, if cached results exist (so user can view them again), or if evaluated and no errors remain
    DOM.btnHone.disabled = (AppState.inHoneMode || hasHone) 
      ? false 
      : (isLoading || !isEvaluated || hasErrors);
  }
}

/**
 * Automatically saves the current text to the journal entries in localStorage.
 */
function autoSaveEntry() {
  // When in hone mode, save the original (pre-hone) text and evaluation state
  // as the entry's canonical data. The honed text is stored separately as `honedText`.
  const inHone = AppState.inHoneMode && AppState.textBeforeHone != null;
  const text = inHone
    ? AppState.textBeforeHone
    : (DOM.textarea ? DOM.textarea.value : '');
  if (!text.trim()) {
    return;
  }

  const entry = {
    id:        AppState.currentEntryId || generateId(),
    text:      text,
    title:     text.split('\n')[0].substring(0, 50) || 'Untitled',
    date:      new Date().toISOString(),
    wordCount: text.split(/\s+/).filter(Boolean).length,
    errors: inHone ? (AppState.errorsBeforeHone || []) : AppState.errors,
    appliedFixes: inHone ? (AppState.appliedFixesBeforeHone || []) : AppState.appliedFixes,
    overallScore: inHone ? AppState.overallScoreBeforeHone : AppState.overallScore,
    summary: inHone ? (AppState.summaryBeforeHone || '') : AppState.summary,
    rewriteSentences: AppState.rewriteSentences,
    rewriteOriginalText: AppState.rewriteOriginalText,
    honedText: AppState.honedText,
    honeImprovements: AppState.honeImprovements
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
  saveActiveSession();
}

/**
 * Render correction cards in the corrections sidebar.
 */
function renderCorrections(errors, score, summary, triggerStagger = false) {
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
    updateButtonStates();
    return;
  }

  if (triggerStagger) {
    DOM.correctionsList.classList.add('stagger-in');
  } else {
    DOM.correctionsList.classList.remove('stagger-in');
  }

  const gap = window.getComputedStyle(DOM.correctionsList).gap || '16px';

  DOM.correctionsList.innerHTML = errors
    .map((err, i) => {
      const typeName  = capitalize(err.type || 'grammar');
      const typeClass = `error-${(err.type || 'grammar').toLowerCase()}`;
      
      const isRestored = AppState.lastRestoredError && 
                         AppState.lastRestoredError.start === err.start && 
                         AppState.lastRestoredError.original === err.original;

      const extraClass = isRestored ? 'card-entering' : '';
      
      const inlineStyle = isRestored
        ? `style="height:0px; margin-top:0px; margin-bottom:-${gap}; padding-top:0px; padding-bottom:0px; border-top-width:0px; border-bottom-width:0px; opacity:0; transform:translateX(120%); overflow:hidden; animation-delay:0s;"`
        : `style="animation-delay:${i * 0.05}s;"`;

      return `
        <div class="correction-card ${extraClass}" data-error-index="${i}" ${inlineStyle}>
          <span class="error-badge ${typeClass}">${typeName}</span>
          <div class="correction-original"><del>${escapeHTML(err.original || '')}</del></div>
          <div class="correction-suggestion"><ins>${escapeHTML(err.suggestion || '')}</ins></div>
          <p class="correction-explanation">${escapeHTML(err.explanation || '')}</p>
          <button class="btn btn-apply-fix" data-fix-index="${i}">Apply Fix</button>
        </div>`;
    })
    .join('');

  if (triggerStagger) {
    setTimeout(() => {
      DOM.correctionsList?.classList.remove('stagger-in');
    }, 1200);
  }

  // Handle entering animation for restored card
  const enteringCard = DOM.correctionsList.querySelector('.card-entering');
  if (enteringCard) {
    const origStyle = enteringCard.getAttribute('style');
    
    enteringCard.style.height = '';
    enteringCard.style.paddingTop = '';
    enteringCard.style.paddingBottom = '';
    enteringCard.style.marginTop = '';
    enteringCard.style.marginBottom = '';
    enteringCard.style.borderTopWidth = '';
    enteringCard.style.borderBottomWidth = '';
    enteringCard.style.overflow = '';
    enteringCard.style.opacity = '';
    enteringCard.style.transform = '';
    
    const fullHeight = enteringCard.offsetHeight;
    
    enteringCard.setAttribute('style', origStyle);
    enteringCard.offsetHeight; // force reflow

    enteringCard.style.transition = 'height 300ms cubic-bezier(0.4, 0, 0.2, 1), margin 300ms cubic-bezier(0.4, 0, 0.2, 1), padding 300ms cubic-bezier(0.4, 0, 0.2, 1), border-width 300ms cubic-bezier(0.4, 0, 0.2, 1)';
    enteringCard.style.height = `${fullHeight}px`;
    enteringCard.style.paddingTop = ''; 
    enteringCard.style.paddingBottom = '';
    enteringCard.style.marginTop = '';
    enteringCard.style.marginBottom = ''; 
    enteringCard.style.borderTopWidth = '';
    enteringCard.style.borderBottomWidth = '';
    enteringCard.style.overflow = 'hidden';

    setTimeout(() => {
      enteringCard.style.transition = 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms cubic-bezier(0.16, 1, 0.3, 1)';
      enteringCard.style.transform = 'translateX(0)';
      enteringCard.style.opacity = '1';

      setTimeout(() => {
        enteringCard.classList.remove('card-entering');
        enteringCard.setAttribute('style', '');
        AppState.lastRestoredError = null;
      }, 300);
    }, 300);
  }
  updateButtonStates();
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
      <p class="correction-explanation">${escapeHTML(explanation)}</p>
    </div>`;
  updateButtonStates();
}

/**
 * Show a single correction card in the corrections sidebar when reviewing an error in rewrite mode.
 */
function renderSingleCorrectionCard(err, index) {
  if (!DOM.correctionsList) return;

  if (DOM.summaryText) {
    DOM.summaryText.innerHTML = `<p><strong>Reviewing Correction</strong></p>`;
  }

  const typeName  = capitalize(err.type || 'grammar');
  const typeClass = `error-${(err.type || 'grammar').toLowerCase()}`;

  DOM.correctionsList.innerHTML = `
    <div class="correction-card" data-error-index="${index}">
      <span class="error-badge ${typeClass}">${typeName}</span>
      <div class="correction-original"><del>${escapeHTML(err.original || '')}</del></div>
      <div class="correction-suggestion"><ins>${escapeHTML(err.suggestion || '')}</ins></div>
      <p class="correction-explanation">${escapeHTML(err.explanation || '')}</p>
      <button class="btn btn-apply-fix" data-fix-index="${index}">Apply Fix</button>
    </div>`;

  updateButtonStates();
}

/**
 * Show hone improvements in the corrections sidebar.
 */
function renderHoneResults(improvements) {
  if (!DOM.correctionsList) return;

  if (DOM.summaryText) {
    DOM.summaryText.innerHTML = `<p><strong>Text polished</strong> — ${improvements.length} improvement${improvements.length !== 1 ? 's' : ''} made.</p>`;
  }

  if (!improvements || improvements.length === 0) {
    DOM.correctionsList.innerHTML = `
      <div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.88rem;font-style:italic;">
        Your text has been polished.
      </div>`;
    updateButtonStates();
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
  updateButtonStates();
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
  updateButtonStates();
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
 * Animate card applying and slide out before invoking applyFix.
 */
function animateApplyFix(errorIndex) {
  const cardEl = DOM.correctionsList.querySelector(`.correction-card[data-error-index="${errorIndex}"]`);
  if (!cardEl) {
    applyFix(errorIndex);
    return;
  }

  const rect = cardEl.getBoundingClientRect();
  const originalHeight = rect.height;
  const gap = window.getComputedStyle(DOM.correctionsList).gap || '16px';

  cardEl.style.height = `${originalHeight}px`;
  cardEl.offsetHeight; // force reflow

  cardEl.style.transition = 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 300ms cubic-bezier(0.4, 0, 0.2, 1), height 300ms cubic-bezier(0.4, 0, 0.2, 1), margin 300ms cubic-bezier(0.4, 0, 0.2, 1), padding 300ms cubic-bezier(0.4, 0, 0.2, 1), border-width 300ms cubic-bezier(0.4, 0, 0.2, 1)';
  
  cardEl.style.transform = 'translateX(120%)';
  cardEl.style.opacity = '0';
  cardEl.style.height = '0px';
  cardEl.style.marginTop = '0px';
  cardEl.style.marginBottom = `-${gap}`;
  cardEl.style.paddingTop = '0px';
  cardEl.style.paddingBottom = '0px';
  cardEl.style.borderTopWidth = '0px';
  cardEl.style.borderBottomWidth = '0px';
  cardEl.style.overflow = 'hidden';
  cardEl.style.pointerEvents = 'none';

  setTimeout(() => {
    applyFix(errorIndex);
  }, 300);
}

/**
 * Apply a correction fix by replacing the error text in the textarea.
 */
function applyFix(errorIndex) {
  const err = AppState.errors[errorIndex];
  if (!err) return;

  setMaryBethPose('apply-fix');

  const text   = DOM.textarea.value;
  const before = text.substring(0, err.start);
  const after  = text.substring(err.end);

  const replacement = err.suggestion || '';
  DOM.textarea.value = before + replacement + after;

  const lengthDiff = replacement.length - (err.end - err.start);

  // Store this fix in appliedFixes so it can be undone
  const appliedFix = {
    start: err.start,
    end: err.start + replacement.length,
    original: err.original,
    suggestion: replacement,
    originalError: { ...err } // shallow copy to preserve original details
  };
  AppState.appliedFixes.push(appliedFix);

  // Adjust positions of remaining errors
  AppState.errors.splice(errorIndex, 1);
  AppState.errors.forEach((e) => {
    if (e.start > err.start) {
      e.start += lengthDiff;
      e.end   += lengthDiff;
    }
  });

  // Adjust positions of other already applied fixes
  AppState.appliedFixes.forEach((f, idx) => {
    // Exclude the one we just added
    if (idx !== AppState.appliedFixes.length - 1 && f.start > err.start) {
      f.start += lengthDiff;
      f.end   += lengthDiff;
    }
  });

  // Adjust positions of rewrite sentences if in rewrite mode
  if (AppState.inRewriteMode && AppState.rewriteSentences) {
    AppState.rewriteSentences.forEach((s) => {
      if (s.start > err.start) {
        s.start += lengthDiff;
        s.end   += lengthDiff;
      } else if (s.end > err.start) {
        s.end   += lengthDiff;
      }
    });
  }

  // Re-render
  renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
  
  if (AppState.inRewriteMode) {
    if (AppState.activeRewriteIndex !== null && AppState.activeRewriteIndex !== undefined) {
      const sentence = AppState.rewriteSentences[AppState.activeRewriteIndex];
      if (sentence) {
        renderRewriteResult(sentence.original, sentence.rewritten, sentence.explanation);
      } else {
        clearCorrections();
      }
    } else {
      clearCorrections();
    }
  } else {
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  }
  
  updateCounts();

  saveActiveSession();
  autoSaveEntry();
}

/**
 * Undo an applied fix, restoring the original text and error state.
 */
function undoFix(fixIndex) {
  const fix = AppState.appliedFixes[fixIndex];
  if (!fix) return;

  const text   = DOM.textarea.value;
  const before = text.substring(0, fix.start);
  const after  = text.substring(fix.end);

  DOM.textarea.value = before + fix.original + after;

  const lengthDiff = fix.original.length - (fix.end - fix.start);

  // Adjust positions of remaining errors
  AppState.errors.forEach((e) => {
    if (e.start > fix.start) {
      e.start += lengthDiff;
      e.end   += lengthDiff;
    }
  });

  // Adjust positions of other applied fixes
  AppState.appliedFixes.forEach((f, idx) => {
    if (idx !== fixIndex && f.start > fix.start) {
      f.start += lengthDiff;
      f.end   += lengthDiff;
    }
  });

  // Adjust positions of rewrite sentences if in rewrite mode
  if (AppState.inRewriteMode && AppState.rewriteSentences) {
    AppState.rewriteSentences.forEach((s) => {
      if (s.start > fix.start) {
        s.start += lengthDiff;
        s.end   += lengthDiff;
      } else if (s.end > fix.start) {
        s.end   += lengthDiff;
      }
    });
  }

  // Restore the error object
  const restoredError = {
    ...fix.originalError,
    start: fix.start,
    end: fix.start + fix.original.length
  };
  AppState.lastRestoredError = restoredError;
  AppState.errors.push(restoredError);

  // Sort errors by start offset to restore original position in the sidebar
  AppState.errors.sort((a, b) => a.start - b.start);

  // Remove this fix from appliedFixes
  AppState.appliedFixes.splice(fixIndex, 1);

  // Re-render
  renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
  
  if (AppState.inRewriteMode) {
    const errIndex = AppState.errors.findIndex(
      e => e.start === restoredError.start && e.original === restoredError.original
    );
    renderSingleCorrectionCard(restoredError, errIndex);
  } else {
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  }
  
  updateCounts();

  saveActiveSession();
  autoSaveEntry();
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

const DYNAMIC_LOADING_MESSAGES = {
  evaluate: [
    "Mary-Beth is dusting off her grammar guides for your pages...",
    "Scanning the lines to find your hidden gems...",
    "Looking over your writing with a keen editor's eye...",
    "Checking your prose by the warm light of the lantern...",
    "Reading through your frontier tales...",
    "Mary-Beth is sifting through your words for any stray punctuation..."
  ],
  rewrite: [
    "Mary-Beth is drafting a fresh take in her journal...",
    "Spinning your words into a new frontier tale...",
    "Dipping her pen to rewrite your prose...",
    "Styling a new way to tell your story...",
    "Scribbling down a few variations for you...",
    "Fleshing out your sentence with some classic style..."
  ],
  hone: [
    "Mary-Beth is polishing up your prose...",
    "Whittling your words down to their finest edge...",
    "Adding some class and charm to your journal...",
    "Giving your writing that perfect final shine...",
    "Tuning your tale to sound like a proper frontier epic...",
    "Mary-Beth is putting the finishing touches on your page..."
  ]
};

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
    if (operation) {
      const messages = DYNAMIC_LOADING_MESSAGES[operation];
      if (messages && messages.length > 0) {
        const randomIndex = Math.floor(Math.random() * messages.length);
        loadingTextEl.textContent = messages[randomIndex];
      } else {
        loadingTextEl.textContent = 'The scribes are at work...';
      }
    } else {
      loadingTextEl.textContent = 'The scribes are at work...';
    }
  }

  // Disable/enable all action buttons based on state
  updateButtonStates();

  // Synchronize Mary-Beth avatar pose with the active operation
  if (operation) {
    setMaryBethPose(operation);
  } else {
    setMaryBethPose('idle-reading');
  }
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
  saveActiveSession();
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
  saveActiveSession();
}

function openCorrectionsSidebar() {
  AppState.correctionsSidebarOpen = true;
  DOM.correctionsSidebar?.classList.add('open');
  updateBackdrop();
  saveActiveSession();
}

function closeSidebars() {
  AppState.historySidebarOpen     = false;
  AppState.correctionsSidebarOpen = false;
  DOM.historySidebar?.classList.remove('open');
  DOM.correctionsSidebar?.classList.remove('open');
  updateBackdrop();
  saveActiveSession();
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

/**
 * Save current active editor and evaluation state to localStorage.
 */
function saveActiveSession() {
  const session = {
    text: DOM.textarea ? DOM.textarea.value : '',
    currentEntryId: AppState.currentEntryId,
    errors: AppState.errors,
    appliedFixes: AppState.appliedFixes,
    overallScore: AppState.overallScore,
    summary: AppState.summary,
    correctionsSidebarOpen: AppState.correctionsSidebarOpen,
    historySidebarOpen: AppState.historySidebarOpen,
    inRewriteMode: AppState.inRewriteMode,
    rewriteSentences: AppState.rewriteSentences,
    rewriteOriginalText: AppState.rewriteOriginalText,
    activeRewriteIndex: AppState.activeRewriteIndex,
    inHoneMode: AppState.inHoneMode,
    honedText: AppState.honedText,
    honeImprovements: AppState.honeImprovements
  };
  localStorage.setItem('rde_active_session', JSON.stringify(session));
}

/**
 * Restore active editor and evaluation state from localStorage if it exists.
 * @returns {boolean} true if session was restored, false otherwise
 */
function restoreActiveSession() {
  const dataStr = localStorage.getItem('rde_active_session');
  if (!dataStr) return false;
  try {
    const session = JSON.parse(dataStr);
    if (!session) return false;

    if (DOM.textarea) DOM.textarea.value = session.text || '';
    AppState.currentEntryId = session.currentEntryId ?? null;
    AppState.errors = session.errors || [];
    AppState.appliedFixes = session.appliedFixes || [];
    AppState.overallScore = session.overallScore ?? null;
    AppState.summary = session.summary || '';
    AppState.correctionsSidebarOpen = session.correctionsSidebarOpen || false;
    AppState.historySidebarOpen = session.historySidebarOpen || false;
    AppState.inRewriteMode = session.inRewriteMode || false;
    AppState.rewriteSentences = session.rewriteSentences || [];
    AppState.rewriteOriginalText = session.rewriteOriginalText || null;
    AppState.activeRewriteIndex = session.activeRewriteIndex ?? null;
    AppState.inHoneMode = session.inHoneMode || false;
    AppState.honedText = session.honedText ?? null;
    AppState.honeImprovements = session.honeImprovements || [];
    AppState.evaluatedOnce = (AppState.overallScore !== null || AppState.errors.length > 0);
    AppState.rewrittenOnce = (AppState.rewriteSentences && AppState.rewriteSentences.length > 0);
    AppState.honedOnce = (AppState.honedText !== null && AppState.honeImprovements.length > 0);

    // Render components
    updateCounts();

    if (AppState.inRewriteMode) {
      if (DOM.rewriteBanner) DOM.rewriteBanner.style.display = 'flex';
      DOM.journalContainer?.classList.add('view-rewrite');
      renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
      
      if (AppState.activeRewriteIndex !== null && AppState.activeRewriteIndex !== undefined) {
        const sentence = AppState.rewriteSentences[AppState.activeRewriteIndex];
        if (sentence) {
          renderRewriteResult(sentence.original, sentence.rewritten, sentence.explanation);
        } else {
          clearCorrections();
        }
      } else {
        if (DOM.summaryText) {
          DOM.summaryText.innerHTML = `<p><strong>Full-Text Rewrite Comparison</strong></p>`;
        }
        if (DOM.correctionsList) {
          DOM.correctionsList.innerHTML = `
            <div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.88rem;font-style:italic;">
              Interact with a rewritten sentence to view its explanation here.
            </div>`;
        }
      }
    } else if (AppState.inHoneMode) {
      if (DOM.rewriteBanner) DOM.rewriteBanner.style.display = 'none';
      DOM.journalContainer?.classList.remove('view-rewrite');
      renderHighlights(DOM.textarea.value, [], []);
      renderHoneResults(AppState.honeImprovements);
    } else {
      if (DOM.rewriteBanner) DOM.rewriteBanner.style.display = 'none';
      DOM.journalContainer?.classList.remove('view-rewrite');
      renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
      renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
    }

    // Sync sidebars
    DOM.historySidebar?.classList.toggle('open', AppState.historySidebarOpen);
    DOM.correctionsSidebar?.classList.toggle('open', AppState.correctionsSidebarOpen);
    updateBackdrop();
    updateButtonStates();

    return true;
  } catch (err) {
    console.warn('Failed to restore active session:', err);
    return false;
  }
}

/**
 * Show a floating popover card for the tapped error highlight on mobile.
 * Uses position:fixed on document.body so it is never clipped by
 * .journal-container's overflow:hidden.
 */
function showMobilePopover(markEl) {
  removeMobilePopover();

  const errorIndex = parseInt(markEl.getAttribute('data-error-index'), 10);
  const err = AppState.errors[errorIndex];
  if (!err) return;

  const typeName  = capitalize(err.type || 'grammar');
  const typeClass = `error-${(err.type || 'grammar').toLowerCase()}`;

  // Add has-popover class to allow scrolling past bottom
  DOM.textarea?.classList.add('has-popover');
  DOM.highlightLayer?.classList.add('has-popover');

  const popover = document.createElement('div');
  popover.className = 'mobile-popover';
  popover.innerHTML = `
    <button class="popover-close-btn" aria-label="Close">&times;</button>
    <span class="error-badge ${typeClass}">${typeName}</span>
    <div class="correction-original"><del>${escapeHTML(err.original || '')}</del></div>
    <div class="correction-suggestion"><ins>${escapeHTML(err.suggestion || '')}</ins></div>
    <p class="correction-explanation">${escapeHTML(err.explanation || '')}</p>
    <button class="btn btn-apply-fix" data-popover-fix-index="${errorIndex}">Apply Fix</button>
  `;

  // Append to document.body so it escapes all overflow:hidden ancestors
  document.body.appendChild(popover);

  // --- Position using viewport coordinates ---
  const markRect = markEl.getBoundingClientRect();
  const popoverWidth = popover.offsetWidth || 290;
  const popoverHeight = popover.offsetHeight || 200;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  // Horizontal: center on the mark, clamped to viewport
  let left = markRect.left + (markRect.width - popoverWidth) / 2;
  left = Math.max(12, Math.min(left, viewportW - popoverWidth - 12));

  // Vertical: prefer above the mark; fall below if not enough room
  let top;
  let placeBelow = false;
  const spaceAbove = markRect.top;
  const spaceBelow = viewportH - markRect.bottom;

  if (spaceAbove >= popoverHeight + 12) {
    // Enough room above
    top = markRect.top - popoverHeight - 10;
  } else if (spaceBelow >= popoverHeight + 12) {
    // Place below
    top = markRect.bottom + 10;
    placeBelow = true;
    popover.classList.add('popover-below');
  } else {
    // Neither side has enough room — place below and cap height
    top = markRect.bottom + 10;
    const maxH = viewportH - top - 16;
    popover.style.maxHeight = `${maxH}px`;
    popover.style.overflowY = 'auto';
    placeBelow = true;
    popover.classList.add('popover-below');
  }

  popover.style.left = `${left}px`;
  popover.style.top  = `${top}px`;

  // Scroll to bring the mark and popover into a clear view with adaptive scroll alignment
  if (DOM.textarea) {
    const containerHeight = DOM.textarea.clientHeight;
    let targetScrollTop;
    if (placeBelow) {
      // Popover is below. Keep mark near the top (e.g. 15% from top) so there's maximum room below
      targetScrollTop = markEl.offsetTop - (containerHeight * 0.15);
    } else {
      // Popover is above. Keep mark near the bottom (e.g. 70% from top) so there's maximum room above
      targetScrollTop = markEl.offsetTop - (containerHeight * 0.70);
    }
    DOM.textarea.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });
  }

  // Reposition on scroll so the popover tracks the mark
  const repositionHandler = () => {
    const r = markEl.getBoundingClientRect();
    let newLeft = r.left + (r.width - popoverWidth) / 2;
    newLeft = Math.max(12, Math.min(newLeft, viewportW - popoverWidth - 12));
    popover.style.left = `${newLeft}px`;
    if (placeBelow) {
      popover.style.top = `${r.bottom + 10}px`;
    } else {
      popover.style.top = `${r.top - popover.offsetHeight - 10}px`;
    }
  };
  DOM.textarea?.addEventListener('scroll', repositionHandler);
  popover._repositionHandler = repositionHandler;

  // Bind close button click
  popover.querySelector('.popover-close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    removeMobilePopover();
  });

  // Bind apply fix button click
  popover.querySelector('[data-popover-fix-index]').addEventListener('click', (e) => {
    e.stopPropagation();
    removeMobilePopover();
    animateApplyFix(errorIndex);
  });
}

/**
 * Remove the mobile floating popover if it exists.
 */
function removeMobilePopover() {
  const popover = document.body.querySelector('.mobile-popover');
  if (popover) {
    // Clean up scroll reposition listener
    if (popover._repositionHandler) {
      DOM.textarea?.removeEventListener('scroll', popover._repositionHandler);
    }
    popover.remove();
  }
  DOM.textarea?.classList.remove('has-popover');
  DOM.highlightLayer?.classList.remove('has-popover');
}

/* --------------------------------------------------------------------------
   15. EVENT LISTENERS
   -------------------------------------------------------------------------- */

function setupEventListeners() {
  let autoSaveTimeout = null;

  // Dismiss mobile popover when clicking outside
  document.addEventListener('click', (e) => {
    const popover = document.body.querySelector('.mobile-popover');
    if (popover && !popover.contains(e.target) && !e.target.closest('mark[data-error-index]')) {
      removeMobilePopover();
    }
  });

  // --- Textarea events ---
  DOM.textarea?.addEventListener('input', () => {
    if (AppState.inRewriteMode) {
      exitRewriteMode();
    }
    if (AppState.inHoneMode) {
      exitHoneMode(false);
    }
    AppState.rewriteSentences = [];
    AppState.honedText = null;
    AppState.honeImprovements = [];
    AppState.errors = [];
    AppState.appliedFixes = [];
    AppState.overallScore = null;
    AppState.summary = '';
    
    updateCounts();
    renderHighlights(DOM.textarea.value, [], []);
    clearCorrections();
    
    syncHighlightScroll();
    saveActiveSession();

    // Autosave on input (debounced by 1000ms)
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
      autoSaveEntry();
    }, 1000);
  });

  DOM.textarea?.addEventListener('scroll', () => {
    syncHighlightScroll();
  });

  DOM.highlightLayer?.addEventListener('scroll', () => {
    if (DOM.textarea && (DOM.textarea.scrollTop !== DOM.highlightLayer.scrollTop || DOM.textarea.scrollLeft !== DOM.highlightLayer.scrollLeft)) {
      DOM.textarea.scrollTop = DOM.highlightLayer.scrollTop;
      DOM.textarea.scrollLeft = DOM.highlightLayer.scrollLeft;
    }
  });

  // Track text selection for the Rewrite feature (not strictly needed for full-rewrite but kept for compatibility)
  DOM.textarea?.addEventListener('mouseup', trackSelection);
  DOM.textarea?.addEventListener('keyup', trackSelection);

  // Prevent iOS / mobile viewport scroll shifts when focusing/blurring editor
  DOM.textarea?.addEventListener('focus', () => {
    window.scrollTo(0, 0);
  });
  DOM.textarea?.addEventListener('blur', () => {
    window.scrollTo(0, 0);
  });

  // --- Action buttons (Evaluate, Rewrite, Hone with Long-Press support) ---
  if (DOM.btnEvaluate) {
    setupLongPress(
      DOM.btnEvaluate,
      () => evaluate(false),
      () => {
        showToast('Re-evaluating text...', 'info');
        evaluate(true);
      }
    );
  }
  if (DOM.btnRewrite) {
    setupLongPress(
      DOM.btnRewrite,
      () => rewrite(false),
      () => {
        showToast('Re-generating rewrite...', 'info');
        rewrite(true);
      }
    );
  }
  if (DOM.btnHone) {
    setupLongPress(
      DOM.btnHone,
      () => hone(false),
      () => {
        showToast('Re-generating hone...', 'info');
        hone(true);
      }
    );
  }
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

    // Ignore clicks inside the title input field
    if (e.target.classList.contains('history-item-title-input')) {
      e.stopPropagation();
      return;
    }

    // Load entry
    const item = e.target.closest('.history-item');
    if (item && item.dataset.id) {
      if (AppState.currentEntryId === item.dataset.id) {
        return; // Already active, don't reload to prevent losing active evaluation/correction data
      }
      loadEntry(item.dataset.id);
    }
  });

  // --- Delegated double-click: History item title rename ---
  DOM.historyList?.addEventListener('dblclick', (e) => {
    const titleSpan = e.target.closest('.history-item-title');
    if (titleSpan) {
      e.stopPropagation();
      const historyItem = titleSpan.closest('.history-item');
      if (historyItem && historyItem.dataset.id) {
        startRenameEntry(historyItem.dataset.id, titleSpan);
      }
    }
  });

  // --- Delegated click: Apply Fix in correction cards ---
  DOM.correctionsList?.addEventListener('click', (e) => {
    const fixBtn = e.target.closest('[data-fix-index]');
    if (fixBtn) {
      animateApplyFix(parseInt(fixBtn.dataset.fixIndex, 10));
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

  // --- Prevent focus loss (blur) when clicking non-focusable elements inside interleaved block ---
  DOM.highlightLayer?.addEventListener('mousedown', (e) => {
    if (!AppState.inRewriteMode) return;
    
    // If they clicked a mark (applied fix or error), let the click handler run (don't prevent default)
    if (e.target.closest('.mark-applied-fix') || e.target.closest('mark[data-error-index]')) {
      const blockEl = e.target.closest('.interleaved-block');
      if (blockEl) {
        const idx = parseInt(blockEl.getAttribute('data-index'), 10);
        AppState.activeRewriteIndex = idx;
      }
      return;
    }

    const blockEl = e.target.closest('.interleaved-block');
    if (blockEl) {
      const idx = parseInt(blockEl.getAttribute('data-index'), 10);
      const rewrittenEl = blockEl.querySelector('.interleaved-rewritten');
      if (rewrittenEl) {
        // Prevent default browser behavior of shifting focus away to body/none
        if (e.target !== rewrittenEl) {
          e.preventDefault();
        }
        activateRewriteBlock(idx, true);
      }
    }
  });

  // --- Delegated click: Undo applied fix, open mobile popover on tap, or select rewritten sentence ---
  DOM.highlightLayer?.addEventListener('click', (e) => {
    const markApplied = e.target.closest('.mark-applied-fix');
    if (markApplied) {
      e.stopPropagation();
      const index = parseInt(markApplied.getAttribute('data-fix-index'), 10);
      if (AppState.inRewriteMode) {
        const blockEl = markApplied.closest('.interleaved-block');
        if (blockEl) {
          AppState.activeRewriteIndex = parseInt(blockEl.getAttribute('data-index'), 10);
        }
      }
      undoFix(index);
      return;
    }

    const errorMark = e.target.closest('mark[data-error-index]');
    if (errorMark) {
      e.stopPropagation();
      const errorIndex = parseInt(errorMark.getAttribute('data-error-index'), 10);
      if (AppState.inRewriteMode) {
        const blockEl = errorMark.closest('.interleaved-block');
        if (blockEl) {
          const idx = parseInt(blockEl.getAttribute('data-index'), 10);
          AppState.activeRewriteIndex = idx;
          const blocks = DOM.highlightLayer.querySelectorAll('.interleaved-block');
          blocks.forEach((b) => {
            const bIdx = parseInt(b.getAttribute('data-index'), 10);
            b.classList.toggle('active-block', bIdx === idx);
          });
        }
        const err = AppState.errors[errorIndex];
        if (err) {
          renderSingleCorrectionCard(err, errorIndex);
        }
      } else {
        if (window.innerWidth <= 1024) {
          showMobilePopover(errorMark);
        }
      }
      return;
    }

    // Clicked specifically on the rewritten sentence block to play TTS
    const rewrittenEl = e.target.closest('.interleaved-rewritten');
    if (rewrittenEl) {
      e.stopPropagation();
      const blockEl = rewrittenEl.closest('.interleaved-block');
      if (blockEl) {
        const idx = parseInt(blockEl.getAttribute('data-index'), 10);
        activateRewriteBlock(idx, true);
      }
      const text = rewrittenEl.textContent.trim();
      if (text) {
        playTTS(text, rewrittenEl);
      }
      return;
    }

    // Clicked an interleaved block (original or rewritten part)
    const blockEl = e.target.closest('.interleaved-block');
    if (blockEl) {
      e.stopPropagation();
      const idx = parseInt(blockEl.getAttribute('data-index'), 10);
      activateRewriteBlock(idx, true);
      return;
    }
  });

  // --- Delegated focusin: History / rewritten sentence keyboard focus ---
  DOM.highlightLayer?.addEventListener('focusin', (e) => {
    const rewrittenEl = e.target.closest('.interleaved-rewritten');
    if (rewrittenEl) {
      const blockEl = rewrittenEl.closest('.interleaved-block');
      if (blockEl) {
        const idx = parseInt(blockEl.getAttribute('data-index'), 10);
        if (AppState.activeRewriteIndex !== idx) {
          activateRewriteBlock(idx, false);
        }
      }
    }
  });



  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    // Ctrl+S / Cmd+S — Save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      autoSaveEntry();
      showToast('Autosaved.', 'success');
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

/**
 * Setup long-press detection on an element.
 */
function setupLongPress(btnEl, clickCallback, longPressCallback) {
  if (!btnEl) return;
  
  // Inject the progress overlay element if it doesn't exist
  let progressEl = btnEl.querySelector('.btn-hold-progress');
  if (!progressEl) {
    progressEl = document.createElement('div');
    progressEl.className = 'btn-hold-progress';
    btnEl.appendChild(progressEl);
  }
  
  let animationFrameId = null;
  let startTime = null;
  let isLongPress = false;
  let currentEvent = null;
  const holdDuration = 800; // 800ms for a satisfying hold feel
  
  const updateProgress = (timestamp) => {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / holdDuration, 1);
    
    btnEl.style.setProperty('--hold-progress', progress);
    
    if (progress < 1) {
      animationFrameId = requestAnimationFrame(updateProgress);
    } else {
      isLongPress = true;
      btnEl.classList.remove('btn--holding');
      btnEl.classList.add('btn--fulfilled');
      
      const ev = currentEvent;
      currentEvent = null;
      
      longPressCallback(ev);
      
      setTimeout(() => {
        btnEl.classList.remove('btn--fulfilled');
        btnEl.style.setProperty('--hold-progress', '0');
      }, 300);
    }
  };
  
  const startPress = (e) => {
    if (e.type === 'mousedown' && e.button !== 0) return;
    
    isLongPress = false;
    startTime = null;
    currentEvent = e;
    btnEl.classList.add('btn--holding');
    btnEl.classList.remove('btn--fulfilled');
    
    animationFrameId = requestAnimationFrame(updateProgress);
  };
  
  const endPress = (e) => {
    btnEl.classList.remove('btn--holding');
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (!isLongPress) {
      btnEl.style.setProperty('--hold-progress', '0');
      currentEvent = null;
    }
  };
  
  btnEl.addEventListener('mousedown', startPress);
  btnEl.addEventListener('touchstart', startPress, { passive: true });
  
  btnEl.addEventListener('mouseup', endPress);
  btnEl.addEventListener('touchend', endPress);
  btnEl.addEventListener('mouseleave', endPress);
  btnEl.addEventListener('touchcancel', endPress);
  
  btnEl.addEventListener('click', (e) => {
    if (isLongPress) {
      e.preventDefault();
      e.stopPropagation();
      isLongPress = false;
      return;
    }
    clickCallback(e);
  });
}

/* --------------------------------------------------------------------------
   16. MARY-BETH AVATAR — Pose Management
   -------------------------------------------------------------------------- */

const MARYBETH_POSES = {
  'idle-reading': 'assets/marybeth/idle-reading.webp',
  'evaluate':     'assets/marybeth/evaluate.webp',
  'rewrite':      'assets/marybeth/rewrite.webp',
  'hone':         'assets/marybeth/hone.webp',
  'apply-fix':    'assets/marybeth/apply-fix.webp',
};

let _maryBethPoseTimer = null;
let _maryBethSwapTimer = null;

/**
 * Swap Mary-Beth's pose with a smooth fade transition.
 * Action poses auto-revert to idle-reading after a timeout.
 *
 * @param {string} pose — One of: 'idle-reading', 'evaluate', 'rewrite', 'hone', 'apply-fix'
 */
function setMaryBethPose(pose) {
  const sprite = DOM.maryBethSprite;
  const avatar = DOM.maryBethAvatar;
  if (!sprite || !avatar) return;

  const src = MARYBETH_POSES[pose];
  if (!src) return;

  // Clear any pending revert timer
  if (_maryBethPoseTimer) {
    clearTimeout(_maryBethPoseTimer);
    _maryBethPoseTimer = null;
  }

  // Clear any pending swap timer
  if (_maryBethSwapTimer) {
    clearTimeout(_maryBethSwapTimer);
    _maryBethSwapTimer = null;
  }

  // Fade out
  sprite.classList.add('pose-swap');

  // After fade-out completes, swap image and fade back in
  _maryBethSwapTimer = setTimeout(() => {
    sprite.src = src;
    sprite.classList.remove('pose-swap');

    // Toggle active state (pauses breathing, adds glow)
    if (pose !== 'idle-reading') {
      avatar.classList.add('pose-active');
    } else {
      avatar.classList.remove('pose-active');
    }
    _maryBethSwapTimer = null;
  }, 300);

  // Auto-revert to idle only for non-loading action poses (like 'apply-fix')
  if (pose === 'apply-fix') {
    _maryBethPoseTimer = setTimeout(() => {
      setMaryBethPose('idle-reading');
    }, 2000);
  }
}

/**
 * Preload all Mary-Beth pose images for instant transitions.
 */
function preloadMaryBethImages() {
  Object.values(MARYBETH_POSES).forEach(src => {
    const img = new Image();
    img.src = src;
  });
}

/* --------------------------------------------------------------------------
   17. INITIALIZATION
   -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  // Cache all DOM references
  initDOMReferences();

  // Render saved history
  renderHistory();

  // Update counts (empty state)
  updateCounts();

  // Load the active session if present, otherwise load the most recent entry
  const restored = restoreActiveSession();
  if (!restored) {
    const entries = getEntries();
    if (entries.length > 0) {
      loadEntry(entries[0].id);
    }
  }

  // Wire up all event listeners
  setupEventListeners();

  // Initial highlight sync
  syncHighlightScroll();

  updateButtonStates();

  // Preload Mary-Beth avatar poses
  preloadMaryBethImages();

  console.log(
    '%c🤠 Red Dead Editor loaded. Write well, partner.',
    'color: #c7a44a; font-family: Georgia, serif; font-size: 14px;'
  );
});
