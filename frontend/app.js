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

const DEFAULT_ENTRY_TEXT = 'Dear Diary,\nI think about him constantly. His presence always inflicts a warm, comforting feeling in my chest. Yesterday, we walked home together and he says something funny that made me blush. Every one of his small gestures make me forget my own name. I hope this puppy love is not unrequitted, although I am too shy to ask. The novel was finished by me last night under the starlight, and tears were shed by my eyes because the ending was so tragic. I wish I could tell him how I feel, but in my personal opinion, I think he might already know. His charm is completely irresistable. Even when he is just reading a book, he looks so handsome. Maybe tomorrow I will find the courage to talk to him more, rather than just staring from afar like a secret admirer.';

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
        <div class="interleaved-rewritten" tabindex="0"><span class="interleaved-rewritten-text">${escapeHTML(item.rewritten)}</span><button class="btn-tts-play" type="button" aria-label="Listen to rewritten sentence" title="Listen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button></div>
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
let currentAudio = null;
let currentAudioElement = null;

function stopCurrentAudio() {
  if (currentAudio) {
    try {
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
  currentAudio = null;
  currentAudioElement = null;
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

  // Stop any currently playing audio and revoke its object URL
  stopCurrentAudio();

  currentAudioElement = element;
  element.classList.add('audio-loading');

  let audioUrl = null;
  const cleanup = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
    if (currentAudio && currentAudio._objectUrl) {
      URL.revokeObjectURL(currentAudio._objectUrl);
      currentAudio._objectUrl = null;
    }
    element.classList.remove('audio-loading', 'audio-playing');
    if (currentAudioElement === element) {
      currentAudio = null;
      currentAudioElement = null;
    }
  };

  try {
    await audioCache.waitReady();
    if (currentAudioElement !== element) return;

    const cacheKey = `${TTS_CACHE_PREFIX}${text}`;
    let blob;
    if (audioCache.has(cacheKey)) {
      blob = audioCache.get(cacheKey);
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
        audioCache.set(cacheKey, blob);
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

    audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    audio._objectUrl = audioUrl;
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
   9. LOCALSTORAGE PERSISTENCE
   Journal entries are stored as a JSON array under STORAGE_KEY.
   -------------------------------------------------------------------------- */

/**
 * Generate a unique ID based on timestamp + random suffix.
 */
function generateId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
}

let _entriesCache = null;

function createSeedEntry() {
  return {
    id: 'seed_crush_diary',
    title: 'June 28, Sunday. Weather: Sunny day (晴天)',
    customTitle: true,
    text: DEFAULT_ENTRY_TEXT,
    date: new Date().toISOString(),
    wordCount: 142,
  };
}

/**
 * Initialize and return the in-memory journal entries cache (single v5 seed/migration).
 * @returns {Array}
 */
function initEntriesCache() {
  if (_entriesCache !== null) return _entriesCache;

  let entries = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!localStorage.getItem('rde_seeded_diary_v5')) {
      localStorage.setItem('rde_seeded_diary_v5', 'true');
      localStorage.removeItem('rde_active_session');
      if (raw) {
        entries = JSON.parse(raw).map((entry) =>
          entry.id === 'seed_crush_diary' ? createSeedEntry() : entry
        );
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      }
    }

    if (!entries) {
      if (!raw) {
        entries = [createSeedEntry()];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        localStorage.setItem('rde_seeded_diary_v5', 'true');
      } else {
        entries = JSON.parse(raw || '[]');
      }
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('rde_active_session');
    entries = [createSeedEntry()];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    localStorage.setItem('rde_seeded_diary_v5', 'true');
  }

  _entriesCache = Array.isArray(entries) ? entries : [];
  AppState.history = _entriesCache;
  return _entriesCache;
}

/**
 * Retrieve all saved entries from cache / localStorage.
 * @returns {Array}
 */
function getEntries() {
  return initEntriesCache();
}

/**
 * Persist journal entries to localStorage and keep in-memory cache synchronized.
 */
function persistEntries(entries) {
  _entriesCache = entries;
  AppState.history = _entriesCache;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * Load a saved entry into the editor.
 */
function loadEntry(id) {
  flushAutoSaveIfPending();
  cancelPendingFixAnimations();
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
  AppState.honedOnce = (AppState.honedText !== null);

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
  cancelScheduledAutoSave();
  const entries = getEntries();
  const deletedIndex = entries.findIndex((e) => e.id === id);
  if (deletedIndex === -1) return;

  const deletedEntry = entries[deletedIndex];
  const wasCurrent = AppState.currentEntryId === id;
  persistEntries(entries.filter((e) => e.id !== id));

  // If we just deleted the active entry, start a clean one without flushing deleted data
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
 * @param {boolean} isInit - If true and there are no entries, populates with DEFAULT_ENTRY_TEXT.
 *                           Otherwise, starts with a clean empty editor.
 */
function newEntry(isInit = false, options = {}) {
  if (!options.skipFlush) {
    flushAutoSaveIfPending();
  }
  cancelPendingFixAnimations();
  if (AppState.inRewriteMode) {
    exitRewriteMode();
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
 * Save current active editor and evaluation state to localStorage.
 */
let _sessionSaveTimer = null;
let _autoSaveTimer = null;
let _hasPendingAutoSave = false;

function scheduleSaveActiveSession(delayMs = 350) {
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

function flushAllPendingSaves() {
  if (_sessionSaveTimer) {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = null;
    saveActiveSession();
  }
  flushAutoSaveIfPending();
}

function saveActiveSession() {
  if (_sessionSaveTimer) {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = null;
  }
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
    honeImprovements: AppState.honeImprovements,
    textBeforeHone: AppState.textBeforeHone,
    errorsBeforeHone: AppState.errorsBeforeHone,
    appliedFixesBeforeHone: AppState.appliedFixesBeforeHone,
    overallScoreBeforeHone: AppState.overallScoreBeforeHone,
    summaryBeforeHone: AppState.summaryBeforeHone
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
    if (document.visibilityState === 'hidden') {
      flushAllPendingSaves();
    }
  });
  window.addEventListener('pagehide', flushAllPendingSaves);
  window.addEventListener('beforeunload', flushAllPendingSaves);

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
    
    // If they clicked a mark or the explicit TTS speaker button, let the click handler run naturally
    if (
      e.target.closest('.mark-applied-fix') ||
      e.target.closest('mark[data-error-index]') ||
      e.target.closest('.btn-tts-play')
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

    // Clicked the explicit TTS speaker button inside a rewritten sentence
    const ttsBtn = e.target.closest('.btn-tts-play');
    if (ttsBtn) {
      e.stopPropagation();
      const blockEl = ttsBtn.closest('.interleaved-block');
      const rewrittenEl = ttsBtn.closest('.interleaved-rewritten');
      let text = '';
      if (blockEl) {
        const idx = parseInt(blockEl.getAttribute('data-index'), 10);
        activateRewriteBlock(idx, false);
        text = (AppState.rewriteSentences[idx]?.rewritten || '').trim();
      }
      if (!text && rewrittenEl) {
        const textEl = rewrittenEl.querySelector('.interleaved-rewritten-text') || rewrittenEl;
        text = textEl.textContent.trim();
      }
      if (text && rewrittenEl) {
        playTTS(text, rewrittenEl);
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
   17. INITIALIZATION
   -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  initDOMReferences();
  updateCounts();

  const entries = initEntriesCache();
  const restored = restoreActiveSession();
  if (entries.length === 0) {
    newEntry(true);
  } else if (!restored) {
    loadEntry(entries[0].id);
  } else {
    renderHistory();
  }

  setupEventListeners();
  updateButtonStates();

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
