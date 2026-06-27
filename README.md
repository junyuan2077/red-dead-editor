# 🤠 Red Dead Editor — English Writing Practice (Est. 1899)

Red Dead Editor is a single-page web application (SPA) paired with a FastAPI backend designed to help you practice and improve your English writing. Styled in a premium, immersive **rugged Western theme** reminiscent of *Red Dead Redemption* (circa 1899), it uses state-of-the-art AI to guide your writing journey.

---

## 🌟 Key Features

1. **Evaluate (Assessment & Underlines)**
   - Analyze your writing using Google Gemini.
   - Highlights spelling, grammar, punctuation, and stylistic issues with custom colored underlines matching the classic Western aesthetic.
   - Deep-dive into each correction card in the sidebar with explanations, original text segments, and one-click quick fixes.

2. **Rewrite (Interleaved Comparison)**
   - Sentence-by-sentence rewrites suggested by Gemini.
   - Displays an immersive, interleaved original vs. rewritten comparison view.
   - High-fidelity original text alignments are preserved even after styling.

3. **Hone (Polish & Improve)**
   - Instantly polish your entire text passage into a fluent, cohesive piece.
   - Highlights specific improvement suggestions and commentary in the sidebar.

4. **Text-to-Speech (TTS) Proxy**
   - Synthesizes and plays back audio of your writing.
   - Integrates with `GPT-SoVITS` server using a custom reference speaker profile (`charlotte`) to provide old-world storytelling voice synthesis.

5. **Journal History (LocalStorage)**
   - Save your journal entries locally on your device.
   - Rename, delete, or load previous entries seamlessly.
   - Rewrite and Hone histories are fully preserved per entry.

---

## 🛠️ Architecture & Tech Stack

- **Frontend**: Single-page application built with raw Semantic HTML5, CSS Variables (for responsive layout, thematic colors, and custom fonts), and vanilla JavaScript.
- **Backend**: FastAPI web server to proxy calls to Gemini and the GPT-SoVITS TTS server.
- **AI Models**:
  - **Gemini 2.5/3.5**: Handles English evaluations, rewrites, and honing.
  - **GPT-SoVITS**: Generates high-quality speech output.

---

## 🚀 Setup & Run Instructions

### Prerequisites
- Python 3.8+
- [Optional] GPT-SoVITS local server (running on port `9880`).

### 1. Environment Setup
Clone the repository and create your virtual environment:

```bash
git clone https://github.com/yanyinn/red-dead-editor.git
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

Edit the `.env` file to include your Gemini API key:

```env
GEMINI_API_KEY=your-actual-gemini-api-key
GPT_SOVITS_URL=http://127.0.0.1:9880
```

### 3. Launching the Application
Launch both the FastAPI backend and (optionally) the TTS engine using the orchestrator script:

```bash
python launch.py
```

This starts the FastAPI server on `http://127.0.0.1:8000`. Open your browser and navigate to `http://127.0.0.1:8000` to start writing.

---

## 📁 Directory Structure

```
├── frontend/             # Single Page Application frontend
│   ├── assets/           # Embedded custom fonts & image assets
│   ├── index.html        # Main app entry structure
│   ├── style.css         # Immersive Western stylesheets
│   └── app.js            # Core UI state & interaction logic
├── main.py               # FastAPI server backend & Gemini Integration
├── launch.py             # Orchestrator script to start backend & TTS
├── gemini_bridge.py      # Google Gemini API connector
├── requirements.txt      # Python dependencies list
└── README.md             # You are here!
```

---

## 🤝 Contributing
Contributions, bug reports, and theme suggestions are welcome. Grab your saddle and feel free to open a Pull Request!
