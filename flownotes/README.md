# FlowNotes

AI-synthesized research notes across all your tabs — live, as you browse.

---

## Install

1. Go to `chrome://extensions` → enable **Developer mode** (top-right toggle)
2. Click **Load unpacked** → select the `flownotes/` folder
3. Pin the extension via the puzzle-piece icon in the toolbar

---

## Quick Start

1. Click the FlowNotes icon → side panel opens
2. Enter your **Anthropic API key** (`sk-ant-...`) and a **research topic**
3. Click **Start Session**
4. Browse normally — FlowNotes captures each tab you visit
5. After your second tab, synthesis begins and streams into the panel live

Your API key and notes persist across browser restarts.

---

## How It Works

FlowNotes watches which tabs you visit. After capturing at least **2 sources**, it calls Claude to synthesize everything into a single research document — not a list of summaries, but woven notes with cross-source citations, patterns, and contradictions surfaced automatically. Each new tab you visit triggers a fresh synthesis that revises the document in place.

The notes document follows a fixed structure:

| Section | What's in it |
|---------|--------------|
| **Key Findings** | Synthesized claims with inline citations |
| **Patterns & Themes** | Recurring ideas across sources |
| **Contradictions & Open Questions** | Where sources disagree |
| **Details Worth Keeping** | Data points, quotes, numbers |

---

## Tips

- **Prepare your tabs in advance.** Open 4–5 relevant URLs before starting a session for the best synthesis. Browsing aimlessly produces weaker output.
- **Be specific with the topic.** "lithium battery recycling economics" beats "batteries".
- **Re-visit a tab** to refresh its content — FlowNotes deduplicates by URL and updates the source.
- Notes are **saved automatically** after each synthesis. Reopening the panel restores your last session.

---

## Limitations

- **Some sites won't capture.** Chrome internal pages (`chrome://`), PDFs, and sites with strict CSP policies are silently skipped. The source counter only reflects successfully captured pages.
- **SPAs may capture before JS renders.** React/Vue apps that load content asynchronously might yield partial text. Switching away and back usually fixes it.
- **Single window only.** Multiple Chrome windows aren't tracked — only the active tab in the window where you started the session.

---

## Reset

Click **Reset** in the panel header to clear all captured tabs and notes and start a new session. Your API key is preserved.

---

## Debugging

| Problem | Where to look |
|---------|---------------|
| Synthesis not triggering | `chrome://extensions` → FlowNotes → **Inspect service worker** |
| UI not updating | Right-click side panel → **Inspect** |
| Extension stale after edits | `chrome://extensions` → click the refresh icon on the FlowNotes card |
