const textInput = document.getElementById('text-input');
const highlightLayer = document.getElementById('highlight-layer');
const rewriteLayer = document.getElementById('rewrite-layer');
const evaluateBtn = document.getElementById('evaluate-btn');
const rewriteBtn = document.getElementById('rewrite-btn');
const honeBtn = document.getElementById('hone-btn');
const correctionsList = document.getElementById('corrections-list');
const historyList = document.getElementById('history-list');
const newStoryBtn = document.getElementById('new-story-btn');
const loadingOverlay = document.getElementById('loading-overlay');

// ─── State Management ─────────────────────────────────────────────────────────

class AppState {
    constructor() {
        this.corrections = [];
        this.rewrites = null;
        this.hones = null;
        this.isRewriteMode = false;
        this.hasEvaluated = false;
        this.originalText = "";
        this.storyId = null;
        this.abortController = null;
    }

    /** Reset to a blank-story state and assign a fresh story ID. */
    reset() {
        this.corrections = [];
        this.rewrites = null;
        this.hones = null;
        this.isRewriteMode = false;
        this.hasEvaluated = false;
        this.originalText = "";
        this.storyId = generateId();
        this.abortController = null;
    }

    /** Restore all fields from a persisted story object (from localStorage). */
    loadFrom(story) {
        this.corrections = story.corrections || [];
        this.rewrites = story.rewrites || null;
        this.hones = story.hones || null;
        this.isRewriteMode = story.isRewriteMode || false;
        this.hasEvaluated = story.hasEvaluated || false;
        this.originalText = story.text;
    }

    /** Produce the serialisable snapshot written to localStorage by saveStory(). */
    toSnapshot(text, snippet, customSnippet) {
        return {
            text,
            updatedAt: new Date().toISOString(),
            snippet,
            customSnippet,
            corrections: this.corrections,
            rewrites: this.rewrites,
            hones: this.hones,
            isRewriteMode: this.isRewriteMode,
            hasEvaluated: this.hasEvaluated,
        };
    }
}

const state = new AppState();

// ─────────────────────────────────────────────────────────────────────────────

const modeToggle = document.getElementById('mode-toggle');

// Initialize mode toggle state (default to API, or read from localStorage if present)
const savedMode = localStorage.getItem('rdo_mode');
if (savedMode === 'API') {
    modeToggle.checked = true;
} else if (savedMode === 'CLI') {
    modeToggle.checked = false;
} else {
    // Default to API mode since it has GOOGLE_API_KEY set and is more reliable than CLI
    modeToggle.checked = true;
    localStorage.setItem('rdo_mode', 'API');
}

modeToggle.addEventListener('change', () => {
    localStorage.setItem('rdo_mode', modeToggle.checked ? 'API' : 'CLI');
});

// Escape key listener to cancel loading or exit modes
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (state.abortController) {
            state.abortController.abort();
            showLoading(false);
        } else if (state.isRewriteMode) {
            // Exit rewrite mode if active and not loading
            bgAudioGen.abort(); // Stop background audio generation
            state.isRewriteMode = false;
            rewriteLayer.classList.add('hidden');
            textInput.classList.remove('hidden');
            highlightLayer.classList.remove('hidden');
            evaluateBtn.disabled = false;
            const unappliedCount = state.corrections.filter(c => !c.isApplied).length;
            rewriteBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);
            honeBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);
            renderEvaluation();
            saveStory();
        }
    }
});

// Command key held: temporarily enable EVALUATE in rewrite/hone mode, and change Hone/Rewrite buttons to RE-HONE/RE-REWRITE
window.addEventListener('keydown', (e) => {
    if (e.key === 'Meta' || e.key === 'Control') {
        honeBtn.textContent = 'RE-HONE';
        rewriteBtn.textContent = 'RE-REWRITE';
        if (state.isRewriteMode) {
            evaluateBtn.disabled = false;
        }
    }
});
window.addEventListener('keyup', (e) => {
    if (e.key === 'Meta' || e.key === 'Control') {
        honeBtn.textContent = 'HONE';
        rewriteBtn.textContent = 'REWRITE';
        if (state.isRewriteMode) {
            evaluateBtn.disabled = true;
        }
    }
});
window.addEventListener('blur', () => {
    honeBtn.textContent = 'HONE';
    rewriteBtn.textContent = 'REWRITE';
    if (state.isRewriteMode) {
        evaluateBtn.disabled = true;
    }
});

