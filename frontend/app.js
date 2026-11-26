/* ==========================================================================
   RED DEAD EDITOR — Application Logic
   Vanilla JS · No dependencies · Production-ready

   Handles:
   - Dual-layer overlay synchronization (textarea + highlight marks)
   - Invite-only authentication & HttpOnly cookie session lifecycle
   - API calls for evaluate, rewrite, hone, TTS, and cloud state sync
   - IndexedDB audio caching
   - Responsive sidebar drawers
   - Toast notifications
   - Keyboard shortcuts
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   1. CONSTANTS & CONFIGURATION
   -------------------------------------------------------------------------- */

const API_BASE        = '';              // Base URL for API calls (empty = same origin)
const TOAST_DURATION  = 3000;            // Toast auto-dismiss in milliseconds

const DEFAULT_ENTRY_TEXT = 'Dear Diary,\nI think about him constantly. His presence always inflicts a warm, comforting feeling in my chest. Yesterday, we walked home together and he says something funny that made me blush. Every one of his small gestures make me forget my own name. I hope this puppy love is not unrequitted, although I am too shy to ask. The novel was finished by me last night under the starlight, and tears were shed by my eyes because the ending was so tragic. I wish I could tell him how I feel, but in my personal opinion, I think he might already know. His charm is completely irresistable. Even when he is just reading a book, he looks so handsome. Maybe tomorrow I will find the courage to talk to him more, rather than just staring from afar like a secret admirer.';

/* --------------------------------------------------------------------------
   2. APPLICATION STATE
   Single source of truth for the entire UI state.
   -------------------------------------------------------------------------- */

const AppState = {
  authenticated:         false,
  username:              null,
  syncState:             'saved',
  currentText:           '',
  errors:                [],       // Array of {type, start, end, original, suggestion, explanation}
  appliedFixes:          [],       // Array of {start, end, original, suggestion, originalError}
  history:               [],       // Synchronized with server cloud state
  isLoading:             false,
  activeOperation:       null,     // 'evaluate' | 'rewrite' | 'hone' | null
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
  DOM.editorScroll     = document.getElementById('editor-scroll');
  DOM.editorSurface    = document.getElementById('editor-surface');
  DOM.textarea         = document.getElementById('editor-textarea');
  DOM.highlightLayer   = document.getElementById('highlight-layer');
  DOM.loadingOverlay   = document.getElementById('loading-overlay');
  DOM.journalContainer = document.querySelector('.journal-container');
  DOM.rewriteBanner    = document.getElementById('rewrite-banner');
  DOM.honeBanner       = document.getElementById('hone-banner');

  // Counts
  DOM.wordCount      = document.getElementById('word-count');
  DOM.charCount      = document.getElementById('char-count');

  // Buttons
  DOM.btnEvaluate    = document.getElementById('btn-evaluate');
  DOM.btnRewrite     = document.getElementById('btn-rewrite');
  DOM.btnHone        = document.getElementById('btn-hone');
  DOM.btnNewEntry    = document.getElementById('btn-new-entry');
  DOM.btnCopyText    = document.getElementById('btn-copy-text');

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

  // Auth gate & header/mobile user status
  DOM.authGate          = document.getElementById('auth-gate');
  DOM.authChecking      = document.getElementById('auth-checking');
  DOM.authForm          = document.getElementById('auth-form');
  DOM.authUsernameInput = document.getElementById('auth-username-input');
  DOM.authError         = document.getElementById('auth-error');
  DOM.btnAuthSubmit     = document.getElementById('btn-auth-submit');
  DOM.headerUser        = document.getElementById('header-user');
  DOM.headerUsername    = document.getElementById('header-username');
  DOM.syncStatus        = document.getElementById('sync-status');
  DOM.btnLogout         = document.getElementById('btn-logout');
  DOM.sidebarAccountRow = document.getElementById('sidebar-account-row');
  DOM.mobileUsername    = document.getElementById('mobile-username');
  DOM.mobileSyncStatus  = document.getElementById('mobile-sync-status');
  DOM.btnMobileLogout   = document.getElementById('btn-mobile-logout');
}

/* --------------------------------------------------------------------------
   4. OVERLAY SYNCHRONIZATION
   Keeps the highlight layer visually aligned with the textarea content.
   Both layers share identical font metrics so marks line up perfectly.
   -------------------------------------------------------------------------- */



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
    DOM.highlightLayer.textContent = text + '\n';
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
/**
 * Locate an LLM-returned original sentence span inside displayText starting at cursor.
 */
function findSentenceSpan(displayText, originalText, cursor) {
  if (!originalText) return null;

  let start = displayText.indexOf(originalText, cursor);
  if (start !== -1) {
    return { start, end: start + originalText.length };
  }

  const trimmed = originalText.trim();
  if (!trimmed) return null;

  start = displayText.indexOf(trimmed, cursor);
  if (start !== -1) {
    return { start, end: start + trimmed.length };
  }

  // Tolerate minor whitespace/newline normalization from the model
  const tokens = trimmed.split(/\s+/).map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (tokens.length > 0 && tokens.length <= 80) {
    const wsPattern = new RegExp(tokens.join('\\s+'), 'g');
    wsPattern.lastIndex = cursor;
    const match = wsPattern.exec(displayText);
    if (match) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }

  if (trimmed.length >= 8) {
    const prefix = trimmed.slice(0, Math.min(24, trimmed.length));
    const idx = displayText.indexOf(prefix, cursor);
    if (idx !== -1) {
      return { start: idx, end: Math.min(displayText.length, idx + trimmed.length) };
    }
  }

  return null;
}

function renderInterleavedRewrite(text, errors, appliedFixes) {
  // Use the original text that rewrite offsets were computed against,
  // falling back to the passed-in text if not available.
  const displayText = AppState.rewriteOriginalText || text;
  let cursor = 0;
  let html = '';

  for (let i = 0; i < AppState.rewriteSentences.length; i++) {
    const item = AppState.rewriteSentences[i];

    let itemStart = null;
    let itemEnd = null;

    if (typeof item.start === 'number' && typeof item.end === 'number') {
      itemStart = item.start;
      itemEnd = item.end;
    } else {
      const span = findSentenceSpan(displayText, item.original, cursor);
      if (span) {
        itemStart = span.start;
        itemEnd = span.end;
        item.start = itemStart;
        item.end = itemEnd;
      }
    }

    let originalHtml;
    if (itemStart !== null && itemEnd !== null) {
      if (itemStart > cursor) {
        const sepText = displayText.substring(cursor, itemStart);
        // Render separator if not leading blank space
        if ((cursor > 0 && (sepText.trim() || sepText.includes('\n'))) || (cursor === 0 && sepText.trim())) {
          html += `<div class="interleaved-separator">${escapeHTML(sepText)}</div>`;
        }
      }
      originalHtml = renderSubstringWithHighlights(displayText, itemStart, itemEnd, errors, appliedFixes);
      cursor = itemEnd;
    } else {
      // Fallback: never drop a rewritten sentence if exact alignment failed
      originalHtml = escapeHTML(item.original || '');
    }
    
    const isActive = (i === AppState.activeRewriteIndex);
    html += `
      <div class="interleaved-block${isActive ? ' active-block' : ''}" data-index="${i}">
        <div class="interleaved-original">${originalHtml}</div>
        <div class="interleaved-rewritten" tabindex="0"><span class="interleaved-rewritten-main"><span class="interleaved-rewritten-text">${escapeHTML(item.rewritten)}</span><button class="btn-tts-play" type="button" aria-label="Listen to rewritten sentence" title="Listen"><svg class="icon-tts-play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg><svg class="icon-tts-pause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button></span><span class="tts-time-display" hidden>0:00 / 0:00</span></div>
        <div class="tts-waveform-panel" hidden><div class="tts-waveform-stage"><canvas class="tts-waveform-canvas" aria-label="Audio waveform"></canvas></div><button class="btn-tts-speed" type="button" title="Playback speed" aria-label="Playback speed">1.0x</button></div>
      </div>`;
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

  rebindWaveformDOMAfterRender();
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

function makeSessionExpiredError() {
  const err = new Error('Session expired. Please sign in again.');
  err.isSessionExpired = true;
  return err;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    ...options,
  });
  if (res.status === 401 && !options.skipAuthCheck) {
    handleSessionExpired();
    throw makeSessionExpiredError();
  }
  return res;
}

/**
 * Send text for grammatical/stylistic evaluation.
 * Expected response: { score, summary, errors: [{type, start, end, original, suggestion, explanation}] }
 */
