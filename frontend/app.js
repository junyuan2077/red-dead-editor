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
  activeRewriteIndex:    null,
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
      itemStart = text.indexOf(originalText, cursor);
      let matchedLength = originalText.length;
      
      if (itemStart === -1) {
        const prefix = originalText.trim().substring(0, 30);
        const tempIndex = text.indexOf(prefix, cursor);
        if (tempIndex !== -1) {
          itemStart = tempIndex;
          matchedLength = Math.min(originalText.length, text.length - itemStart);
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
      const sepText = text.substring(cursor, itemStart);
      if (sepText.trim() || sepText.includes('\n')) {
        html += `<div class="interleaved-separator">${escapeHTML(sepText).replace(/\n/g, '<br>')}</div>`;
      }
    }
    
    const originalHtml = renderSubstringWithHighlights(text, itemStart, itemEnd, errors, appliedFixes);
    
    const isActive = (i === AppState.activeRewriteIndex);
    html += `
      <div class="interleaved-block${isActive ? ' active-block' : ''}" data-index="${i}">
        <div class="interleaved-original">${originalHtml}</div>
        <div class="interleaved-rewritten" tabindex="0">${escapeHTML(item.rewritten)}</div>
      </div>`;
      
    cursor = itemEnd;
  }
  
  if (cursor < text.length) {
    const sepText = text.substring(cursor);
    if (sepText.trim() || sepText.includes('\n')) {
      html += `<div class="interleaved-separator">${escapeHTML(sepText).replace(/\n/g, '<br>')}</div>`;
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
  
  // Auto-open corrections sidebar on mobile
  if (window.innerWidth <= 1024) {
    openCorrectionsSidebar();
  }
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
async function evaluate() {
  if (AppState.inRewriteMode) {
    exitRewriteMode();
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

    // Render highlights on the overlay
    renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);

    // Render corrections sidebar
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary, true);

    // On mobile, auto-open corrections sidebar
    if (window.innerWidth <= 1024) {
      openCorrectionsSidebar();
    }

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

async function rewrite() {
  // Toggle: if already in rewrite mode, exit back to editor
  if (AppState.inRewriteMode) {
    exitRewriteMode();
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
}

/**
 * Exit the rewrite view mode and return to standard editor.
 */
function exitRewriteMode() {
  AppState.inRewriteMode = false;
  AppState.rewriteSentences = [];
  AppState.activeRewriteIndex = null;

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
}

/**
 * HONE — Polish the entire text.
 */
async function hone() {
  if (AppState.inRewriteMode) {
    exitRewriteMode();
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

    DOM.textarea.value = honed;

    // Clear stale errors
    AppState.errors = [];
    AppState.appliedFixes = [];
    renderHighlights(honed, [], []);
    updateCounts();

    // Show improvements
    renderHoneResults(data.improvements || []);

    // On mobile, show corrections
    if (window.innerWidth <= 1024) {
      openCorrectionsSidebar();
    }

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

/* --------------------------------------------------------------------------
   8. TTS PLAYBACK
   -------------------------------------------------------------------------- */



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
  if (AppState.inRewriteMode) {
    exitRewriteMode();
  }
  const entries = getEntries();
  const entry   = entries.find((e) => e.id === id);
  if (!entry) return;

  DOM.textarea.value      = entry.text || '';
  AppState.currentEntryId = entry.id;

  // Clear stale evaluation data
  AppState.errors = [];
  AppState.appliedFixes = [];
  renderHighlights(entry.text || '', [], []);
  updateCounts();
  clearCorrections();
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
  DOM.textarea.value      = '';
  AppState.currentEntryId = null;
  AppState.errors         = [];
  AppState.appliedFixes   = [];
  AppState.overallScore   = null;
  AppState.summary        = '';

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
  input.style.fontSize = 'inherit';
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

  if (DOM.btnEvaluate) {
    DOM.btnEvaluate.disabled = isLoading;
  }
  if (DOM.btnRewrite) {
    // Keep enabled in rewrite mode so it can toggle back to editor
    DOM.btnRewrite.disabled = AppState.inRewriteMode ? false : (isLoading || hasErrors);
  }
  if (DOM.btnHone) {
    DOM.btnHone.disabled = isLoading || hasErrors;
  }
}

/**
 * Automatically saves the current text to the journal entries in localStorage.
 */
function autoSaveEntry() {
  const text = DOM.textarea ? DOM.textarea.value : '';
  if (!text.trim()) {
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
      const typeClass = `error-${err.type || 'grammar'}`;
      
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
  const typeClass = `error-${err.type || 'grammar'}`;

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
  updateButtonStates();

  // Add loading class to the active button
  const buttons = [DOM.btnEvaluate, DOM.btnRewrite, DOM.btnHone];
  buttons.forEach((btn) => {
    if (btn) btn.disabled = AppState.isLoading;
  });

  buttons.forEach((btn) => {
    if (btn) btn.classList.remove('btn--loading');
  });

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
    historySidebarOpen: AppState.historySidebarOpen
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

    // Render components
    renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
    renderCorrections(AppState.errors, AppState.overallScore, AppState.summary);
    updateCounts();

    // Sync sidebars
    DOM.historySidebar?.classList.toggle('open', AppState.historySidebarOpen);
    DOM.correctionsSidebar?.classList.toggle('open', AppState.correctionsSidebarOpen);
    updateBackdrop();

    return true;
  } catch (err) {
    console.warn('Failed to restore active session:', err);
    return false;
  }
}

/**
 * Show a floating popover directly above the tapped error highlight on mobile.
 */
function showMobilePopover(markEl) {
  removeMobilePopover();

  const errorIndex = parseInt(markEl.getAttribute('data-error-index'), 10);
  const err = AppState.errors[errorIndex];
  if (!err) return;

  const typeName  = capitalize(err.type || 'grammar');
  const typeClass = `error-${err.type || 'grammar'}`;

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

  // Append popover to highlight layer so it scrolls with the text
  DOM.highlightLayer?.appendChild(popover);

  // Measure popover dimensions
  const popoverWidth = popover.offsetWidth || 280;
  const popoverHeight = popover.offsetHeight || 170;

  // Position it horizontally centered relative to the mark
  let left = markEl.offsetLeft + (markEl.offsetWidth - popoverWidth) / 2;
  // Prevent overflow outside the highlight layer boundaries
  const maxLeft = DOM.highlightLayer.clientWidth - popoverWidth - 16;
  left = Math.max(16, Math.min(left, maxLeft));

  // Adaptive vertical placement: place below if it overflows the top of the scroll container
  let top = markEl.offsetTop - popoverHeight - 12;
  const scrollTop = DOM.highlightLayer.scrollTop || 0;

  if (top < scrollTop) {
    top = markEl.offsetTop + markEl.offsetHeight + 12;
    popover.classList.add('popover-below');
  }

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  // Scroll to bring the mark and popover into a clear view
  if (DOM.textarea) {
    const containerHeight = DOM.textarea.clientHeight;
    const targetScrollTop = Math.max(0, markEl.offsetTop - containerHeight / 3);
    DOM.textarea.scrollTop = targetScrollTop;
  }

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
  const popover = DOM.highlightLayer?.querySelector('.mobile-popover');
  if (popover) {
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
    const popover = DOM.highlightLayer?.querySelector('.mobile-popover');
    if (popover && !popover.contains(e.target) && !e.target.closest('mark[data-error-index]')) {
      removeMobilePopover();
    }
  });

  // --- Textarea events ---
  DOM.textarea?.addEventListener('input', () => {
    if (AppState.inRewriteMode) {
      exitRewriteMode();
    }
    updateCounts();
    // Re-render highlights with current errors and applied fixes (keeps marks in sync with edits)
    renderHighlights(DOM.textarea.value, AppState.errors, AppState.appliedFixes);
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

  // --- Action buttons ---
  DOM.btnEvaluate?.addEventListener('click', evaluate);
  DOM.btnRewrite?.addEventListener('click', rewrite);
  DOM.btnHone?.addEventListener('click', hone);
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

  console.log(
    '%c🤠 Red Dead Editor loaded. Write well, partner.',
    'color: #c7a44a; font-family: Georgia, serif; font-size: 14px;'
  );
});