// History Management
function generateId() {
    return 'story_' + Date.now();
}

function saveStory(customSnippet = null) {
    const text = textInput.value;
    if (!text.trim() && !state.storyId) return;

    if (!state.storyId) {
        state.storyId = generateId();
    }

    const stories = JSON.parse(localStorage.getItem('rdo_stories') || '{}');
    const existingStory = stories[state.storyId] || {};

    // Use customSnippet if provided, otherwise preserve existing custom snippet,
    // or fallback to auto-generated snippet from text.
    const snippet = customSnippet || existingStory.customSnippet || (text.substring(0, 50) + (text.length > 50 ? '...' : ''));

    stories[state.storyId] = {
        ...existingStory,
        ...state.toSnapshot(text, snippet, customSnippet || existingStory.customSnippet),
    };
    localStorage.setItem('rdo_stories', JSON.stringify(stories));
    renderHistory();
}

function updateStorySnippet(id, newSnippet) {
    const stories = JSON.parse(localStorage.getItem('rdo_stories') || '{}');
    if (stories[id]) {
        stories[id].snippet = newSnippet;
        stories[id].customSnippet = newSnippet;
        // Do NOT update updatedAt — renaming is metadata-only and must not reorder the history list
        localStorage.setItem('rdo_stories', JSON.stringify(stories));
        renderHistory();
    }
}

function renderHistory() {
    const stories = JSON.parse(localStorage.getItem('rdo_stories') || '{}');
    const sortedStories = Object.entries(stories).sort((a, b) =>
        new Date(b[1].updatedAt) - new Date(a[1].updatedAt)
    );

    historyList.innerHTML = "";
    if (sortedStories.length === 0) {
        historyList.innerHTML = '<div class="empty-state">No stories yet.</div>';
        return;
    }

    sortedStories.forEach(([id, story]) => {
        const item = document.createElement('div');
        item.className = `history-item ${id === state.storyId ? 'active' : ''}`;
        item.innerHTML = `
            <div class="history-item-content">
                <span class="history-snippet" contenteditable="false" spellcheck="false">${story.snippet || '(Empty Story)'}</span>
                <span class="history-date">${new Date(story.updatedAt).toLocaleString()}</span>
            </div>
            <button class="delete-history-btn" title="Delete Story">×</button>
        `;

        const snippetEl = item.querySelector('.history-snippet');
        const contentEl = item.querySelector('.history-item-content');
        let clickTimer = null;

        const enterEditMode = () => {
            snippetEl.contentEditable = 'true';
            snippetEl.classList.add('editing');
            snippetEl.focus();
            const range = document.createRange();
            range.selectNodeContents(snippetEl);
            range.collapse(false);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
        };

        // Stop single clicks on the snippet from bubbling to content div
        snippetEl.onclick = (e) => e.stopPropagation();

        // Double-click on snippet OR content div enters rename mode
        snippetEl.ondblclick = (e) => {
            e.stopPropagation();
            clearTimeout(clickTimer);
            enterEditMode();
        };

        snippetEl.onblur = () => {
            snippetEl.contentEditable = 'false';
            snippetEl.classList.remove('editing');
            const newSnippet = snippetEl.textContent.trim();
            if (newSnippet && newSnippet !== story.snippet) {
                updateStorySnippet(id, newSnippet);
            }
        };

        snippetEl.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                snippetEl.blur();
            }
            if (e.key === 'Escape') {
                snippetEl.textContent = story.snippet || '(Empty Story)';
                snippetEl.blur();
            }
            e.stopPropagation();
        };

        // Use a short timer so dblclick on content can cancel loadStory
        contentEl.onclick = (e) => {
            if (snippetEl.contentEditable === 'true') return;
            clearTimeout(clickTimer);
            clickTimer = setTimeout(() => loadStory(id), 220);
        };

        contentEl.ondblclick = (e) => {
            clearTimeout(clickTimer);
            enterEditMode();
        };

        item.querySelector('.delete-history-btn').onclick = (e) => {
            e.stopPropagation();
            deleteStory(id);
        };
        historyList.appendChild(item);
    });
}