async function apiEvaluate(text) {
  const res = await apiFetch('/api/evaluate', {
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
  const res = await apiFetch('/api/rewrite', {
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
  const res = await apiFetch('/api/hone', {
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
    exitRewriteMode(true);
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

  const rawText = DOM.textarea.value;
  if (!rawText.trim()) {
    showToast('Write something first, partner.', 'error');
    return;
  }

  // Blur textarea while evaluating so keyboard input cannot desync in-flight offsets
  DOM.textarea.blur();
  setLoading('evaluate');

  try {
    const data = await apiEvaluate(rawText);

    // Abort if text changed while the request was in flight
    if (DOM.textarea.value !== rawText) {
      return;
    }

    // Cancel any in-flight fix animations before replacing errors
    cancelPendingFixAnimations();

    // Store results in state
    AppState.errors       = data.errors || [];
    AppState.appliedFixes = []; // Reset applied fixes on fresh evaluation
    AppState.overallScore = data.score ?? null;
    AppState.summary      = data.summary || '';
    AppState.evaluatedOnce = true;

    // Clear rewrite/hone cache since we have a fresh evaluation
    AppState.rewriteSentences = [];
    AppState.rewriteOriginalText = null;
    AppState.honedText = null;
    AppState.honeImprovements = [];
    AppState.rewrittenOnce = false;
    AppState.honedOnce = false;

    // Render highlights on the overlay
    renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);

    // Render corrections sidebar
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary, true);

    // Toast feedback
    const issueCount = AppState.errors.length;
    showToast(
      issueCount > 0 ? `Found ${issueCount} issue${issueCount !== 1 ? 's' : ''} to review.` : 'Your text looks great, partner!',
      'success'
    );
    saveActiveSession();
  } catch (err) {
    if (err?.isSessionExpired) return;
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
    exitRewriteMode(true);
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
      enterRewriteMode(data.sentences, true);
      showToast('Article rewritten successfully.', 'success');
    } else {
      showToast('No sentences rewritten.', 'info');
    }
  } catch (err) {
    if (err?.isSessionExpired) return;
    console.error('Rewrite error:', err);
    showToast('Rewrite failed. Try again.', 'error');
  } finally {
    setLoading(null);
  }
}

/**
 * Enter the interleaved rewrite comparison view mode.
 */
function enterRewriteMode(sentences, resetOriginal = false) {
  AppState.inRewriteMode = true;
  AppState.rewriteSentences = sentences;
  // Capture the original text that rewrite offsets are computed against
  if (resetOriginal || AppState.rewriteOriginalText === null || AppState.rewriteOriginalText === undefined) {
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
 * @param {boolean} restoreUI - If true, re-renders highlights, corrections, and focuses the textarea.
 *                               Pass false when immediately entering another mode (hone/evaluate) to avoid a flash.
 */
function exitRewriteMode(restoreUI = true) {
  AppState.inRewriteMode = false;
  AppState.activeRewriteIndex = null;
  stopCurrentAudio();
  if (DOM.highlightLayer) {
    DOM.highlightLayer.setAttribute('aria-hidden', 'true');
  }

  // Hide the rewrite banner
  if (DOM.rewriteBanner) {
    DOM.rewriteBanner.style.display = 'none';
  }

  // Toggle class on container
  DOM.journalContainer?.classList.remove('view-rewrite');

  if (restoreUI) {
    // Re-render standard highlights and corrections
    renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);

    // Focus textarea
    DOM.textarea?.focus();

    // Update button states
    updateButtonStates();
  }
  saveActiveSession();
}

/**
 * HONE — Polish the entire text.
 */
async function hone(force = false) {
  // If clicking or holding Hone while in Rewrite view:
  if (AppState.inRewriteMode) {
    exitRewriteMode(false);
    await hone(force);
    return;
  }

  // Toggle: if already in hone mode, exit back to standard editor view
  if (AppState.inHoneMode && !force) {
    exitHoneMode(true);
    return;
  }

  // If not in hone mode, but we have cached honed results, and we are not forcing, display them!
  if (!force && AppState.honedText) {
    AppState.inHoneMode = true;
    AppState.honedOnce = true;
    if (DOM.textarea) DOM.textarea.readOnly = true;
    if (DOM.honeBanner) DOM.honeBanner.style.display = 'flex';
    DOM.journalContainer?.classList.add('view-hone');
    if (AppState.inRewriteMode) {
      exitRewriteMode(false);
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

  // When force-regenerating while already in Hone mode, always re-hone the original draft
  // instead of re-honing the previous honed output and overwriting textBeforeHone.
  const alreadyInHone = AppState.inHoneMode && AppState.textBeforeHone != null;
  const sourceText = alreadyInHone ? AppState.textBeforeHone : DOM.textarea.value;
  const text = sourceText.trim();
  if (!text) {
    showToast('Write something first, partner.', 'error');
    return;
  }

  setLoading('hone');

  try {
    const data  = await apiHone(text);
    const honed = data.honed || text;

    if (!alreadyInHone) {
      AppState.textBeforeHone = DOM.textarea.value;
      AppState.errorsBeforeHone = [...AppState.errors];
      AppState.appliedFixesBeforeHone = [...AppState.appliedFixes];
      AppState.overallScoreBeforeHone = AppState.overallScore;
      AppState.summaryBeforeHone = AppState.summary;
    }

    AppState.honedText = honed;
    AppState.honeImprovements = data.improvements || [];
    AppState.inHoneMode = true;
    if (DOM.textarea) DOM.textarea.readOnly = true;
    if (DOM.honeBanner) DOM.honeBanner.style.display = 'flex';
    DOM.journalContainer?.classList.add('view-hone');
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
    if (err?.isSessionExpired) return;
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
  if (DOM.honeBanner) DOM.honeBanner.style.display = 'none';
  DOM.journalContainer?.classList.remove('view-hone');

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
const TTS_CACHE_PREFIX = 'gemini_tts_v2:';
const WAVEFORM_BIN_COUNT = 320;
const TTS_SPEED_PRESETS = [1.0, 1.25, 1.5, 0.5, 0.75];
const MIN_LOOP_SPAN_S = 0.15;

let currentAudio = null;
let currentAudioElement = null;
let _waveformAudioCtx = null;

const waveformState = {
  sentenceIndex:  null,
  text:           '',
  requestId:      0,
  loading:        false,
  isReady:        false,
  rawBins:        null,
  duration:       0,
  playbackRate:   1.0,
  loopA:          null,
  loopB:          null,
  isScrubbing:    false,
  rafId:          null,
  resizeObserver: null,
  lastTimeText:   '',
  blockEl:        null,
  rewrittenEl:    null,
  timeEl:         null,
  panelEl:        null,
  stageEl:        null,
  canvasEl:       null,
  speedBtnEl:     null,
};

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const totalSec = Math.floor(seconds + 0.0001);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function getWaveformDuration() {
  if (currentAudio instanceof Audio && Number.isFinite(currentAudio.duration) && currentAudio.duration > 0) {
    return currentAudio.duration;
  }
  return waveformState.duration > 0 ? waveformState.duration : 0;
}

function hasActiveABLoop() {
  return (
    waveformState.loopA !== null &&
    waveformState.loopB !== null &&
    waveformState.loopB - waveformState.loopA >= MIN_LOOP_SPAN_S
  );
}

function updateWaveformTimeDisplay() {
  if (!waveformState.timeEl) return;
  const dur = getWaveformDuration();
  const cur = (currentAudio instanceof Audio && Number.isFinite(currentAudio.currentTime))
    ? Math.max(0, Math.min(dur || currentAudio.currentTime, currentAudio.currentTime))
    : 0;
  const text = `${formatAudioTime(cur)} / ${formatAudioTime(dur)}`;
  if (text !== waveformState.lastTimeText) {
    waveformState.timeEl.textContent = text;
    waveformState.lastTimeText = text;
  }
}

function updateWaveformSpeedLabel() {
  if (!waveformState.speedBtnEl) return;
  const rate = waveformState.playbackRate;
  waveformState.speedBtnEl.textContent = Number.isInteger(rate) ? `${rate}.0x` : `${rate}x`;
}

function stopWaveformRAF() {
  if (waveformState.rafId !== null) {
    cancelAnimationFrame(waveformState.rafId);
    waveformState.rafId = null;
  }
}

function disconnectWaveformResizeObserver() {
  if (waveformState.resizeObserver) {
    try {
      waveformState.resizeObserver.disconnect();
    } catch (_) {}
    waveformState.resizeObserver = null;
  }
}

function attachWaveformResizeObserver(stageEl) {
  disconnectWaveformResizeObserver();
  if (typeof ResizeObserver === 'undefined' || !stageEl) return;
  const ro = new ResizeObserver(() => {
    drawWaveformCanvas();
  });
  ro.observe(stageEl);
  waveformState.resizeObserver = ro;
}

function enforceABLoopIfNeeded() {
  if (!hasActiveABLoop() || !(currentAudio instanceof Audio)) return false;
  if (waveformState.isScrubbing) return false;
  if (!currentAudio.paused && currentAudio.currentTime >= waveformState.loopB) {
    currentAudio.currentTime = waveformState.loopA;
    updateWaveformTimeDisplay();
    drawWaveformCanvas();
    return true;
  }
  return false;
}

function startWaveformRAF() {
  stopWaveformRAF();
  const tick = () => {
    waveformState.rafId = null;
    if (waveformState.sentenceIndex === null) return;
    enforceABLoopIfNeeded();
    updateWaveformTimeDisplay();
    drawWaveformCanvas();
    const shouldKeepTicking = waveformState.loading || (currentAudio instanceof Audio && !currentAudio.paused);
    if (shouldKeepTicking) {
      waveformState.rafId = requestAnimationFrame(tick);
    }
  };
  waveformState.rafId = requestAnimationFrame(tick);
}

/**
 * Parse a RIFF WAVE buffer into normalized mono Float32 samples and sample rate.
 */
function parseWavPcm(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
  const view = new DataView(arrayBuffer);
  const readTag = (offset) => String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
  if (readTag(0) !== 'RIFF' || readTag(8) !== 'WAVE') return null;

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readTag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataStart + 16 <= view.byteLength) {
      audioFormat = view.getUint16(chunkDataStart, true);
      numChannels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      if (audioFormat === 0xFFFE && chunkSize >= 40 && chunkDataStart + 26 <= view.byteLength) {
        audioFormat = view.getUint16(chunkDataStart + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataSize = Math.min(chunkSize, Math.max(0, view.byteLength - chunkDataStart));
      break;
    }

    const paddedSize = chunkSize + (chunkSize & 1);
    const nextOffset = chunkDataStart + paddedSize;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (
    dataOffset < 0 ||
    dataSize <= 0 ||
    numChannels <= 0 ||
    sampleRate <= 0 ||
    (audioFormat !== 1 && audioFormat !== 3)
  ) {
    return null;
  }

  const bytesPerSample = bitsPerSample >> 3;
  if (bytesPerSample <= 0) return null;
  if (audioFormat === 3 && bitsPerSample !== 32) return null;
  if (audioFormat === 1 && ![8, 16, 24, 32].includes(bitsPerSample)) return null;

  const blockAlign = numChannels * bytesPerSample;
  const frameCount = Math.floor(dataSize / blockAlign);
  if (frameCount <= 0) return null;

  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const frameBase = dataOffset + i * blockAlign;
    for (let ch = 0; ch < numChannels; ch++) {
      const pos = frameBase + ch * bytesPerSample;
      let val = 0;
      if (audioFormat === 3) {
        val = view.getFloat32(pos, true);
      } else if (bitsPerSample === 16) {
        val = view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 8) {
        val = (view.getUint8(pos) - 128) / 128;
      } else if (bitsPerSample === 24) {
        let raw = view.getUint8(pos) | (view.getUint8(pos + 1) << 8) | (view.getUint8(pos + 2) << 16);
        if (raw & 0x800000) raw |= ~0xFFFFFF;
        val = raw / 8388608;
      } else if (bitsPerSample === 32) {
        val = view.getInt32(pos, true) / 2147483648;
      }
      sum += val;
    }
    samples[i] = sum / numChannels;
  }

  return {
    samples,
    sampleRate,
    duration: frameCount / sampleRate,
  };
}

function computeWaveformBinsFromSamples(samples, binCount = WAVEFORM_BIN_COUNT) {
  const bins = new Float32Array(binCount);
  const total = samples ? samples.length : 0;
  if (!total) return bins;

  const raw = new Float32Array(binCount);
  for (let i = 0; i < binCount; i++) {
    const start = Math.floor((i * total) / binCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * total) / binCount));
    let sumSq = 0;
    let peak = 0;
    let count = 0;
    for (let j = start; j < end && j < total; j++) {
      const a = Math.abs(samples[j]);
      sumSq += a * a;
      if (a > peak) peak = a;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    raw[i] = 0.65 * rms + 0.35 * peak;
  }

  const sorted = Array.from(raw).sort((a, b) => a - b);
  const p97 = Math.max(1e-6, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))] || 0);
  const gate = 0.035 * p97;
  const denom = Math.max(1e-6, p97 - gate);

  for (let i = 0; i < binCount; i++) {
    if (raw[i] <= gate) {
      bins[i] = 0;
    } else {
      const normalized = Math.min(1, Math.max(0, (raw[i] - gate) / denom));
      bins[i] = Math.pow(normalized, 0.85);
    }
  }
  return bins;
}

async function decodeAudioWaveform(blob, binCount = WAVEFORM_BIN_COUNT) {
  const buf = await blob.arrayBuffer();
  const parsed = parseWavPcm(buf);
  if (parsed) {
    return {
      bins: computeWaveformBinsFromSamples(parsed.samples, binCount),
      duration: parsed.duration,
    };
  }

  const AudioCtx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AudioCtx) {
    return { bins: new Float32Array(binCount), duration: 0 };
  }
  if (!_waveformAudioCtx) {
    _waveformAudioCtx = new AudioCtx();
  }
  const audioBuffer = await _waveformAudioCtx.decodeAudioData(buf.slice(0));
  const length = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels || 1;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const chData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += chData[i] / channels;
    }
  }
  return {
    bins: computeWaveformBinsFromSamples(mono, binCount),
    duration: audioBuffer.duration || 0,
  };
}

function sampleWaveformBarValues(rawBins, barCount) {
  const out = new Float32Array(barCount);
  if (!rawBins || !rawBins.length || barCount <= 0) return out;

  for (let i = 0; i < barCount; i++) {
    const srcStart = Math.floor((i * rawBins.length) / barCount);
    const srcEnd = Math.max(srcStart + 1, Math.floor(((i + 1) * rawBins.length) / barCount));
    let sum = 0;
    let peak = 0;
    let count = 0;
    for (let j = srcStart; j < srcEnd && j < rawBins.length; j++) {
      const v = rawBins[j];
      sum += v;
      if (v > peak) peak = v;
      count++;
    }
    out[i] = count > 0 ? (0.45 * (sum / count) + 0.55 * peak) : 0;
  }

  // Light 3-tap smoothing on voiced segments while keeping silence crisp at 0
  const smoothed = new Float32Array(barCount);
  for (let i = 0; i < barCount; i++) {
    if (out[i] <= 0) {
      smoothed[i] = 0;
      continue;
    }
    const prev = i > 0 ? out[i - 1] : out[i];
    const next = i < barCount - 1 ? out[i + 1] : out[i];
    smoothed[i] = Math.min(1, 0.2 * prev + 0.6 * out[i] + 0.2 * next);
  }
  return smoothed;
}

function drawLoopPinBadge(ctx, x, label, cssW) {
  const badgeW = 15;
  const badgeH = 13;
  const radius = 3;
  const bx = Math.max(2, Math.min(cssW - badgeW - 2, x - badgeW / 2));
  const by = 1;

  ctx.save();
  ctx.fillStyle = '#c7a44a';
  ctx.beginPath();
  ctx.moveTo(bx + radius, by);
  ctx.lineTo(bx + badgeW - radius, by);
  ctx.quadraticCurveTo(bx + badgeW, by, bx + badgeW, by + radius);
  ctx.lineTo(bx + badgeW, by + badgeH - radius);
  ctx.quadraticCurveTo(bx + badgeW, by + badgeH, bx + badgeW - radius, by + badgeH);
  ctx.lineTo(bx + radius, by + badgeH);
  ctx.quadraticCurveTo(bx, by + badgeH, bx, by + badgeH - radius);
  ctx.lineTo(bx, by + radius);
  ctx.quadraticCurveTo(bx, by, bx + radius, by);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#1a1210';
  ctx.font = 'bold 9px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + badgeW / 2, by + badgeH / 2 + 0.5);
  ctx.restore();
}

function drawWaveformCanvas() {
  const canvas = waveformState.canvasEl;
  const stage = waveformState.stageEl;
  if (!canvas || !stage) return;

  const rect = stage.getBoundingClientRect();
  const cssW = Math.max(120, Math.round(rect.width || stage.clientWidth || 480));
  const cssH = Math.max(40, Math.round(rect.height || stage.clientHeight || 64));
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;

  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const cy = cssH / 2;
  const barWidth = 2;
  const step = 5.5;
  const padX = 4;
  const usableW = Math.max(20, cssW - padX * 2);
  const barCount = Math.max(12, Math.floor(usableW / step) + 1);
  const actualStep = barCount > 1 ? usableW / (barCount - 1) : 0;
  const minBarH = 2.2;
  const maxBarH = cssH * 0.68;

  const dur = getWaveformDuration();
  const cur = (currentAudio instanceof Audio && Number.isFinite(currentAudio.currentTime))
    ? currentAudio.currentTime
    : 0;
  const progress = dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0;
  const playheadX = padX + progress * usableW;

  const hasLoopA = waveformState.loopA !== null && dur > 0;
  const hasLoopB = waveformState.loopB !== null && dur > 0;
  const abActive = hasActiveABLoop() && dur > 0;
  const xA = hasLoopA ? (padX + Math.min(1, Math.max(0, waveformState.loopA / dur)) * usableW) : null;
  const xB = hasLoopB ? (padX + Math.min(1, Math.max(0, waveformState.loopB / dur)) * usableW) : null;

  // Translucent A-B loop range band
  if (abActive && xA !== null && xB !== null) {
    ctx.fillStyle = 'rgba(199, 164, 74, 0.11)';
    ctx.fillRect(xA, 15, Math.max(2, xB - xA), Math.max(8, cssH - 19));
  }

  if (waveformState.loading || !waveformState.rawBins) {
    // Subtle pulsing loading dots along the midline
    const pulsePhase = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.005;
    ctx.lineCap = 'round';
    ctx.lineWidth = barWidth;
    for (let i = 0; i < barCount; i++) {
      const x = padX + i * actualStep;
      const wave = 0.5 + 0.5 * Math.sin(pulsePhase - i * 0.25);
      ctx.strokeStyle = `rgba(199, 164, 74, ${0.22 + 0.25 * wave})`;
      ctx.beginPath();
      ctx.moveTo(x, cy - 0.05);
      ctx.lineTo(x, cy + 0.05);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  const bars = sampleWaveformBarValues(waveformState.rawBins, barCount);
  ctx.lineCap = 'round';
  ctx.lineWidth = barWidth;

  for (let i = 0; i < barCount; i++) {
    const x = padX + i * actualStep;
    const val = bars[i];
    const barH = val > 0 ? Math.max(minBarH, val * maxBarH) : minBarH;
    const half = Math.max(0.05, (barH - barWidth) / 2);

    const inLoop = !abActive || (x >= xA - 0.5 && x <= xB + 0.5);
    if (!inLoop) {
      ctx.strokeStyle = 'rgba(184, 154, 90, 0.2)';
    } else if (x <= playheadX) {
      ctx.strokeStyle = val > 0 ? 'rgba(218, 186, 102, 0.92)' : 'rgba(218, 186, 102, 0.58)';
    } else {
      ctx.strokeStyle = val > 0 ? 'rgba(184, 154, 90, 0.45)' : 'rgba(184, 154, 90, 0.32)';
    }

    ctx.beginPath();
    ctx.moveTo(x, cy - half);
    ctx.lineTo(x, cy + half);
    ctx.stroke();
  }

  // A / B loop vertical marker lines & pill badges
  if (xA !== null) {
    ctx.strokeStyle = 'rgba(232, 212, 139, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xA, 14);
    ctx.lineTo(xA, cssH - 4);
    ctx.stroke();
    drawLoopPinBadge(ctx, xA, 'A', cssW);
  }
  if (xB !== null) {
    ctx.strokeStyle = 'rgba(232, 212, 139, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xB, 14);
    ctx.lineTo(xB, cssH - 4);
    ctx.stroke();
    drawLoopPinBadge(ctx, xB, 'B', cssW);
  }

  // Soft radial golden aura behind playhead
  const clampedPlayX = Math.max(2, Math.min(cssW - 2, playheadX));
  const glowRadius = 26;
  const glow = ctx.createRadialGradient(clampedPlayX, cy, 1, clampedPlayX, cy, glowRadius);
  glow.addColorStop(0, 'rgba(248, 224, 146, 0.36)');
  glow.addColorStop(0.45, 'rgba(199, 164, 74, 0.14)');
  glow.addColorStop(1, 'rgba(199, 164, 74, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(clampedPlayX - glowRadius, 0, glowRadius * 2, cssH);

  // Glowing vertical playhead bar
  const playheadHalf = Math.max(10, (cssH * 0.86) / 2);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.6;
  ctx.shadowColor = 'rgba(245, 216, 128, 0.85)';
  ctx.shadowBlur = 12;
  ctx.strokeStyle = '#faebb4';
  ctx.beginPath();
  ctx.moveTo(clampedPlayX, cy - playheadHalf);
  ctx.lineTo(clampedPlayX, cy + playheadHalf);
  ctx.stroke();
  ctx.restore();

  // Sharp luminous core pass
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.0;
  ctx.strokeStyle = '#fff3ca';
  ctx.beginPath();
  ctx.moveTo(clampedPlayX, cy - playheadHalf);
  ctx.lineTo(clampedPlayX, cy + playheadHalf);
  ctx.stroke();

  ctx.restore();
}

function mountWaveformOnBlock(sentenceIdx, text) {
  if (!DOM.highlightLayer || sentenceIdx === null || sentenceIdx === undefined) return false;
  const blockEl = DOM.highlightLayer.querySelector(`.interleaved-block[data-index="${sentenceIdx}"]`);
  if (!blockEl) return false;

  const rewrittenEl = blockEl.querySelector('.interleaved-rewritten');
  const timeEl = blockEl.querySelector('.tts-time-display');
  const panelEl = blockEl.querySelector('.tts-waveform-panel');
  const stageEl = panelEl?.querySelector('.tts-waveform-stage') || null;
  const canvasEl = panelEl?.querySelector('.tts-waveform-canvas') || null;
  const speedBtnEl = panelEl?.querySelector('.btn-tts-speed') || null;

  waveformState.sentenceIndex = sentenceIdx;
  waveformState.text = text;
  waveformState.blockEl = blockEl;
  waveformState.rewrittenEl = rewrittenEl;
  waveformState.timeEl = timeEl;
  waveformState.panelEl = panelEl;
  waveformState.stageEl = stageEl;
  waveformState.canvasEl = canvasEl;
  waveformState.speedBtnEl = speedBtnEl;
  waveformState.lastTimeText = '';

  blockEl.classList.add('waveform-open');
  if (timeEl) timeEl.hidden = false;
  if (panelEl) panelEl.hidden = false;
  updateWaveformSpeedLabel();
  updateWaveformTimeDisplay();
  attachWaveformResizeObserver(stageEl);
  drawWaveformCanvas();
  return true;
}

function rebindWaveformDOMAfterRender() {
  if (waveformState.sentenceIndex === null || !DOM.highlightLayer) return;
  const blockEl = DOM.highlightLayer.querySelector(`.interleaved-block[data-index="${waveformState.sentenceIndex}"]`);
  if (!blockEl) {
    stopCurrentAudio();
    return;
  }

  const rewrittenEl = blockEl.querySelector('.interleaved-rewritten');
  const timeEl = blockEl.querySelector('.tts-time-display');
  const panelEl = blockEl.querySelector('.tts-waveform-panel');
  const stageEl = panelEl?.querySelector('.tts-waveform-stage') || null;
  const canvasEl = panelEl?.querySelector('.tts-waveform-canvas') || null;
  const speedBtnEl = panelEl?.querySelector('.btn-tts-speed') || null;

  waveformState.blockEl = blockEl;
  waveformState.rewrittenEl = rewrittenEl;
  waveformState.timeEl = timeEl;
  waveformState.panelEl = panelEl;
  waveformState.stageEl = stageEl;
  waveformState.canvasEl = canvasEl;
  waveformState.speedBtnEl = speedBtnEl;
  waveformState.lastTimeText = '';
  currentAudioElement = rewrittenEl;

  blockEl.classList.add('waveform-open');
  if (rewrittenEl) {
    rewrittenEl.classList.toggle('audio-loading', waveformState.loading);
    const isPlaying = !!(currentAudio instanceof Audio && !currentAudio.paused && !waveformState.loading);
    rewrittenEl.classList.toggle('audio-playing', isPlaying);
  }
  if (timeEl) timeEl.hidden = false;
  if (panelEl) panelEl.hidden = false;
  updateWaveformSpeedLabel();
  updateWaveformTimeDisplay();
  attachWaveformResizeObserver(stageEl);
  drawWaveformCanvas();
}

function stopCurrentAudio() {
  waveformState.requestId++;
  stopWaveformRAF();
  disconnectWaveformResizeObserver();

  if (currentAudio) {
    try {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.ontimeupdate = null;
      currentAudio.onloadedmetadata = null;
      currentAudio.pause();
    } catch (_) {}
    if (currentAudio._objectUrl) {
      URL.revokeObjectURL(currentAudio._objectUrl);
      currentAudio._objectUrl = null;
    }
  }
  if (currentAudioElement) {
    currentAudioElement.classList.remove('audio-playing', 'audio-loading');
  }

  if (waveformState.blockEl) {
    waveformState.blockEl.classList.remove('waveform-open');
  }
  if (waveformState.rewrittenEl) {
    waveformState.rewrittenEl.classList.remove('audio-playing', 'audio-loading');
  }
  if (waveformState.timeEl) {
    waveformState.timeEl.hidden = true;
    waveformState.timeEl.textContent = '0:00 / 0:00';
  }
  if (waveformState.panelEl) {
    waveformState.panelEl.hidden = true;
  }

  currentAudio = null;
  currentAudioElement = null;

  waveformState.sentenceIndex = null;
  waveformState.text = '';
  waveformState.loading = false;
  waveformState.isReady = false;
  waveformState.rawBins = null;
  waveformState.duration = 0;
  waveformState.loopA = null;
  waveformState.loopB = null;
  waveformState.isScrubbing = false;
  waveformState.lastTimeText = '';
  waveformState.blockEl = null;
  waveformState.rewrittenEl = null;
  waveformState.timeEl = null;
  waveformState.panelEl = null;
  waveformState.stageEl = null;
  waveformState.canvasEl = null;
  waveformState.speedBtnEl = null;
}

function startActiveAudioPlayback() {
  if (!(currentAudio instanceof Audio)) return;
  waveformState.rewrittenEl?.classList.add('audio-playing');
  startWaveformRAF();
  const playPromise = currentAudio.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      console.error('Audio play failed:', err);
      waveformState.rewrittenEl?.classList.remove('audio-playing');
      stopWaveformRAF();
      drawWaveformCanvas();
    });
  }
}

function toggleWaveformPlayPause() {
  if (!waveformState.isReady || !(currentAudio instanceof Audio)) return;
  if (!currentAudio.paused) {
    currentAudio.pause();
    waveformState.rewrittenEl?.classList.remove('audio-playing');
    stopWaveformRAF();
    updateWaveformTimeDisplay();
    drawWaveformCanvas();
    return;
  }

  const dur = getWaveformDuration();
  if (hasActiveABLoop()) {
    if (currentAudio.currentTime < waveformState.loopA || currentAudio.currentTime >= waveformState.loopB - 0.02) {
      currentAudio.currentTime = waveformState.loopA;
    }
  } else if (dur > 0 && currentAudio.currentTime >= dur - 0.03) {
    currentAudio.currentTime = 0;
  }
  startActiveAudioPlayback();
}

function toggleLoopPoint(which) {
  if (!waveformState.isReady || !(currentAudio instanceof Audio)) return;
  const dur = getWaveformDuration();
  if (dur <= 0) return;

  const t = Math.max(0, Math.min(dur, currentAudio.currentTime || 0));

  if (which === 'A') {
    if (waveformState.loopA !== null) {
      waveformState.loopA = null;
    } else {
      if (waveformState.loopB !== null) {
        if (Math.abs(t - waveformState.loopB) < MIN_LOOP_SPAN_S) {
          showToast('Loop A and B must be at least 0.15s apart.', 'info');
          return;
        }
        if (t > waveformState.loopB) {
          waveformState.loopA = waveformState.loopB;
          waveformState.loopB = t;
        } else {
          waveformState.loopA = t;
        }
      } else {
        waveformState.loopA = t;
      }

      if (hasActiveABLoop()) {
        if (currentAudio.currentTime < waveformState.loopA || currentAudio.currentTime >= waveformState.loopB) {
          currentAudio.currentTime = waveformState.loopA;
        }
        if (currentAudio.paused) {
          startActiveAudioPlayback();
        }
      }
    }
  } else if (which === 'B') {
    if (waveformState.loopB !== null) {
      waveformState.loopB = null;
    } else {
      if (waveformState.loopA !== null) {
        if (Math.abs(t - waveformState.loopA) < MIN_LOOP_SPAN_S) {
          showToast('Loop A and B must be at least 0.15s apart.', 'info');
          return;
        }
        if (t < waveformState.loopA) {
          waveformState.loopB = waveformState.loopA;
          waveformState.loopA = t;
        } else {
          waveformState.loopB = t;
        }
      } else {
        waveformState.loopB = t;
      }

      if (hasActiveABLoop()) {
        currentAudio.currentTime = waveformState.loopA;
        if (currentAudio.paused) {
          startActiveAudioPlayback();
        }
      }
    }
  }

  updateWaveformTimeDisplay();
  drawWaveformCanvas();
}

function clearABLoop() {
  if (waveformState.loopA === null && waveformState.loopB === null) return;
  waveformState.loopA = null;
  waveformState.loopB = null;
  drawWaveformCanvas();
}

function cyclePlaybackSpeed() {
  const curIdx = TTS_SPEED_PRESETS.indexOf(waveformState.playbackRate);
  const nextRate = TTS_SPEED_PRESETS[(curIdx + 1) % TTS_SPEED_PRESETS.length];
  waveformState.playbackRate = nextRate;
  if (currentAudio instanceof Audio) {
    currentAudio.playbackRate = nextRate;
    if ('preservesPitch' in currentAudio) {
      currentAudio.preservesPitch = true;
    }
  }
  updateWaveformSpeedLabel();
}

function scrubWaveformToClientX(clientX) {
  if (!waveformState.isReady || !(currentAudio instanceof Audio) || !waveformState.stageEl) return;
  const dur = getWaveformDuration();
  if (dur <= 0) return;

  const rect = waveformState.stageEl.getBoundingClientRect();
  const width = rect.width || waveformState.stageEl.clientWidth || 1;
  const padX = 4;
  const usableW = Math.max(1, width - padX * 2);
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left - padX) / usableW));
  currentAudio.currentTime = ratio * dur;
  updateWaveformTimeDisplay();
  drawWaveformCanvas();
}

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
 * Play synthesized voice audio for the given text and manage its per-sentence waveform.
 * @param {string} text - The text to synthesize and play
 * @param {HTMLElement} element - The .interleaved-rewritten element clicked
 * @param {number|null} sentenceIdx - The index of the rewritten sentence block
 */
