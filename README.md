# 🤠 Red Dead Editor — English Writing Practice (Est. 1899)

Red Dead Editor is a single-page web application (SPA) paired with a FastAPI backend designed to help you practice and improve your English writing. Styled in an immersive **rugged Western theme** reminiscent of *Red Dead Redemption* (circa 1899), it uses Google Gemini to evaluate, rewrite, hone, and narrate your journal entries.

---

## 🌟 Key Features

1. **Evaluate (Assessment & Underlines)**
   - Analyzes your writing for **Grammar**, **Spelling**, **Style**, and **Vocabulary** issues using Google Gemini.
   - Highlights issues with color-coded underlines and syncs active sidebar cards as you move the caret.
   - Supports one-click **Apply Fix**, **Apply All**, and **Dismiss** controls with undo support.

2. **Rewrite (Interleaved Comparison & TTS)**
   - Provides sentence-by-sentence rewrites with explanations of each improvement.
   - Displays an interleaved original vs. rewritten comparison view while keeping your underlying draft intact.
   - Includes inline **Text-to-Speech** playback for rewritten sentences.

3. **Hone (Narrative Polish & Commentary)**
   - Transforms your passage into vivid, cohesive prose while preserving paragraph structure and chronological order.
   - Lists key stylistic upgrades (`improvements`) in the sidebar explaining how imagery, word choice, and rhythm were elevated.
   - Includes mode-aware **Copy Text** and read-only view indicators.

4. **Text-to-Speech (Gemini TTS)**
   - Synthesizes expressive old-world narration via **Gemini 3.8 Flash TTS** (`Leda` voice) with style steering.
   - Uses bounded server-side LRU caching and client-side audio caching for instant replay.

5. **Invite-Only Accounts & Cloud Persistence**
   - Supports invite-only username login backed by `HttpOnly` session cookies and SQLite cloud storage (`storage.py`).
   - Preserves journal entries, titles, and Evaluate/Rewrite/Hone states across devices, with local browser storage support.
   - Includes `manage_users.py` CLI to provision, list, remove accounts, and revoke active sessions.

---

## 🛠️ Architecture & Tech Stack

- **Frontend**: Single-page application built with Semantic HTML5, CSS Variables (responsive layout, dark/light themes, custom Western typography), and vanilla JavaScript.
- **Backend**: FastAPI server with per-IP rate limiting, GZip compression, session auth, and SQLite persistence.
- **AI Models (Google GenAI SDK)**:
  - **Text Analysis (`Evaluate` / `Rewrite` / `Hone`)**: `gemini-4-hydrogen` (default, `LOW` thinking level).
  - **Text-to-Speech (`TTS`)**: `gemini-3.8-flash-tts` (default voice `Leda`).

---

## 🚀 Setup & Run Instructions

### Prerequisites
- Python 3.10+
- A Google Gemini API key

### 1. Environment Setup
Clone the repository and create your virtual environment:

```bash
git clone https://github.com/junyuan2077/red-dead-editor.git
cd red-dead-editor

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 2. Configure Environment Variables
Create a `.env` file from the example:

```bash
cp .env.example .env
```

Edit `.env` to include your Gemini API key:

```env
GEMINI_API_KEY=your-actual-gemini-api-key
```

### 3. Manage Invite-Only Users (Optional)
Use `manage_users.py` to manage provisioned usernames:

```bash
python manage_users.py add <username>
python manage_users.py list
python manage_users.py revoke-sessions <username>
python manage_users.py remove <username>
```

### 4. Launching the Application
Start the server with:

```bash
python launch.py
```

Or run FastAPI directly with Uvicorn:

```bash
uvicorn main:app --host 127.0.0.1 --port 8000
```

Open your browser and navigate to `http://127.0.0.1:8000` to start writing.

---

## 📁 Directory Structure

```
├── frontend/             # Single Page Application frontend
│   ├── assets/           # Custom fonts (.woff2/.woff) & WebP/PNG assets
│   ├── index.html        # Main app entry structure
│   ├── style.css         # Immersive Western stylesheets
│   └── app.js            # Core UI state, editor & audio cache logic
├── scripts/              # Asset optimization & helper scripts
├── main.py               # FastAPI server, auth, rate limiting & API routes
├── gemini_bridge.py      # Google Gemini API connector (Evaluate/Rewrite/Hone/TTS)
├── storage.py            # SQLite persistence for users, sessions & entries
├── manage_users.py       # CLI for managing invite-only user accounts
├── launch.py             # Launcher script for the application
├── requirements.txt      # Python dependencies
├── .env.example          # Example environment configuration
└── README.md             # You are here!
```

---

## 🤝 Contributing
Contributions, bug reports, and theme suggestions are welcome. Grab your saddle and feel free to open a Pull Request!