function deleteStory(id) {
    const stories = JSON.parse(localStorage.getItem('rdo_stories') || '{}');
    delete stories[id];
    localStorage.setItem('rdo_stories', JSON.stringify(stories));

    if (state.storyId === id) {
        startNewStory();
    } else {
        renderHistory();
    }
}

function loadStory(id) {
    const stories = JSON.parse(localStorage.getItem('rdo_stories') || '{}');
    const story = stories[id];
    if (story) {
        state.storyId = id;
        textInput.value = story.text;
        state.loadFrom(story);

        // Clean up data corrupted by the old bug where rewrites was set to hones during honeText
        if (state.rewrites && state.hones && JSON.stringify(state.rewrites) === JSON.stringify(state.hones)) {
            state.rewrites = null;
            // Update localStorage immediately to permanently fix this story's data corruption
            const storiesCopy = JSON.parse(localStorage.getItem('rdo_stories') || '{}');
            if (storiesCopy[id]) {
                storiesCopy[id].rewrites = null;
                localStorage.setItem('rdo_stories', JSON.stringify(storiesCopy));
            }
        }

        // Restore UI based on state
        if ((state.isRewriteMode === 'rewrite' || state.isRewriteMode === true) && state.rewrites) {
            renderRewrite(state.rewrites);
        } else if ((state.isRewriteMode === 'hone' || state.isRewriteMode === true) && state.hones) {
            renderRewrite(state.hones, true);
        } else {
            state.isRewriteMode = false;
            textInput.classList.remove('hidden');
            highlightLayer.classList.remove('hidden');
            rewriteLayer.classList.add('hidden');
            renderEvaluation();
        }

        // Control Rewrite/Hone Buttons (only count unapplied corrections)
        const unappliedCount = state.corrections.filter(c => !c.isApplied).length;
        rewriteBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);
        honeBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);

        renderHistory();
    }
}

function startNewStory() {
    state.reset();
    textInput.value = "";

    highlightLayer.innerHTML = "";
    rewriteLayer.classList.add('hidden');
    textInput.classList.remove('hidden');
    highlightLayer.classList.remove('hidden');
    rewriteBtn.disabled = true;
    honeBtn.disabled = true;

    renderSidebar();
    renderHistory();
    textInput.focus();
}

// Debounce helper
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const debouncedSave = debounce(saveStory, 1000);

async function evaluateText() {
    const text = textInput.value.trim();
    if (!text) return;

    state.originalText = textInput.value;
    const mode = modeToggle.checked ? 'API' : 'CLI';

    state.abortController = new AbortController();
    showLoading(true);

    try {
        const response = await fetch('http://localhost:8000/evaluate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: state.originalText,
                mode: mode
            }),
            signal: state.abortController.signal
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail?.error || data.detail || `HTTP error! Status: ${response.status}`);
        }
        state.corrections = data.corrections || [];
        state.hasEvaluated = true;

        // Enable rewrite button only if no errors and text is present
        rewriteBtn.disabled = state.corrections.length > 0;
        honeBtn.disabled = state.corrections.length > 0;

        renderEvaluation();
        saveStory();
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Evaluation aborted by user.");
        } else {
            console.error("Evaluation failed:", error);
            alert("The spirits are silent. " + error.message);
        }
    } finally {
        state.abortController = null;
        showLoading(false);
    }
}