async function playTTS(text, element, sentenceIdx = null) {
  if (sentenceIdx === null || Number.isNaN(sentenceIdx)) {
    const attrIdx = element?.closest('.interleaved-block')?.getAttribute('data-index');
    if (attrIdx !== null && attrIdx !== undefined) {
      sentenceIdx = parseInt(attrIdx, 10);
    }
  }

  // If this sentence's waveform is already open, keep it open and toggle play/pause
  if (sentenceIdx !== null && !Number.isNaN(sentenceIdx) && waveformState.sentenceIndex === sentenceIdx) {
    if (waveformState.loading) return;
    if (currentAudio instanceof Audio) {
      toggleWaveformPlayPause();
      return;
    }
  }

  // Legacy fallback check if playing native SpeechSynthesis without waveform
  if (currentAudioElement === element && currentAudio && !(currentAudio instanceof Audio)) {
    if (window.speechSynthesis && window.speechSynthesis.speaking && currentAudio.pause === window.speechSynthesis.cancel) {
      window.speechSynthesis.cancel();
      element.classList.remove('audio-playing');
      currentAudio = null;
      currentAudioElement = null;
      return;
    }
  }

  // Close any previous sentence's audio & waveform before opening this one
  stopCurrentAudio();

  const myRequestId = ++waveformState.requestId;
  currentAudioElement = element;
  waveformState.loading = true;
  waveformState.isReady = false;
  element.classList.add('audio-loading');

  if (sentenceIdx !== null && !Number.isNaN(sentenceIdx)) {
    mountWaveformOnBlock(sentenceIdx, text);
    startWaveformRAF();
  }

  let audioUrl = null;

  try {
    await audioCache.waitReady();
    if (myRequestId !== waveformState.requestId) return;

    const cacheKey = `${TTS_CACHE_PREFIX}${text}`;
    let blob;
    if (audioCache.has(cacheKey)) {
      blob = audioCache.get(cacheKey);
    } else {
      try {
        const res = await apiFetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || `HTTP error ${res.status}`);
        }

        blob = await res.blob();
        audioCache.set(cacheKey, blob);
      } catch (fetchErr) {
        if (fetchErr?.isSessionExpired) {
          stopCurrentAudio();
          return;
        }
        console.warn('Backend TTS failed, trying browser SpeechSynthesis fallback:', fetchErr);
        if (myRequestId !== waveformState.requestId) return;
        stopCurrentAudio();
        playSpeechSynthesisFallback(text, element);
        return;
      }
    }

    if (myRequestId !== waveformState.requestId) return;

    let decoded = { bins: new Float32Array(WAVEFORM_BIN_COUNT), duration: 0 };
    try {
      decoded = await decodeAudioWaveform(blob, WAVEFORM_BIN_COUNT);
    } catch (decodeErr) {
      console.warn('Waveform decode failed, continuing with audio playback:', decodeErr);
    }

    if (myRequestId !== waveformState.requestId) return;

    waveformState.rawBins = decoded.bins;
    waveformState.duration = decoded.duration || 0;
    waveformState.loading = false;
    waveformState.isReady = true;

    const targetEl = waveformState.rewrittenEl || element;
    currentAudioElement = targetEl;
    targetEl.classList.remove('audio-loading');
    targetEl.classList.add('audio-playing');

    audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    audio._objectUrl = audioUrl;
    audio.playbackRate = waveformState.playbackRate;
    if ('preservesPitch' in audio) {
      audio.preservesPitch = true;
    }
    currentAudio = audio;

    audio.onloadedmetadata = () => {
      if (myRequestId !== waveformState.requestId) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        waveformState.duration = audio.duration;
      }
      updateWaveformTimeDisplay();
      drawWaveformCanvas();
    };

    audio.ontimeupdate = () => {
      if (myRequestId !== waveformState.requestId) return;
      enforceABLoopIfNeeded();
      updateWaveformTimeDisplay();
      if (audio.paused) {
        drawWaveformCanvas();
      }
    };

    audio.onended = () => {
      if (myRequestId !== waveformState.requestId) return;
      if (hasActiveABLoop()) {
        audio.currentTime = waveformState.loopA;
        startActiveAudioPlayback();
        return;
      }
      // Keep the waveform open so user can replay, scrub, or set A-B loop points
      (waveformState.rewrittenEl || targetEl).classList.remove('audio-playing');
      stopWaveformRAF();
      updateWaveformTimeDisplay();
      drawWaveformCanvas();
    };

    audio.onerror = () => {
      if (myRequestId !== waveformState.requestId) return;
      showToast('Error playing audio.', 'error');
      stopCurrentAudio();
    };

    updateWaveformTimeDisplay();
    drawWaveformCanvas();
    startWaveformRAF();
    await audio.play();

  } catch (err) {
    if (myRequestId !== waveformState.requestId) return;
    console.error('TTS playback failed:', err);
    showToast(err.message || 'Voice synthesis failed.', 'error');
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
    stopCurrentAudio();
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
  
  // Try to find a suitable female English voice
  const voices = window.speechSynthesis.getVoices();
  const femaleKeywords = ['samantha', 'zira', 'karen', 'susan', 'hazel', 'serena', 'moira', 'tessa', 'victoria', 'google us english', 'female'];
  const englishVoice = voices.find(v => {
    if (!v.lang.startsWith('en')) return false;
    const nameLower = v.name.toLowerCase();
    return nameLower.includes('female') || femaleKeywords.some(kw => nameLower.includes(kw));
  }) ||
  voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) ||
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
   9. CLOUD PERSISTENCE & CACHE
   Journal entries & active workspace state sync directly to SQLite backend.
   -------------------------------------------------------------------------- */