async function rewriteText(e) {
    const text = textInput.value.trim();
    if (!text) return;

    const isForce = e && (e.metaKey || e.ctrlKey);
    // Reuse existing rewrites if available, text matches the original text, and Meta/Ctrl is not pressed
    if (!isForce && state.rewrites && textInput.value === state.originalText) {
        renderRewrite(state.rewrites);
        return;
    }

    const mode = modeToggle.checked ? 'API' : 'CLI';
    state.abortController = new AbortController();
    showLoading(true);

    try {
        const response = await fetch('http://localhost:8000/rewrite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: textInput.value,
                mode: mode
            }),
            signal: state.abortController.signal
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail?.error || data.detail || `HTTP error! Status: ${response.status}`);
        }
        if (data.rewrites) {
            renderRewrite(data.rewrites);
            saveStory();
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Rewrite aborted by user.");
        } else {
            console.error("Rewrite failed:", error);
            alert("The rewriting spirit is elusive. " + error.message);
        }
    } finally {
        state.abortController = null;
        showLoading(false);
    }
}

async function honeText(e) {
    const text = textInput.value.trim();
    if (!text) return;

    const isForce = e && (e.metaKey || e.ctrlKey);
    // Reuse existing hones if available, text matches, and Meta/Ctrl is not pressed
    if (!isForce && state.hones && textInput.value === state.originalText) {
        renderRewrite(state.hones, true);
        return;
    }

    const mode = modeToggle.checked ? 'API' : 'CLI';
    state.abortController = new AbortController();
    showLoading(true);

    try {
        const response = await fetch('http://localhost:8000/hone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: textInput.value,
                mode: mode
            }),
            signal: state.abortController.signal
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail?.error || data.detail || `HTTP error! Status: ${response.status}`);
        }
        if (data.rewrites) {
            state.hones = data.rewrites;
            renderRewrite(data.rewrites, true);
            saveStory();
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Hone aborted by user.");
        } else {
            console.error("Hone failed:", error);
            alert("The storyteller's muse is distant. " + error.message);
        }
    } finally {
        state.abortController = null;
        showLoading(false);
    }
}

// ─── Persistent Audio Cache (IndexedDB) ─────────────────────────────────────────
// Stores TTS audio blobs in IndexedDB so they survive hard reloads (Cmd+Shift+R).
// An in-memory Map mirrors IndexedDB for synchronous has()/get() access.

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
        return new Promise((resolve, reject) => {
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

/**
 * Background audio pre-generator.
 * Sequentially synthesizes audio for all sentences in a rewrite/hone view
 * while the user is idle. Can be aborted instantly when the user manually
 * selects a sentence.
 */
class BackgroundAudioGenerator {
    constructor() {
        this.abortController = null;
        this.isRunning = false;
        this.idleTimer = null;
        this.queue = [];          // Array of { text, buttonEl }
        this.currentIndex = 0;
    }

    /** Cancel any in-flight background fetch and stop the queue. */
    abort() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isRunning = false;
        this.queue = [];
        this.currentIndex = 0;
    }

    /**
     * Schedule background generation for a list of sentences.
     * Waits for idle (2 s after render) before starting.
     * @param {Array<{text: string, buttonEl: HTMLElement}>} items
     */
    schedule(items) {
        this.abort(); // Clear any previous run
        this.queue = items;
        this.currentIndex = 0;

        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            this._run();
        }, 2000); // 2-second idle threshold
    }

    /** Internal: process the queue one item at a time. */
    async _run() {
        this.isRunning = true;

        while (this.currentIndex < this.queue.length) {
            const { text, buttonEl } = this.queue[this.currentIndex];

            // Skip if already cached
            if (audioCache.has(text)) {
                this._markCached(buttonEl);
                this.currentIndex++;
                continue;
            }

            this.abortController = new AbortController();

            try {
                const blob = await fetchSynthesis(text, this.abortController.signal);
                audioCache.set(text, blob);
                // Update button to show cached state (only if still in DOM)
                if (buttonEl && buttonEl.isConnected) {
                    this._markCached(buttonEl);
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    console.log('[BG-Audio] Background generation aborted.');
                    this.isRunning = false;
                    return; // Stop entirely on abort
                }
                // Non-abort errors: log and continue to next sentence
                console.warn('[BG-Audio] Failed to pre-generate:', text.substring(0, 40), err.message);
            }

            this.abortController = null;
            this.currentIndex++;
        }

        this.isRunning = false;
        console.log('[BG-Audio] Background pre-generation complete.');
    }

    /** Mark a play button as having cached audio. */
    _markCached(buttonEl) {
        if (buttonEl && buttonEl.isConnected && !buttonEl.disabled) {
            buttonEl.classList.add('audio-cached');
            buttonEl.title = 'Audio ready — click to play';
        }
    }
}

const bgAudioGen = new BackgroundAudioGenerator();

function renderRewrite(rewrites, isHone = false) {
    // Stop any ongoing background audio generation from a previous render
    bgAudioGen.abort();

    if (isHone) {
        state.hones = rewrites;
    } else {
        state.rewrites = rewrites;
    }
    state.isRewriteMode = isHone ? 'hone' : 'rewrite';
    evaluateBtn.disabled = true;

    textInput.classList.add('hidden');
    highlightLayer.classList.add('hidden');
    rewriteLayer.classList.remove('hidden');

    rewriteLayer.innerHTML = "";

    // Add a header/close button to return to editing
    const closeBtn = document.createElement('button');
    closeBtn.className = 'apply-btn';
    closeBtn.style.marginBottom = '20px';
    closeBtn.textContent = isHone ? 'BACK TO JOURNAL (HONE)' : 'BACK TO JOURNAL';
    closeBtn.onclick = () => {
        bgAudioGen.abort(); // Stop background generation when leaving rewrite mode
        state.isRewriteMode = false;
        evaluateBtn.disabled = false;
        const unappliedCount = state.corrections.filter(c => !c.isApplied).length;
        rewriteBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);
        honeBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);
        rewriteLayer.classList.add('hidden');
        textInput.classList.remove('hidden');
        highlightLayer.classList.remove('hidden');
        renderEvaluation();
        saveStory();
    };
    rewriteLayer.appendChild(closeBtn);

    // Collect play buttons for background pre-generation scheduling
    const bgItems = [];

    rewrites.forEach(item => {
        const span = document.createElement('span');
        span.className = isHone ? 'rewrite-item hone-item' : 'rewrite-item';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'rewrite-content';
        if (isHone) {
            contentDiv.innerHTML = `<span class="rewrite-new">${item.rewritten}</span>`;
        } else {
            contentDiv.innerHTML = `<span class="rewrite-original">${item.original}</span><span class="rewrite-new">${item.rewritten}</span>`;
        }
        
        const playBtn = document.createElement('button');
        playBtn.className = 'play-audio-btn';
        // If already cached, show cached indicator immediately
        if (audioCache.has(item.rewritten)) {
            playBtn.classList.add('audio-cached');
            playBtn.innerHTML = '🔊';
            playBtn.title = 'Audio ready — click to play';
        } else {
            playBtn.innerHTML = '🔊';
            playBtn.title = 'Speak sentence using custom voice model';
        }
        playBtn.onclick = (e) => {
            e.stopPropagation();
            synthesizeSentence(item.rewritten, playBtn);
        };
        
        span.appendChild(contentDiv);
        span.appendChild(playBtn);
        rewriteLayer.appendChild(span);

        // Queue for background pre-generation (only uncached sentences)
        if (!audioCache.has(item.rewritten)) {
            bgItems.push({ text: item.rewritten, buttonEl: playBtn });
        }
    });

    saveStory();

    // Schedule background audio pre-generation after idle period
    if (bgItems.length > 0) {
        bgAudioGen.schedule(bgItems);
    }
}

// ─── Voice Synthesis (GPT-SoVITS) ──────────────────────────────────────────────