/**
 * Generate a unique ID based on timestamp + random suffix.
 */
function generateId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
}

let _entriesCache = [];
let _dirtyEntries = false;
let _dirtySession = false;
let _pendingActiveSession = null;
let _cloudSyncTimer = null;
let _syncInFlight = false;
let _syncQueued = false;

function updateSyncIndicator(state) {
  AppState.syncState = state;
  const label = state === 'saving' ? 'Saving...' : (state === 'error' ? 'Sync error' : 'Saved');
  if (DOM.syncStatus) {
    DOM.syncStatus.dataset.state = state;
    DOM.syncStatus.textContent = label;
  }
  if (DOM.mobileSyncStatus) {
    DOM.mobileSyncStatus.dataset.state = state;
    DOM.mobileSyncStatus.textContent = label;
  }
}

function getEntries() {
  return _entriesCache;
}

function persistEntries(entries) {
  _entriesCache = Array.isArray(entries) ? entries : [];
  AppState.history = _entriesCache;
  _dirtyEntries = true;
  if (AppState.authenticated) {
    updateSyncIndicator('saving');
    scheduleCloudSync(250);
  }
}

function loadEntry(id, options = {}) {
  if (!options.skipFlush) {
    flushAutoSaveIfPending();
  }
  cancelPendingFixAnimations();
  if (AppState.inRewriteMode) {
    exitRewriteMode(false);
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
  AppState.honedOnce = (AppState.honedText !== null);

  renderHighlights(entry.text || '', AppState.errors, AppState.appliedFixes);
  renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  updateCounts();
  renderHistory();

  closeSidebars();
  if (!options.skipSync) {
    saveActiveSession();
  }
}

/**
 * Delete a saved entry with undo support.
 */
function deleteEntry(id) {
  cancelScheduledAutoSave();
  const entries = getEntries();
  const deletedIndex = entries.findIndex((e) => e.id === id);
  if (deletedIndex === -1) return;

  const deletedEntry = entries[deletedIndex];
  const wasCurrent = AppState.currentEntryId === id;
  persistEntries(entries.filter((e) => e.id !== id));

  if (wasCurrent) {
    newEntry(false, { skipFlush: true });
  }

  renderHistory();
  showToast('Entry removed.', 'info', {
    label: 'Undo',
    onClick: () => {
      const current = [...getEntries()];
      if (!current.some((e) => e.id === deletedEntry.id)) {
        current.splice(Math.min(deletedIndex, current.length), 0, deletedEntry);
        persistEntries(current);
        if (wasCurrent) {
          loadEntry(deletedEntry.id);
        } else {
          renderHistory();
        }
      }
    },
  });
}

/**
 * Start a fresh new entry.
 */
function newEntry(isInit = false, options = {}) {
  if (!options.skipFlush) {
    flushAutoSaveIfPending();
  }
  cancelPendingFixAnimations();
  if (AppState.inRewriteMode) {
    exitRewriteMode(false);
  }
  if (AppState.inHoneMode) {
    exitHoneMode(false);
  }
  const entries = getEntries();
  const defaultVal = (entries.length === 0 && isInit === true) ? DEFAULT_ENTRY_TEXT : '';
  DOM.textarea.value      = defaultVal;
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

  renderHighlights(defaultVal, [], []);
  updateCounts();
  clearCorrections();
  renderHistory();

  if (!options.skipFocus) {
    DOM.textarea.focus();
  }
  closeSidebars();
  if (!options.skipSync) {
    saveActiveSession();
  }
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
        entry.customTitle = true;
        persistEntries(entries);
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

  const isEvaluateView = !AppState.inRewriteMode && !AppState.inHoneMode && (isEvaluated || hasErrors);

  if (DOM.btnEvaluate) {
    DOM.btnEvaluate.disabled = isLoading;
    DOM.btnEvaluate.classList.toggle('btn--active', isEvaluateView);
    DOM.btnEvaluate.setAttribute('aria-pressed', String(isEvaluateView));
  }
  if (DOM.btnRewrite) {
    // Enable if currently in rewrite mode, if cached results exist (so user can view them again), or if evaluated and no errors remain
    DOM.btnRewrite.disabled = (AppState.inRewriteMode || hasRewrite) 
      ? false 
      : (isLoading || !isEvaluated || hasErrors);
    DOM.btnRewrite.classList.toggle('btn--active', AppState.inRewriteMode);
    DOM.btnRewrite.setAttribute('aria-pressed', String(AppState.inRewriteMode));
  }
  if (DOM.btnHone) {
    // Enable if currently in hone mode, if cached results exist (so user can view them again), or if evaluated and no errors remain
    DOM.btnHone.disabled = (AppState.inHoneMode || hasHone) 
      ? false 
      : (isLoading || !isEvaluated || hasErrors);
    DOM.btnHone.classList.toggle('btn--active', AppState.inHoneMode);
    DOM.btnHone.setAttribute('aria-pressed', String(AppState.inHoneMode));
  }
}

/**
 * Derive an automatic entry title from the first line of text.
 */
function deriveEntryTitle(text) {
  return (text || '').split('\n')[0].substring(0, 50) || 'Untitled';
}

/**
 * Determine whether an existing saved entry has a user-customized title.
 */
function hasCustomEntryTitle(existingEntry) {
  if (!existingEntry || !existingEntry.title) return false;
  if (existingEntry.customTitle === true) return true;
  // Backwards compatibility for entries renamed before the customTitle flag existed
  const prevAuto = deriveEntryTitle(existingEntry.text || '');
  return existingEntry.title !== prevAuto;
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

  const entries = [...getEntries()];
  const entryId = AppState.currentEntryId || generateId();
  const existingIndex = entries.findIndex((e) => e.id === entryId);
  const existingEntry = existingIndex >= 0 ? entries[existingIndex] : null;
  const keepCustomTitle = hasCustomEntryTitle(existingEntry);

  const entry = {
    id:          entryId,
    text:        text,
    title:       keepCustomTitle ? existingEntry.title : deriveEntryTitle(text),
    customTitle: keepCustomTitle,
    date:        new Date().toISOString(),
    wordCount:   text.split(/\s+/).filter(Boolean).length,
    errors: inHone ? (AppState.errorsBeforeHone || []) : AppState.errors,
    appliedFixes: inHone ? (AppState.appliedFixesBeforeHone || []) : AppState.appliedFixes,
    overallScore: inHone ? AppState.overallScoreBeforeHone : AppState.overallScore,
    summary: inHone ? (AppState.summaryBeforeHone || '') : AppState.summary,
    rewriteSentences: AppState.rewriteSentences,
    rewriteOriginalText: AppState.rewriteOriginalText,
    honedText: AppState.honedText,
    honeImprovements: AppState.honeImprovements
  };

  if (existingIndex >= 0) {
    entries[existingIndex] = entry;
  } else {
    entries.unshift(entry);
  }

  persistEntries(entries);
  AppState.currentEntryId = entry.id;
  renderHistory();
  saveActiveSession();
}

/**
 * Render correction cards in the corrections sidebar.
 */
function renderCorrections(errors, score, summary, triggerStagger = false) {
  if (!DOM.correctionsList) return;

  // Summary text (+ Apply All button when multiple issues remain)
  if (DOM.summaryText) {
    const summaryParagraph = summary
      ? `<p>${escapeHTML(summary)}</p>`
      : `<p>No assessment available.</p>`;
    if (errors && errors.length > 1) {
      DOM.summaryText.innerHTML = `
        <div class="summary-bar">
          ${summaryParagraph}
          <button class="btn-apply-all" type="button" data-action="apply-all" title="Apply all remaining suggestions">
            Apply All (${errors.length})
          </button>
        </div>`;
    } else {
      DOM.summaryText.innerHTML = summaryParagraph;
    }
  }

  if (!errors || errors.length === 0) {
    DOM.correctionsList.innerHTML = `
      <div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.88rem;font-style:italic;">
        ${score !== null ? 'All clear — ready to Rewrite or Hone, partner!' : 'Evaluate your writing to see corrections here.'}
      </div>`;
    updateButtonStates();
    return;
  }

  if (triggerStagger) {
    DOM.correctionsList.classList.add('stagger-in');
  } else {
    DOM.correctionsList.classList.remove('stagger-in');
  }

  DOM.correctionsList.innerHTML = errors
    .map((err, i) => {
      const uid       = ensureErrorUid(err);
      const typeName  = capitalize(err.type || 'grammar');
      const typeClass = `error-${(err.type || 'grammar').toLowerCase()}`;

      const isRestored = AppState.lastRestoredError &&
                         AppState.lastRestoredError.start === err.start &&
                         AppState.lastRestoredError.original === err.original;

      const extraClass = isRestored ? 'card-entering' : '';
      const styleAttr = triggerStagger && !isRestored ? `style="animation-delay:${i * 0.04}s;"` : '';

      return `
        <div class="correction-card ${extraClass}" data-error-index="${i}" data-error-uid="${escapeHTML(uid)}" ${styleAttr}>
          <span class="error-badge ${typeClass}">${typeName}</span>
          <div class="correction-original"><del>${escapeHTML(err.original || '')}</del></div>
          <div class="correction-suggestion"><ins>${escapeHTML(err.suggestion || '')}</ins></div>
          <p class="correction-explanation">${escapeHTML(err.explanation || '')}</p>
          <div class="correction-card-actions">
            <button class="btn btn-apply-fix" data-fix-index="${i}" data-fix-uid="${escapeHTML(uid)}">Apply Fix</button>
            <button class="btn btn-dismiss-fix" data-dismiss-index="${i}" data-dismiss-uid="${escapeHTML(uid)}" title="Ignore this suggestion">Dismiss</button>
          </div>
        </div>`;
    })
    .join('');

  if (triggerStagger) {
    setTimeout(() => {
      DOM.correctionsList?.classList.remove('stagger-in');
    }, 1000);
  }

  const enteringCard = DOM.correctionsList.querySelector('.card-entering');
  if (enteringCard) {
    const clearEntering = () => {
      enteringCard.classList.remove('card-entering');
      AppState.lastRestoredError = null;
    };
    enteringCard.addEventListener('animationend', clearEntering, { once: true });
    setTimeout(clearEntering, 260);
  } else {
    AppState.lastRestoredError = null;
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

  const uid       = ensureErrorUid(err);
  const typeName  = capitalize(err.type || 'grammar');
  const typeClass = `error-${(err.type || 'grammar').toLowerCase()}`;

  DOM.correctionsList.innerHTML = `
    <div class="correction-card" data-error-index="${index}" data-error-uid="${escapeHTML(uid)}">
      <span class="error-badge ${typeClass}">${typeName}</span>
      <div class="correction-original"><del>${escapeHTML(err.original || '')}</del></div>
      <div class="correction-suggestion"><ins>${escapeHTML(err.suggestion || '')}</ins></div>
      <p class="correction-explanation">${escapeHTML(err.explanation || '')}</p>
      <div class="correction-card-actions">
        <button class="btn btn-apply-fix" data-fix-index="${index}" data-fix-uid="${escapeHTML(uid)}">Apply Fix</button>
        <button class="btn btn-dismiss-fix" data-dismiss-index="${index}" data-dismiss-uid="${escapeHTML(uid)}" title="Ignore this suggestion">Dismiss</button>
      </div>
    </div>`;

  updateButtonStates();
}

/**
 * Show hone improvements in the corrections sidebar.
 */
function renderHoneResults(improvements) {
  if (!DOM.correctionsList) return;

  const list = Array.isArray(improvements) ? improvements : [];
  if (DOM.summaryText) {
    DOM.summaryText.innerHTML = list.length > 0
      ? `<p><strong>Text polished</strong> — ${list.length} highlight${list.length !== 1 ? 's' : ''} noted.</p>`
      : `<p><strong>Text polished</strong></p>`;
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


const _pendingFixErrors = new Set();
const _pendingFixTimers = new Set();

function ensureErrorUid(err) {
  if (!err._uid) {
    err._uid = generateId();
  }
  return err._uid;
}

function resolveErrorTarget(errorRefOrIndex) {
  if (typeof errorRefOrIndex === 'number') {
    return AppState.errors[errorRefOrIndex] || null;
  }
  if (typeof errorRefOrIndex === 'string') {
    return AppState.errors.find((e) => e._uid === errorRefOrIndex) || null;
  }
  if (errorRefOrIndex && typeof errorRefOrIndex === 'object') {
    return AppState.errors.includes(errorRefOrIndex) ? errorRefOrIndex : null;
  }
  return null;
}

function cancelPendingFixAnimations() {
  _pendingFixTimers.forEach((id) => clearTimeout(id));
  _pendingFixTimers.clear();
  _pendingFixErrors.clear();
}

/**
 * Animate card applying and slide out before invoking applyFix.
 * Identifies the target error by stable object reference / UID so rapid clicks
 * on multiple cards never collide when earlier fixes splice AppState.errors.
 */
/**
 * GPU-composited card removal helper shared by Apply Fix and Dismiss.
 */
function animateRemoveCard(errorRefOrIndex, onComplete, validateSpan = false) {
  const err = resolveErrorTarget(errorRefOrIndex);
  if (!err || _pendingFixErrors.has(err)) return;

  if (validateSpan) {
    const currentSlice = DOM.textarea.value.substring(err.start, err.end);
    if (currentSlice !== err.original) {
      showToast('Text changed since evaluation — please re-evaluate.', 'error');
      renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
      renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
      return;
    }
  }

  const uid = ensureErrorUid(err);
  const currentIndex = AppState.errors.indexOf(err);
  const cardEl = DOM.correctionsList?.querySelector(`.correction-card[data-error-uid="${uid}"]`)
    || DOM.correctionsList?.querySelector(`.correction-card[data-error-index="${currentIndex}"]`);

  if (!cardEl) {
    onComplete(err, null);
    return;
  }

  _pendingFixErrors.add(err);
  cardEl.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
  cardEl.classList.add('card-exiting');

  const timerId = setTimeout(() => {
    _pendingFixTimers.delete(timerId);
    _pendingFixErrors.delete(err);
    onComplete(err, cardEl);
  }, 160);
  _pendingFixTimers.add(timerId);
}

function animateApplyFix(errorRefOrIndex) {
  animateRemoveCard(errorRefOrIndex, applyFix, true);
}

/**
 * Keep cached rewrite sentence offsets, original slices, and rewriteOriginalText
 * synchronized with the editor text whenever a fix is applied or undone.
 */
function syncRewriteStateAfterEdit(spanStart, spanEnd, lengthDiff, newText) {
  if (!AppState.rewriteSentences || AppState.rewriteSentences.length === 0) return;

  AppState.rewriteSentences.forEach((s) => {
    if (typeof s.start !== 'number' || typeof s.end !== 'number') return;
    if (s.start >= spanEnd) {
      s.start += lengthDiff;
      s.end   += lengthDiff;
    } else if (s.end > spanStart) {
      if (s.start > spanStart) {
        s.start = spanStart + (spanEnd - spanStart) + lengthDiff;
      }
      s.end = Math.max(s.start, s.end + lengthDiff);
      s.original = newText.substring(s.start, s.end);
    }
  });

  AppState.rewriteOriginalText = newText;
}

/**
 * Apply a correction fix by replacing the error text in the textarea.
 */
function applyFix(errorRefOrIndex, animatedCardEl = null) {
  const err = resolveErrorTarget(errorRefOrIndex);
  if (!err) return;
  const errorIndex = AppState.errors.indexOf(err);
  if (errorIndex === -1) return;

  const text = DOM.textarea.value;
  if (text.substring(err.start, err.end) !== err.original) {
    showToast('Could not apply fix — text no longer matches. Please re-evaluate.', 'error');
    renderHighlights(text, AppState.errors, AppState.appliedFixes);
    if (!AppState.inRewriteMode) {
      renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
    }
    return;
  }

  setMaryBethPose('apply-fix');

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
    if (e.start >= err.end) {
      e.start += lengthDiff;
      e.end   += lengthDiff;
    }
  });

  // Adjust positions of other already applied fixes
  AppState.appliedFixes.forEach((f, idx) => {
    // Exclude the one we just added
    if (idx !== AppState.appliedFixes.length - 1 && f.start >= err.end) {
      f.start += lengthDiff;
      f.end   += lengthDiff;
    }
  });

  // Keep cached rewrite spans and rewriteOriginalText synchronized with DOM.textarea.value
  syncRewriteStateAfterEdit(err.start, err.end, lengthDiff, DOM.textarea.value);

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
  } else if (_pendingFixErrors.size === 0) {
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  } else {
    animatedCardEl?.remove();
    updateButtonStates();
  }
  
  updateCounts();

  saveActiveSession();
  autoSaveEntry();
}

/**
 * Animate a correction card sliding out before dismissing (ignoring) it.
 */
function animateDismissFix(errorRefOrIndex) {
  animateRemoveCard(errorRefOrIndex, dismissFix, false);
}

/**
 * Dismiss (ignore) a suggestion without modifying the editor text.
 */
function dismissFix(errorRefOrIndex, animatedCardEl = null) {
  const err = resolveErrorTarget(errorRefOrIndex);
  if (!err) return;
  const errorIndex = AppState.errors.indexOf(err);
  if (errorIndex === -1) return;

  AppState.errors.splice(errorIndex, 1);

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
  } else if (_pendingFixErrors.size === 0) {
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  } else {
    animatedCardEl?.remove();
    updateButtonStates();
  }

  saveActiveSession();
  autoSaveEntry();
}