/**
 * Low-level fetch for TTS synthesis. Returns a Blob.
 * Accepts an optional AbortSignal for cancellation.
 */
async function fetchSynthesis(text, signal = null) {
    const referPath = "refer.wav";
    const referText = "I have far more than I need back in the city and I'd like you to have it.Please take care and remain true to the man I know you are.";
    const referLang = "en";
    const targetLang = "en";

    const response = await fetch('http://localhost:8000/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            text_language: targetLang,
            refer_wav_path: referPath,
            prompt_text: referText,
            prompt_language: referLang
        }),
        signal
    });

    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || `HTTP error! Status: ${response.status}`);
    }

    return await response.blob();
}

/**
 * User-initiated sentence playback.
 * - Aborts any background pre-generation immediately.
 * - Serves from cache if available.
 * - Otherwise fetches with user-priority.
 */
async function synthesizeSentence(text, buttonEl) {
    // 1. Abort background generator to prioritize user selection
    bgAudioGen.abort();

    const originalHTML = buttonEl.innerHTML;
    buttonEl.innerHTML = '⌛';
    buttonEl.disabled = true;

    try {
        let blob;

        // 2. Check cache first
        if (audioCache.has(text)) {
            blob = audioCache.get(text);
        } else {
            blob = await fetchSynthesis(text);
            audioCache.set(text, blob);
        }

        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);

        buttonEl.innerHTML = '▶️';
        audio.onended = () => {
            buttonEl.innerHTML = originalHTML;
            buttonEl.disabled = false;
            buttonEl.classList.add('audio-cached');
        };
        audio.onerror = () => {
            buttonEl.innerHTML = originalHTML;
            buttonEl.disabled = false;
            alert("Error playing audio.");
        };

        await audio.play();

    } catch (error) {
        console.error("Synthesis failed:", error);
        alert("Voice synthesis failed: " + error.message);
        buttonEl.innerHTML = originalHTML;
        buttonEl.disabled = false;
    }
}

evaluateBtn.addEventListener('click', evaluateText);
rewriteBtn.addEventListener('click', (e) => rewriteText(e));
honeBtn.addEventListener('click', (e) => honeText(e));
newStoryBtn.addEventListener('click', startNewStory);

// Clear highlights and auto-save when text changes
textInput.addEventListener('input', () => {
    const oldText = state.originalText || "";
    const newText = textInput.value;

    if (!newText.trim()) {
        state.corrections = [];
        state.rewrites = null;
        state.hones = null;
        state.isRewriteMode = false;
        state.hasEvaluated = false;
        state.originalText = "";
        rewriteBtn.disabled = true;
        honeBtn.disabled = true;
        highlightLayer.innerHTML = "";
        renderSidebar();
        debouncedSave();
        return;
    }

    // 1. Find common prefix
    let prefixLen = 0;
    while (prefixLen < oldText.length && prefixLen < newText.length && oldText[prefixLen] === newText[prefixLen]) {
        prefixLen++;
    }

    // 2. Find common suffix
    let suffixLen = 0;
    while (suffixLen < (oldText.length - prefixLen) &&
           suffixLen < (newText.length - prefixLen) &&
           oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]) {
        suffixLen++;
    }

    const editStart = prefixLen;
    const oldEditEnd = oldText.length - suffixLen;
    const diff = newText.length - oldText.length;

    // 3. Update corrections offsets and filter out overlapping ones
    const newCorrections = [];
    for (const corr of state.corrections) {
        const corrStart = corr.offset;
        const corrLen = corr.isApplied
            ? (corr.replacement ? corr.replacement.length : corr.length)
            : (corr.original ? corr.original.length : corr.length);
        const corrEnd = corrStart + corrLen;

        if (corrEnd <= editStart) {
            // Entirely before the edit - keep as is
            newCorrections.push(corr);
        } else if (corrStart >= oldEditEnd) {
            // Entirely after the edit - shift offset and keep
            corr.offset += diff;
            newCorrections.push(corr);
        } else {
            // Overlaps with the edit - discard
            console.log("Discarding overlapping correction:", corr);
        }
    }

    state.corrections = newCorrections;
    state.originalText = newText;
    state.rewrites = null;
    state.hones = null;
    state.isRewriteMode = false;

    // Update rewrite/hone buttons state
    const unappliedCount = state.corrections.filter(c => !c.isApplied).length;
    rewriteBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);
    honeBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);

    renderEvaluation();
    debouncedSave();
});