/**
 * Apply all remaining evaluation fixes in one pass while preserving
 * individual undo spans in AppState.appliedFixes.
 */
function applyAllFixes() {
  if (!AppState.errors || AppState.errors.length === 0) return;

  cancelPendingFixAnimations();

  let text = DOM.textarea.value;
  let appliedCount = 0;
  let skippedCount = 0;

  // Apply in ascending offset order so each shift stays deterministic
  AppState.errors.sort((a, b) => a.start - b.start);
  const queue = [...AppState.errors];

  for (const err of queue) {
    const idx = AppState.errors.indexOf(err);
    if (idx === -1) continue;

    if (text.substring(err.start, err.end) !== err.original) {
      skippedCount++;
      continue;
    }

    const replacement = err.suggestion || '';
    text = text.substring(0, err.start) + replacement + text.substring(err.end);
    const lengthDiff = replacement.length - (err.end - err.start);

    const appliedFix = {
      start: err.start,
      end: err.start + replacement.length,
      original: err.original,
      suggestion: replacement,
      originalError: { ...err }
    };
    AppState.appliedFixes.push(appliedFix);

    AppState.errors.splice(idx, 1);
    AppState.errors.forEach((e) => {
      if (e.start >= err.end) {
        e.start += lengthDiff;
        e.end   += lengthDiff;
      }
    });

    AppState.appliedFixes.forEach((f, fIdx) => {
      if (fIdx !== AppState.appliedFixes.length - 1 && f.start >= err.end) {
        f.start += lengthDiff;
        f.end   += lengthDiff;
      }
    });

    syncRewriteStateAfterEdit(err.start, err.end, lengthDiff, text);
    appliedCount++;
  }

  if (appliedCount > 0) {
    DOM.textarea.value = text;
    setMaryBethPose('apply-fix');
  }

  renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
  renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
  updateCounts();
  saveActiveSession();
  autoSaveEntry();

  if (appliedCount > 0 && skippedCount === 0) {
    showToast(`Applied all ${appliedCount} fix${appliedCount !== 1 ? 'es' : ''}.`, 'success');
  } else if (appliedCount > 0 && skippedCount > 0) {
    showToast(`Applied ${appliedCount} fixes (${skippedCount} skipped — text changed).`, 'info');
  } else {
    showToast('Could not apply fixes — text no longer matches. Please re-evaluate.', 'error');
  }
}

let _copyFeedbackTimer = null;

/**
 * Copy the active view's text to the clipboard:
 * - Rewrite mode: full rewritten passage
 * - Hone mode: polished passage
 * - Normal edit mode: current textarea content
 */
async function copyCurrentText() {
  let textToCopy = '';
  let label = 'Text';

  if (AppState.inRewriteMode && AppState.rewriteSentences && AppState.rewriteSentences.length > 0) {
    const origText = AppState.rewriteOriginalText || '';
    const hasPositioned = origText && AppState.rewriteSentences.some(
      (s) => typeof s.start === 'number' && typeof s.end === 'number'
    );
    if (hasPositioned) {
      let rebuilt = '';
      let pos = 0;
      const unpositioned = [];
      for (const s of AppState.rewriteSentences) {
        const rewrittenSentence = (s.rewritten || '').trim();
        if (typeof s.start === 'number' && typeof s.end === 'number' && s.start >= pos) {
          if (s.start > pos) {
            rebuilt += origText.slice(pos, s.start);
          }
          rebuilt += rewrittenSentence;
          pos = Math.max(pos, s.end);
        } else if (rewrittenSentence) {
          unpositioned.push(rewrittenSentence);
        }
      }
      if (pos < origText.length) {
        rebuilt += origText.slice(pos);
      }
      if (unpositioned.length > 0) {
        rebuilt = (rebuilt.trimEnd() ? rebuilt.trimEnd() + '\n\n' : '') + unpositioned.join(' ');
      }
      textToCopy = rebuilt;
    } else {
      textToCopy = AppState.rewriteSentences
        .map((s) => (s.rewritten || '').trim())
        .filter(Boolean)
        .join(' ');
    }
    label = 'Rewritten text';
  } else if (AppState.inHoneMode) {
    textToCopy = DOM.textarea ? DOM.textarea.value : (AppState.honedText || '');
    label = 'Honed text';
  } else {
    textToCopy = DOM.textarea ? DOM.textarea.value : '';
    label = 'Text';
  }

  if (!textToCopy.trim()) {
    showToast('Nothing to copy yet, partner.', 'info');
    return;
  }

  let copied = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(textToCopy);
      copied = true;
    }
  } catch (err) {
    console.warn('Clipboard API failed, trying fallback:', err);
  }

  if (!copied) {
    try {
      const temp = document.createElement('textarea');
      temp.value = textToCopy;
      temp.setAttribute('readonly', '');
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.select();
      copied = document.execCommand('copy');
      temp.remove();
    } catch (err) {
      console.error('Fallback copy failed:', err);
    }
  }

  if (!copied) {
    showToast('Could not copy to clipboard.', 'error');
    return;
  }

  if (DOM.btnCopyText) {
    const labelEl = DOM.btnCopyText.querySelector('.copy-label');
    DOM.btnCopyText.classList.add('copied');
    if (labelEl) labelEl.textContent = 'Copied';
    clearTimeout(_copyFeedbackTimer);
    _copyFeedbackTimer = setTimeout(() => {
      DOM.btnCopyText?.classList.remove('copied');
      if (labelEl) labelEl.textContent = 'Copy';
    }, 1500);
  }
  showToast(`${label} copied to clipboard.`, 'success');
}

/**
 * Undo an applied fix, restoring the original text and error state.
 */
function undoFix(fixIndex) {
  const fix = AppState.appliedFixes[fixIndex];
  if (!fix) return;

  const text = DOM.textarea.value;
  if (text.substring(fix.start, fix.end) !== fix.suggestion) {
    showToast('Could not undo fix — text has changed.', 'error');
    return;
  }

  const before = text.substring(0, fix.start);
  const after  = text.substring(fix.end);

  DOM.textarea.value = before + fix.original + after;

  const lengthDiff = fix.original.length - (fix.end - fix.start);

  // Adjust positions of remaining errors
  AppState.errors.forEach((e) => {
    if (e.start >= fix.end) {
      e.start += lengthDiff;
      e.end   += lengthDiff;
    }
  });

  // Adjust positions of other applied fixes
  AppState.appliedFixes.forEach((f, idx) => {
    if (idx !== fixIndex && f.start >= fix.end) {
      f.start += lengthDiff;
      f.end   += lengthDiff;
    }
  });

  // Keep cached rewrite spans and rewriteOriginalText synchronized with DOM.textarea.value
  syncRewriteStateAfterEdit(fix.start, fix.end, lengthDiff, DOM.textarea.value);

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
function showToast(message, type = 'info', action = null) {
  if (!DOM.toastContainer) return;

  const icons = {
    success: '✓',
    error:   '✗',
    warning: '⚠',
    info:    'ℹ',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ'}</span>
    <span>${escapeHTML(message)}</span>`;

  let dismissTimer = null;
  const dismissToast = () => {
    clearTimeout(dismissTimer);
    if (toast.classList.contains('toast-exit')) return;
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 350);
  };

  if (action && typeof action.onClick === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'toast-undo-btn';
    actionBtn.textContent = action.label || 'Undo';
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissToast();
      action.onClick();
    });
    toast.appendChild(actionBtn);
  }

  DOM.toastContainer.appendChild(toast);
  dismissTimer = setTimeout(dismissToast, action ? Math.max(TOAST_DURATION, 5000) : TOAST_DURATION);
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
 * Cloud sync scheduling & active workspace session snapshot helpers.
 */
let _sessionSaveTimer = null;
let _autoSaveTimer = null;
let _hasPendingAutoSave = false;

function buildActiveSessionSnapshot() {
  return {
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
    honeImprovements: AppState.honeImprovements,
    textBeforeHone: AppState.textBeforeHone,
    errorsBeforeHone: AppState.errorsBeforeHone,
    appliedFixesBeforeHone: AppState.appliedFixesBeforeHone,
    overallScoreBeforeHone: AppState.overallScoreBeforeHone,
    summaryBeforeHone: AppState.summaryBeforeHone,
  };
}

function scheduleCloudSync(delayMs = 300) {
  if (!AppState.authenticated) return;
  clearTimeout(_cloudSyncTimer);
  _cloudSyncTimer = setTimeout(() => {
    _cloudSyncTimer = null;
    syncToCloud();
  }, delayMs);
}

async function syncToCloud({ unload = false } = {}) {
  if (!AppState.authenticated) return;
  if (!_dirtyEntries && !_dirtySession) return;

  if (!unload && _syncInFlight) {
    _syncQueued = true;
    return;
  }

  const sendEntries = _dirtyEntries;
  const sendSession = _dirtySession;
  const payload = {};
  if (sendEntries) payload.entries = _entriesCache;
  if (sendSession) payload.active_session = _pendingActiveSession;

  _dirtyEntries = false;
  _dirtySession = false;

  if (unload) {
    clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = null;
    const bodyStr = JSON.stringify(payload);
    let beaconSent = false;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && typeof Blob !== 'undefined') {
        const blob = new Blob([bodyStr], { type: 'application/json' });
        beaconSent = navigator.sendBeacon(`${API_BASE}/api/state`, blob);
      }
    } catch (_) {
      beaconSent = false;
    }
    if (!beaconSent) {
      try {
        fetch(`${API_BASE}/api/state`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    }
    return;
  }

  _syncInFlight = true;
  updateSyncIndicator('saving');
  try {
    const res = await apiFetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Sync failed: ${res.status}`);
    }
    if (!_dirtyEntries && !_dirtySession) {
      updateSyncIndicator('saved');
    }
  } catch (err) {
    if (err?.isSessionExpired) return;
    console.warn('Cloud sync failed:', err);
    if (sendEntries) _dirtyEntries = true;
    if (sendSession) _dirtySession = true;
    updateSyncIndicator('error');
  } finally {
    _syncInFlight = false;
    if (_syncQueued) {
      _syncQueued = false;
      if (AppState.authenticated && (_dirtyEntries || _dirtySession)) {
        scheduleCloudSync(150);
      }
    }
  }
}

function scheduleSaveActiveSession(delayMs = 500) {
  clearTimeout(_sessionSaveTimer);
  _sessionSaveTimer = setTimeout(() => {
    _sessionSaveTimer = null;
    saveActiveSession();
  }, delayMs);
}

function scheduleAutoSaveEntry(delayMs = 1000) {
  _hasPendingAutoSave = true;
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    _autoSaveTimer = null;
    _hasPendingAutoSave = false;
    autoSaveEntry();
  }, delayMs);
}

function cancelScheduledAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = null;
  _hasPendingAutoSave = false;
}

function flushAutoSaveIfPending() {
  if (_hasPendingAutoSave) {
    cancelScheduledAutoSave();
    autoSaveEntry();
  }
}

async function flushAllPendingSaves({ unload = false } = {}) {
  if (_sessionSaveTimer) {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = null;
    saveActiveSession();
  }
  flushAutoSaveIfPending();
  await syncToCloud({ unload });
}

function saveActiveSession() {
  if (_sessionSaveTimer) {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = null;
  }
  _pendingActiveSession = buildActiveSessionSnapshot();
  _dirtySession = true;
  if (AppState.authenticated) {
    updateSyncIndicator('saving');
    scheduleCloudSync(300);
  }
}

/**
 * Restore active editor and evaluation state from a cloud session snapshot.
 * @returns {boolean} true if session was restored, false otherwise
 */
function restoreActiveSession(sessionData) {
  if (!sessionData || typeof sessionData !== 'object') return false;
  try {
    const session = sessionData;

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
    AppState.textBeforeHone = session.textBeforeHone ?? null;
    AppState.errorsBeforeHone = session.errorsBeforeHone || [];
    AppState.appliedFixesBeforeHone = session.appliedFixesBeforeHone || [];
    AppState.overallScoreBeforeHone = session.overallScoreBeforeHone ?? null;
    AppState.summaryBeforeHone = session.summaryBeforeHone || '';
    AppState.evaluatedOnce = (
      AppState.overallScore !== null ||
      AppState.errors.length > 0 ||
      AppState.overallScoreBeforeHone !== null
    );
    AppState.rewrittenOnce = (AppState.rewriteSentences && AppState.rewriteSentences.length > 0);
    AppState.honedOnce = (AppState.honedText !== null);

    // Render components
    updateCounts();

    if (AppState.inRewriteMode) {
      if (DOM.textarea) DOM.textarea.readOnly = false;
      if (DOM.highlightLayer) DOM.highlightLayer.removeAttribute('aria-hidden');
      if (DOM.rewriteBanner) DOM.rewriteBanner.style.display = 'flex';
      if (DOM.honeBanner) DOM.honeBanner.style.display = 'none';
      DOM.journalContainer?.classList.remove('view-hone');
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
      if (DOM.textarea) DOM.textarea.readOnly = true;
      if (DOM.highlightLayer) DOM.highlightLayer.setAttribute('aria-hidden', 'true');
      if (DOM.rewriteBanner) DOM.rewriteBanner.style.display = 'none';
      if (DOM.honeBanner) DOM.honeBanner.style.display = 'flex';
      DOM.journalContainer?.classList.remove('view-rewrite');
      DOM.journalContainer?.classList.add('view-hone');
      renderHighlights(DOM.textarea.value, [], []);
      renderHoneResults(AppState.honeImprovements);
    } else {
      if (DOM.textarea) DOM.textarea.readOnly = false;
      if (DOM.highlightLayer) DOM.highlightLayer.setAttribute('aria-hidden', 'true');
      if (DOM.rewriteBanner) DOM.rewriteBanner.style.display = 'none';
      if (DOM.honeBanner) DOM.honeBanner.style.display = 'none';
      DOM.journalContainer?.classList.remove('view-rewrite');
      DOM.journalContainer?.classList.remove('view-hone');
      renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
      renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
    }

    // Sync sidebars & active history item highlight
    renderHistory();
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

  // Add has-popover class on shared editor surface so both layers gain bottom scroll clearance
  DOM.editorSurface?.classList.add('has-popover');

  const popover = document.createElement('div');
  popover.className = 'mobile-popover';
  popover.innerHTML = `
    <button class="popover-close-btn" aria-label="Close">&times;</button>
    <span class="error-badge ${typeClass}">${typeName}</span>
    <div class="correction-original"><del>${escapeHTML(err.original || '')}</del></div>
    <div class="correction-suggestion"><ins>${escapeHTML(err.suggestion || '')}</ins></div>
    <p class="correction-explanation">${escapeHTML(err.explanation || '')}</p>
    <div class="correction-card-actions">
      <button class="btn btn-apply-fix" data-popover-fix-index="${errorIndex}">Apply Fix</button>
      <button class="btn btn-dismiss-fix" data-popover-dismiss-index="${errorIndex}">Dismiss</button>
    </div>
  `;

  // Append to document.body so it escapes all overflow:hidden ancestors
  document.body.appendChild(popover);

  // --- Position using viewport coordinates ---
  const popoverWidth = popover.offsetWidth || 290;
  const popoverHeight = popover.offsetHeight || 200;

  const updatePopoverPosition = () => {
    const r = markEl.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const headerEl = document.querySelector('.app-header');
    const footerEl = document.querySelector('.journal-footer');
    const headerBottom = headerEl ? headerEl.getBoundingClientRect().bottom : 0;
    const footerTop = footerEl ? footerEl.getBoundingClientRect().top : viewportH;

    // Horizontal: center on the mark, clamped to viewport
    const markCenter = r.left + r.width / 2;
    let newLeft = markCenter - popoverWidth / 2;
    newLeft = Math.max(12, Math.min(newLeft, viewportW - popoverWidth - 12));
    popover.style.left = `${newLeft}px`;

    // Arrow positioning
    let arrowLeft = markCenter - newLeft;
    // Clamp arrow so it doesn't go outside the popover's border radius
    arrowLeft = Math.max(16, Math.min(arrowLeft, popoverWidth - 16));
    popover.style.setProperty('--arrow-left', `${arrowLeft}px`);

    // Vertical: prefer above the mark; fall below if not enough room
    const margin = 10;
    const spaceAbove = r.top - headerBottom;
    const spaceBelow = footerTop - r.bottom;

    let newTop;
    let placeBelow = false;

    if (spaceAbove >= popoverHeight + margin) {
      newTop = r.top - popoverHeight - margin;
      popover.style.maxHeight = '';
      popover.style.overflowY = '';
    } else if (spaceBelow >= popoverHeight + margin) {
      newTop = r.bottom + margin;
      placeBelow = true;
      popover.style.maxHeight = '';
      popover.style.overflowY = '';
    } else {
      if (spaceAbove > spaceBelow) {
        newTop = headerBottom + margin;
        popover.style.maxHeight = `${Math.max(0, spaceAbove - margin * 2)}px`;
      } else {
        newTop = r.bottom + margin;
        popover.style.maxHeight = `${Math.max(0, spaceBelow - margin * 2)}px`;
        placeBelow = true;
      }
      popover.style.overflowY = 'auto';
    }

    popover.style.top = `${newTop}px`;

    if (placeBelow) {
      popover.classList.add('popover-below');
    } else {
      popover.classList.remove('popover-below');
    }
    
    return placeBelow;
  };

  const initialPlaceBelow = updatePopoverPosition();

  const scrollEl = DOM.editorScroll || DOM.textarea;

  // Scroll to bring the mark and popover into clear view with adaptive scroll alignment
  if (scrollEl) {
    const containerHeight = scrollEl.clientHeight;
    let targetScrollTop;
    if (initialPlaceBelow) {
      // Popover is below: keep mark near top (~15%) so there is maximum room below
      targetScrollTop = markEl.offsetTop - (containerHeight * 0.15);
    } else {
      // Popover is above: keep mark near bottom (~70%) so there is maximum room above
      targetScrollTop = markEl.offsetTop - (containerHeight * 0.70);
    }
    scrollEl.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });
  }

  // Reposition on scroll so the popover tracks the mark
  const repositionHandler = () => {
    updatePopoverPosition();
  };
  scrollEl?.addEventListener('scroll', repositionHandler, { passive: true });
  popover._repositionHandler = repositionHandler;
  popover._scrollEl = scrollEl;

  // Bind close button click
  popover.querySelector('.popover-close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    removeMobilePopover();
  });

  const popoverErrUid = ensureErrorUid(err);

  // Bind apply fix button click
  popover.querySelector('[data-popover-fix-index]').addEventListener('click', (e) => {
    e.stopPropagation();
    removeMobilePopover();
    animateApplyFix(popoverErrUid);
  });

  // Bind dismiss button click
  popover.querySelector('[data-popover-dismiss-index]').addEventListener('click', (e) => {
    e.stopPropagation();
    removeMobilePopover();
    animateDismissFix(popoverErrUid);
  });
}