// Initialization
async function init() {
    // Wait for IndexedDB audio cache to load before rendering stories,
    // so play buttons correctly reflect cached audio state on reload.
    await audioCache.waitReady();

    renderHistory();
    
    // Auto-load most recent story if available
    const stories = JSON.parse(localStorage.getItem('rdo_stories') || '{}');
    const sortedIds = Object.keys(stories).sort((a, b) =>
        new Date(stories[b].updatedAt) - new Date(stories[a].updatedAt)
    );

    if (sortedIds.length > 0) {
        loadStory(sortedIds[0]);
    } else {
        startNewStory();
    }
}

init();

function findActualOffset(text, original, suggestedOffset) {
    if (!original) return suggestedOffset;

    // 1. Try exact match at suggestedOffset
    if (text.substring(suggestedOffset, suggestedOffset + original.length) === original) {
        return suggestedOffset;
    }

    // 2. Search in a window around suggestedOffset (50 chars either way)
    const windowSize = 50;
    const startSearch = Math.max(0, suggestedOffset - windowSize);
    const endSearch = Math.min(text.length, suggestedOffset + original.length + windowSize);
    const searchArea = text.substring(startSearch, endSearch);

    const indexInArea = searchArea.indexOf(original);
    if (indexInArea !== -1) {
        return startSearch + indexInArea;
    }

    // Fallback: trust the suggested offset but use the original's length
    return suggestedOffset;
}

function renderEvaluation() {
    // Both are always visible in the new overlay architecture
    textInput.classList.remove('hidden');
    highlightLayer.classList.remove('hidden');
    rewriteLayer.classList.add('hidden');

    // Clear previous highlights
    highlightLayer.innerHTML = "";

    const correctionsWithIndices = state.corrections.map((corr, index) => {
        const textToMatch = corr.isApplied ? corr.replacement : corr.original;
        const actualOffset = findActualOffset(state.originalText, textToMatch, corr.offset);
        return {
            ...corr,
            index,
            actualOffset,
            actualLength: textToMatch ? textToMatch.length : corr.length
        };
    });

    // Sort by actual offset
    correctionsWithIndices.sort((a, b) => a.actualOffset - b.actualOffset);

    let lastPos = 0;
    for (const corr of correctionsWithIndices) {
        if (corr.actualOffset < lastPos) continue;

        if (corr.actualOffset > lastPos) {
            highlightLayer.appendChild(document.createTextNode(state.originalText.substring(lastPos, corr.actualOffset)));
        }

        const span = document.createElement('span');
        span.className = corr.isApplied ? 'applied-fix' : 'error';
        span.dataset.index = corr.index;
        span.textContent = state.originalText.substring(corr.actualOffset, corr.actualOffset + corr.actualLength);

        span.addEventListener('click', () => {
            if (corr.isApplied) {
                revertFix(corr.index);
            } else {
                const sidebarItem = Array.from(correctionsList.children).find(child => child.dataset.index == corr.index);
                if (sidebarItem) sidebarItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });

        highlightLayer.appendChild(span);
        lastPos = corr.actualOffset + corr.actualLength;
    }

    if (lastPos < state.originalText.length) {
        highlightLayer.appendChild(document.createTextNode(state.originalText.substring(lastPos)));
    }

    renderSidebar();
}

// Sync scrolling between textarea and highlight layer
textInput.addEventListener('scroll', () => {
    highlightLayer.scrollTop = textInput.scrollTop;
    highlightLayer.scrollLeft = textInput.scrollLeft;
});

function renderSidebar() {
    correctionsList.innerHTML = "";

    const unappliedCorrections = state.corrections
        .map((corr, index) => ({ ...corr, originalIndex: index }))
        .filter(corr => !corr.isApplied);

    if (unappliedCorrections.length === 0) {
        const msg = state.hasEvaluated
            ? "No errors found. Your writing is as sharp as a repeater."
            : "Evaluate your writing to see corrections.";
        correctionsList.innerHTML = `<div class="empty-state">${msg}</div>`;
        return;
    }

    unappliedCorrections.forEach((corr) => {
        const card = document.createElement('div');
        card.className = 'correction-card';
        card.dataset.index = corr.originalIndex;
        card.innerHTML = `
            <span class="card-type">${corr.type}</span>
            <span class="card-original">"${corr.original}"</span>
            <span class="card-replacement">${corr.replacement}</span>
            <p class="card-reason">${corr.reason}</p>
            <button class="apply-btn">Apply Fix</button>
        `;

        card.addEventListener('mouseenter', () => highlightError(corr.originalIndex, true));
        card.addEventListener('mouseleave', () => highlightError(corr.originalIndex, false));
        card.querySelector('.apply-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            applyFix(corr.originalIndex);
        });

        correctionsList.appendChild(card);
    });
}