/**
 * Remove the mobile floating popover if it exists.
 */
function removeMobilePopover() {
  const popover = document.body.querySelector('.mobile-popover');
  if (popover) {
    if (popover._repositionHandler) {
      (popover._scrollEl || DOM.editorScroll || DOM.textarea)?.removeEventListener('scroll', popover._repositionHandler);
    }
    popover.remove();
  }
  DOM.editorSurface?.classList.remove('has-popover');
}

/* --------------------------------------------------------------------------
   15. EVENT LISTENERS
   -------------------------------------------------------------------------- */

function setupEventListeners() {
  DOM.authForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    loginWithUsername(DOM.authUsernameInput?.value || '');
  });

  DOM.btnLogout?.addEventListener('click', () => logout());
  DOM.btnMobileLogout?.addEventListener('click', () => logout());

  // Dismiss mobile popover when clicking outside
  document.addEventListener('click', (e) => {
    const popover = document.body.querySelector('.mobile-popover');
    if (popover && !popover.contains(e.target) && !e.target.closest('mark[data-error-index]')) {
      removeMobilePopover();
    }
  });

  // --- Textarea events ---
  DOM.textarea?.addEventListener('input', () => {
    const hadAnalysisState = (
      AppState.inRewriteMode ||
      AppState.inHoneMode ||
      AppState.errors.length > 0 ||
      AppState.appliedFixes.length > 0 ||
      AppState.rewriteSentences.length > 0 ||
      AppState.honedText !== null ||
      AppState.overallScore !== null ||
      AppState.evaluatedOnce ||
      AppState.rewrittenOnce ||
      AppState.honedOnce
    );

    if (hadAnalysisState) {
      cancelPendingFixAnimations();
      if (AppState.inRewriteMode) {
        exitRewriteMode(false);
      }
      if (AppState.inHoneMode) {
        exitHoneMode(false);
      }
      AppState.rewriteSentences = [];
      AppState.rewriteOriginalText = null;
      AppState.honedText = null;
      AppState.honeImprovements = [];
      AppState.errors = [];
      AppState.appliedFixes = [];
      AppState.overallScore = null;
      AppState.summary = '';
      AppState.evaluatedOnce = false;
      AppState.rewrittenOnce = false;
      AppState.honedOnce = false;
      clearCorrections();
    }

    updateCounts();
    renderHighlights(DOM.textarea.value, [], []);
    scheduleSaveActiveSession();
    scheduleAutoSaveEntry();
  });

  // Safety guard: forward any browser-internal textarea scroll to the shared viewport
  DOM.textarea?.addEventListener('scroll', () => {
    if (DOM.textarea.scrollTop && DOM.editorScroll) {
      DOM.editorScroll.scrollTop += DOM.textarea.scrollTop;
      DOM.textarea.scrollTop = 0;
    }
    if (DOM.textarea.scrollLeft) {
      DOM.textarea.scrollLeft = 0;
    }
  });

  DOM.textarea?.addEventListener('mouseup', syncActiveCorrectionCardFromCaret);
  DOM.textarea?.addEventListener('keyup', syncActiveCorrectionCardFromCaret);

  // Flush debounced session/entry writes when leaving or hiding the page
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && AppState.authenticated) {
      flushAllPendingSaves({ unload: false });
    }
  });
  window.addEventListener('pagehide', () => flushAllPendingSaves({ unload: true }));
  window.addEventListener('beforeunload', () => flushAllPendingSaves({ unload: true }));

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
  DOM.btnCopyText?.addEventListener('click', copyCurrentText);

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

  // --- Delegated click: Apply All in summary bar ---
  DOM.summaryText?.addEventListener('click', (e) => {
    const applyAllBtn = e.target.closest('[data-action="apply-all"]');
    if (applyAllBtn) {
      applyAllFixes();
    }
  });

  // --- Delegated click: Apply Fix / Dismiss in correction cards ---
  DOM.correctionsList?.addEventListener('click', (e) => {
    const fixBtn = e.target.closest('[data-fix-uid], [data-fix-index]');
    if (fixBtn) {
      const target = fixBtn.dataset.fixUid || parseInt(fixBtn.dataset.fixIndex, 10);
      animateApplyFix(target);
      return;
    }
    const dismissBtn = e.target.closest('[data-dismiss-uid], [data-dismiss-index]');
    if (dismissBtn) {
      const target = dismissBtn.dataset.dismissUid || parseInt(dismissBtn.dataset.dismissIndex, 10);
      animateDismissFix(target);
    }
  });

  // --- Delegated hover: highlight corresponding target mark (deduped across card children) ---
  let hoveredErrorIndex = null;

  const setHoveredMark = (nextIndex) => {
    if (hoveredErrorIndex === nextIndex) return;
    if (hoveredErrorIndex !== null) {
      DOM.highlightLayer
        ?.querySelector(`mark[data-error-index="${hoveredErrorIndex}"]`)
        ?.classList.remove('mark-hover');
    }
    hoveredErrorIndex = nextIndex;
    if (hoveredErrorIndex !== null) {
      DOM.highlightLayer
        ?.querySelector(`mark[data-error-index="${hoveredErrorIndex}"]`)
        ?.classList.add('mark-hover');
    }
  };

  DOM.correctionsList?.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.correction-card[data-error-index]');
    if (!card) return;
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    setHoveredMark(card.getAttribute('data-error-index'));
  });

  DOM.correctionsList?.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.correction-card[data-error-index]');
    if (!card) return;
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    if (hoveredErrorIndex === card.getAttribute('data-error-index')) {
      setHoveredMark(null);
    }
  });

  DOM.correctionsList?.addEventListener('mouseleave', () => {
    setHoveredMark(null);
  });

  // --- Prevent focus loss (blur) when clicking non-focusable elements inside interleaved block ---
  DOM.highlightLayer?.addEventListener('mousedown', (e) => {
    if (!AppState.inRewriteMode) return;
    
    // If they clicked a mark, TTS speaker button, or waveform panel, let their handlers run naturally
    if (
      e.target.closest('.mark-applied-fix') ||
      e.target.closest('mark[data-error-index]') ||
      e.target.closest('.btn-tts-play') ||
      e.target.closest('.tts-waveform-panel')
    ) {
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
        // Allow text selection inside .interleaved-rewritten; only prevent blur on non-focusable areas
        if (!e.target.closest('.interleaved-rewritten')) {
          e.preventDefault();
        }
        activateRewriteBlock(idx, true);
      }
    }
  });

  // --- Waveform pointer scrubbing ---
  let _scrubPointerId = null;
  DOM.highlightLayer?.addEventListener('pointerdown', (e) => {
    const stageEl = e.target.closest('.tts-waveform-stage');
    if (!stageEl || !AppState.inRewriteMode) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!waveformState.isReady || !(currentAudio instanceof Audio)) return;

    e.stopPropagation();
    waveformState.isScrubbing = true;
    _scrubPointerId = e.pointerId;
    if (typeof stageEl.setPointerCapture === 'function') {
      try {
        stageEl.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    scrubWaveformToClientX(e.clientX);
  });

  DOM.highlightLayer?.addEventListener('pointermove', (e) => {
    if (!waveformState.isScrubbing) return;
    if (_scrubPointerId !== null && e.pointerId !== _scrubPointerId) return;
    scrubWaveformToClientX(e.clientX);
  });

  const endWaveformScrub = (e) => {
    if (!waveformState.isScrubbing) return;
    if (_scrubPointerId !== null && e.pointerId !== undefined && e.pointerId !== _scrubPointerId) return;
    waveformState.isScrubbing = false;
    _scrubPointerId = null;
    if (waveformState.stageEl && e.pointerId !== undefined && typeof waveformState.stageEl.releasePointerCapture === 'function') {
      try {
        waveformState.stageEl.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
    enforceABLoopIfNeeded();
    updateWaveformTimeDisplay();
    drawWaveformCanvas();
  };

  DOM.highlightLayer?.addEventListener('pointerup', endWaveformScrub);
  DOM.highlightLayer?.addEventListener('pointercancel', endWaveformScrub);

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

    // Clicked playback speed button inside the open waveform panel
    const speedBtn = e.target.closest('.btn-tts-speed');
    if (speedBtn) {
      e.stopPropagation();
      cyclePlaybackSpeed();
      return;
    }

    // Clicked anywhere else inside the open waveform panel (e.g. stage after scrub)
    const waveformPanel = e.target.closest('.tts-waveform-panel');
    if (waveformPanel) {
      e.stopPropagation();
      const blockEl = waveformPanel.closest('.interleaved-block');
      if (blockEl) {
        const idx = parseInt(blockEl.getAttribute('data-index'), 10);
        if (!Number.isNaN(idx) && AppState.activeRewriteIndex !== idx) {
          activateRewriteBlock(idx, false);
        }
      }
      return;
    }

    // Clicked the explicit TTS speaker button inside a rewritten sentence
    const ttsBtn = e.target.closest('.btn-tts-play');
    if (ttsBtn) {
      e.stopPropagation();
      const blockEl = ttsBtn.closest('.interleaved-block');
      const rewrittenEl = ttsBtn.closest('.interleaved-rewritten');
      let text = '';
      let idx = null;
      if (blockEl) {
        idx = parseInt(blockEl.getAttribute('data-index'), 10);
        activateRewriteBlock(idx, false);
        text = (AppState.rewriteSentences[idx]?.rewritten || '').trim();
      }
      if (!text && rewrittenEl) {
        const textEl = rewrittenEl.querySelector('.interleaved-rewritten-text') || rewrittenEl;
        text = textEl.textContent.trim();
      }
      if (text && rewrittenEl) {
        playTTS(text, rewrittenEl, idx);
      }
      return;
    }

    // Clicking a rewritten sentence selects it for sidebar explanation only (no auto-TTS)
    const rewrittenEl = e.target.closest('.interleaved-rewritten');
    if (rewrittenEl) {
      e.stopPropagation();
      const blockEl = rewrittenEl.closest('.interleaved-block');
      if (blockEl) {
        const idx = parseInt(blockEl.getAttribute('data-index'), 10);
        activateRewriteBlock(idx, true);
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

  // --- Waveform & A-B loop keyboard shortcuts (capture phase prevents Space scroll / button double-fire) ---
  document.addEventListener('keydown', (e) => {
    if (!AppState.authenticated || !AppState.inRewriteMode) return;
    if (waveformState.sentenceIndex === null || !waveformState.isReady) return;
    if (!(currentAudio instanceof Audio)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }

    const key = e.key;
    if (key === ' ' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      toggleWaveformPlayPause();
      return;
    }

    const lower = key ? key.toLowerCase() : '';
    if (lower === 'a' || lower === 'b' || lower === 'x') {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (lower === 'a') {
        toggleLoopPoint('A');
      } else if (lower === 'b') {
        toggleLoopPoint('B');
      } else {
        clearABLoop();
      }
    }
  }, true);

  document.addEventListener('keyup', (e) => {
    if (!AppState.authenticated || !AppState.inRewriteMode) return;
    if (waveformState.sentenceIndex === null || !waveformState.isReady) return;
    if (!(currentAudio instanceof Audio)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    if (!AppState.authenticated) return;

    // Ctrl+S / Cmd+S — Save immediately to cloud
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      autoSaveEntry();
      flushAllPendingSaves({ unload: false });
      showToast('Saved to cloud.', 'success');
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

}

/**
 * On desktop, highlight and scroll to the matching sidebar correction card
 * when the user clicks or moves the caret into an error span in the textarea.
 */
function syncActiveCorrectionCardFromCaret() {
  if (!DOM.textarea || !DOM.correctionsList) return;
  if (window.innerWidth <= 1024 || AppState.inRewriteMode || AppState.inHoneMode || !AppState.errors.length) {
    return;
  }

  const selStart = DOM.textarea.selectionStart;
  const selEnd   = DOM.textarea.selectionEnd;
  const matchedIndex = AppState.errors.findIndex(
    (err) => selStart <= err.end && selEnd >= err.start
  );

  let cardToScroll = null;
  const cards = DOM.correctionsList.querySelectorAll('.correction-card[data-error-index]');
  cards.forEach((card) => {
    const idx = parseInt(card.getAttribute('data-error-index'), 10);
    const shouldBeActive = idx === matchedIndex;
    const wasActive = card.classList.contains('card-active');
    card.classList.toggle('card-active', shouldBeActive);
    if (shouldBeActive && !wasActive) {
      cardToScroll = card;
    }
  });

  cardToScroll?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      if (e.type === 'touchend') {
        // Prevent ghost clicks and unwanted focus shifts (like the keyboard popping up) on mobile
        e.preventDefault();
        clickCallback(e);
      }
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
    // If it was a long press, or if touchend already handled it, don't do anything
    e.preventDefault();
    if (isLongPress) {
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
  'idle-reading': 'assets/marybeth/idle-reading-sm.webp',
  'evaluate':     'assets/marybeth/evaluate-sm.webp',
  'rewrite':      'assets/marybeth/rewrite-sm.webp',
  'hone':         'assets/marybeth/hone-sm.webp',
  'apply-fix':    'assets/marybeth/apply-fix-sm.webp',
};

let _maryBethPoseTimer = null;
let _maryBethSwapTimer = null;
let _maryBethPreloaded = false;

/**
 * Swap Mary-Beth's pose inside the loading overlay.
 * Skips hidden apply-fix swaps so fixing errors never triggers pointless image decoding.
 *
 * @param {string} pose — One of: 'idle-reading', 'evaluate', 'rewrite', 'hone', 'apply-fix'
 */
function setMaryBethPose(pose) {
  const sprite = DOM.maryBethSprite;
  const avatar = DOM.maryBethAvatar;
  if (!sprite || !avatar) return;

  if (pose === 'apply-fix' && !AppState.isLoading) {
    return;
  }

  const src = MARYBETH_POSES[pose];
  if (!src) return;

  if (_maryBethPoseTimer) {
    clearTimeout(_maryBethPoseTimer);
    _maryBethPoseTimer = null;
  }
  if (_maryBethSwapTimer) {
    clearTimeout(_maryBethSwapTimer);
    _maryBethSwapTimer = null;
  }

  const applyPose = () => {
    sprite.src = src;
    sprite.classList.remove('pose-swap');
    avatar.classList.toggle('pose-active', pose !== 'idle-reading');
    _maryBethSwapTimer = null;
  };

  if (!sprite.getAttribute('src') || sprite.getAttribute('src').startsWith('data:')) {
    applyPose();
  } else {
    sprite.classList.add('pose-swap');
    _maryBethSwapTimer = setTimeout(applyPose, 180);
  }

  if (pose === 'apply-fix') {
    _maryBethPoseTimer = setTimeout(() => {
      setMaryBethPose('idle-reading');
    }, 2000);
  }
}

/**
 * Lazily warm the small Mary-Beth sprites after initial page load completes.
 */
function preloadMaryBethImages() {
  if (_maryBethPreloaded) return;
  _maryBethPreloaded = true;
  Object.values(MARYBETH_POSES).forEach((src) => {
    const img = new Image();
    img.src = src;
  });
}

/* --------------------------------------------------------------------------
   17. AUTHENTICATION & INITIALIZATION
   -------------------------------------------------------------------------- */

function showAuthError(message) {
  if (!DOM.authError) return;
  if (!message) {
    DOM.authError.textContent = '';
    DOM.authError.hidden = true;
  } else {
    DOM.authError.textContent = message;
    DOM.authError.hidden = false;
  }
}

function setAuthFormVisible(visible, errorMessage = '') {
  if (DOM.authChecking) DOM.authChecking.hidden = visible;
  if (DOM.authForm) DOM.authForm.hidden = !visible;
  showAuthError(errorMessage);
  if (visible && DOM.authUsernameInput) {
    setTimeout(() => DOM.authUsernameInput?.focus(), 0);
  }
}

function resetWorkspaceUI() {
  cancelPendingFixAnimations();
  cancelScheduledAutoSave();
  clearTimeout(_sessionSaveTimer);
  clearTimeout(_cloudSyncTimer);
  _sessionSaveTimer = null;
  _cloudSyncTimer = null;
  _dirtyEntries = false;
  _dirtySession = false;
  _pendingActiveSession = null;
  _entriesCache = [];

  stopCurrentAudio();

  AppState.currentEntryId = null;
  AppState.errors = [];
  AppState.appliedFixes = [];
  AppState.history = [];
  AppState.isLoading = false;
  AppState.activeOperation = null;
  AppState.overallScore = null;
  AppState.summary = '';
  AppState.lastRestoredError = null;
  AppState.inRewriteMode = false;
  AppState.rewriteSentences = [];
  AppState.rewriteOriginalText = null;
  AppState.activeRewriteIndex = null;
  AppState.honedText = null;
  AppState.honeImprovements = [];
  AppState.inHoneMode = false;
  AppState.evaluatedOnce = false;
  AppState.rewrittenOnce = false;
  AppState.honedOnce = false;
  AppState.textBeforeHone = null;
  AppState.errorsBeforeHone = [];
  AppState.appliedFixesBeforeHone = [];
  AppState.overallScoreBeforeHone = null;
  AppState.summaryBeforeHone = '';

  if (DOM.textarea) {
    DOM.textarea.value = '';
    DOM.textarea.readOnly = false;
  }
  if (DOM.highlightLayer) {
    DOM.highlightLayer.textContent = '';
    DOM.highlightLayer.setAttribute('aria-hidden', 'true');
  }
  if (DOM.rewriteBanner) DOM.rewriteBanner.style.display = 'none';
  if (DOM.honeBanner) DOM.honeBanner.style.display = 'none';
  DOM.journalContainer?.classList.remove('view-rewrite', 'view-hone');
  if (DOM.historyList) DOM.historyList.innerHTML = '';
  clearCorrections();
  updateCounts();
  closeSidebars();
  removeMobilePopover();
}

function lockWorkspace(errorMessage = '') {
  AppState.authenticated = false;
  AppState.username = null;
  resetWorkspaceUI();
  if (DOM.headerUser) DOM.headerUser.hidden = true;
  if (DOM.sidebarAccountRow) DOM.sidebarAccountRow.hidden = true;
  if (DOM.headerUsername) DOM.headerUsername.textContent = '';
  if (DOM.mobileUsername) DOM.mobileUsername.textContent = '';
  document.body?.classList?.add('auth-locked');
  setAuthFormVisible(true, errorMessage);
}

function handleSessionExpired() {
  if (!AppState.authenticated) return;
  lockWorkspace('Your session expired. Sign in again to continue.');
}

/**
 * If this account still has its untouched onboarding seed and the browser
 * holds older non-default localStorage drafts, migrate them to the cloud once,
 * then always wipe legacy browser storage keys.
 */
function migrateAndClearLegacyLocalStorage(serverData) {
  let adopted = false;
  if (typeof localStorage === 'undefined') {
    return { entries: serverData.entries, activeSession: serverData.active_session, adopted };
  }

  let legacyEntries = null;
  let legacySession = null;
  try {
    const rawEntries = localStorage.getItem('rdo_entries');
    const rawSession = localStorage.getItem('rde_active_session');
    if (rawEntries) {
      const parsed = JSON.parse(rawEntries);
      if (Array.isArray(parsed)) legacyEntries = parsed;
    }
    if (rawSession) {
      const parsedS = JSON.parse(rawSession);
      if (parsedS && typeof parsedS === 'object') legacySession = parsedS;
    }

    const hasCustomEntries = Array.isArray(legacyEntries) && (
      legacyEntries.length !== 1 ||
      legacyEntries[0]?.id !== 'seed_crush_diary' ||
      legacyEntries[0]?.text !== DEFAULT_ENTRY_TEXT
    );
    const hasCustomSession = !!(legacySession && (
      legacySession.text !== DEFAULT_ENTRY_TEXT ||
      (legacySession.errors && legacySession.errors.length > 0) ||
      (legacySession.appliedFixes && legacySession.appliedFixes.length > 0) ||
      (legacySession.rewriteSentences && legacySession.rewriteSentences.length > 0) ||
      legacySession.honedText
    ));

    if (serverData.is_fresh_seed && (hasCustomEntries || hasCustomSession)) {
      adopted = true;
      return {
        entries: legacyEntries && legacyEntries.length > 0 ? legacyEntries : serverData.entries,
        activeSession: legacySession || serverData.active_session,
        adopted: true,
      };
    }
  } catch (_) {
    // Ignore corrupt legacy storage
  } finally {
    try {
      localStorage.removeItem('rdo_entries');
      localStorage.removeItem('rde_active_session');
      localStorage.removeItem('rde_seeded_diary_v5');
    } catch (_) {}
  }

  return {
    entries: serverData.entries,
    activeSession: serverData.active_session,
    adopted,
  };
}

function hydrateWorkspaceFromServer(data) {
  AppState.authenticated = true;
  AppState.username = data.username || '';

  if (DOM.headerUsername) DOM.headerUsername.textContent = AppState.username;
  if (DOM.mobileUsername) DOM.mobileUsername.textContent = AppState.username;
  if (DOM.headerUser) DOM.headerUser.hidden = false;
  if (DOM.sidebarAccountRow) DOM.sidebarAccountRow.hidden = false;
  updateSyncIndicator('saved');

  document.body?.classList?.remove('auth-locked');
  showAuthError('');

  const { entries, activeSession, adopted } = migrateAndClearLegacyLocalStorage(data);
  _entriesCache = Array.isArray(entries) ? entries : [];
  AppState.history = _entriesCache;

  const restored = restoreActiveSession(activeSession);
  if (_entriesCache.length === 0 && !restored) {
    newEntry(false, { skipFlush: true, skipSync: true, skipFocus: true });
  } else if (!restored) {
    loadEntry(_entriesCache[0].id, { skipFlush: true, skipSync: true });
  } else {
    renderHistory();
  }

  updateButtonStates();
  updateCounts();

  if (adopted) {
    _dirtyEntries = true;
    _pendingActiveSession = activeSession || buildActiveSessionSnapshot();
    _dirtySession = true;
    syncToCloud();
    showToast('Synced previous browser entries to your cloud account.', 'info');
  }
}

async function loginWithUsername(rawUsername) {
  const trimmed = (rawUsername || '').trim();
  if (!trimmed) {
    showAuthError('Please enter your username.');
    DOM.authUsernameInput?.focus();
    return;
  }

  if (DOM.btnAuthSubmit) {
    DOM.btnAuthSubmit.disabled = true;
    DOM.btnAuthSubmit.textContent = 'Unlocking...';
  }
  showAuthError('');

  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: trimmed }),
      skipAuthCheck: true,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.authenticated) {
      showAuthError(data.detail || 'Unrecognized username.');
      DOM.authUsernameInput?.focus();
      DOM.authUsernameInput?.select();
      return;
    }
    if (DOM.authUsernameInput) DOM.authUsernameInput.value = '';
    hydrateWorkspaceFromServer(data);
    showToast(`Welcome back, ${data.username}.`, 'success');
  } catch (err) {
    console.error('Login error:', err);
    showAuthError('Could not connect to server. Please try again.');
  } finally {
    if (DOM.btnAuthSubmit) {
      DOM.btnAuthSubmit.disabled = false;
      DOM.btnAuthSubmit.textContent = 'Unlock Journal';
    }
  }
}

async function logout() {
  if (AppState.authenticated) {
    await flushAllPendingSaves({ unload: false });
  }
  try {
    await apiFetch('/api/auth/logout', { method: 'POST', skipAuthCheck: true });
  } catch (_) {}
  lockWorkspace('');
  showToast('Signed out.', 'info');
}

async function checkInitialSession() {
  setAuthFormVisible(false, '');
  try {
    const res = await apiFetch('/api/auth/me', { method: 'GET', skipAuthCheck: true });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data && data.authenticated) {
      hydrateWorkspaceFromServer(data);
    } else {
      setAuthFormVisible(true, '');
    }
  } catch (err) {
    console.error('Initial auth check failed:', err);
    setAuthFormVisible(true, 'Could not reach server. Please try signing in.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initDOMReferences();
  updateCounts();
  setupEventListeners();
  updateButtonStates();

  checkInitialSession();

  // Warm small Mary-Beth sprites only after initial load goes idle
  window.addEventListener('load', () => {
    const schedulePreload = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    schedulePreload(preloadMaryBethImages);
  }, { once: true });

  console.log(
    '%c🤠 Red Dead Editor loaded. Write well, partner.',
    'color: #c7a44a; font-family: Georgia, serif; font-size: 14px;'
  );
});