function highlightError(index, isActive) {
    const span = highlightLayer.querySelector(`span[data-index="${index}"]`);
    if (span) {
        span.style.backgroundColor = isActive ? 'rgba(200, 22, 30, 0.6)' : '';
    }
}

function applyFix(index) {
    const corr = state.corrections[index];
    if (corr.isApplied) return;

    const text = textInput.value;

    // Calculate actual offset to ensure we replace the right text
    const actualOffset = findActualOffset(text, corr.original, corr.offset);
    const actualLength = corr.original ? corr.original.length : corr.length;

    // Apply the fix locally
    const newText = text.substring(0, actualOffset) + corr.replacement + text.substring(actualOffset + actualLength);
    textInput.value = newText;
    state.originalText = newText;

    // Calculate length difference
    const diff = corr.replacement.length - actualLength;

    // Mark as applied
    corr.isApplied = true;

    // Shift offsets for all subsequent corrections
    state.corrections.forEach((c, i) => {
        if (i !== index && c.offset > actualOffset) {
            c.offset += diff;
        }
    });

    // Enable rewrite button if no more errors
    const unappliedCount = state.corrections.filter(c => !c.isApplied).length;
    rewriteBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);
    honeBtn.disabled = !(state.hasEvaluated && unappliedCount === 0);

    // Instant re-render without network call
    renderEvaluation();
    saveStory();
}

function revertFix(index) {
    const corr = state.corrections[index];
    if (!corr.isApplied) return;

    const text = textInput.value;

    // For reverting, we look for the replacement text that is currently in the journal
    const actualOffset = findActualOffset(text, corr.replacement, corr.offset);
    const actualLength = corr.replacement.length;

    // Revert to original
    const newText = text.substring(0, actualOffset) + corr.original + text.substring(actualOffset + actualLength);
    textInput.value = newText;
    state.originalText = newText;

    // Calculate length difference (original - replacement)
    const diff = corr.original.length - actualLength;

    // Mark as unapplied
    corr.isApplied = false;

    // Shift offsets for all subsequent corrections
    state.corrections.forEach((c, i) => {
        if (i !== index && c.offset > actualOffset) {
            c.offset += diff;
        }
    });

    // Disable rewrite button because an error has returned
    rewriteBtn.disabled = true;
    honeBtn.disabled = true;

    // Instant re-render without network call
    renderEvaluation();
    saveStory();
}

function showLoading(show) {
    if (show) {
        loadingOverlay.classList.remove('hidden');
    } else {
        loadingOverlay.classList.add('hidden');
    }
}

// Remove the old click listener that swapped visibility
// highlightLayer.addEventListener('click', ...) is no longer needed
// as textInput is always on top and handles clicks.
