// FlowNotes — Background Service Worker
// IMPORTANT: Never store state in JS variables. Service workers die after ~30s idle.
// All state must go through chrome.storage.local.

const SYSTEM_PROMPT = `You are a research synthesizer. The user is actively browsing the web researching a topic.
You receive extracts from pages they have visited and produce a single evolving research document.

CRITICAL RULES — failure modes to avoid:
- Do NOT produce a list of page summaries. That is the wrong output.
- WEAVE information across sources into coherent themed sections.
- When multiple sources agree on a claim, merge them into one point with inline citations.
- When sources contradict, surface the contradiction explicitly and name both sides.
- As new pages are added, REVISE existing sections — do not append new summaries at the bottom.
- Write in dense note-like prose: not bullet soup, not long paragraphs. Think "smart researcher's notes."

OUTPUT FORMAT (strict markdown):
# [Research Topic]
*[2-sentence synthesis of the overall picture so far]*

## Key Findings
[Synthesized claims. Multi-source where possible. Inline citations: [Title](url).]

## Patterns & Themes
[Recurring ideas, frameworks, or structures seen across sources]

## Contradictions & Open Questions
[Where sources disagree or evidence is thin]

## Details Worth Keeping
[Specific data points, quotes, numbers, names]

---
*[N] sources synthesized*`;

const STUDY_SYSTEM_PROMPT = `You are a study session analyzer. The user has been studying a topic by browsing multiple pages.
You receive page extracts with visit frequency data — high visit count signals a concept gap.

Your job:
1. Identify what concept each page is primarily about
2. Group pages by concept across all sources
3. Write a clear, standalone explanation per concept — do NOT write a narrative synthesis
4. Flag high-frequency concepts as gaps worth reviewing

CRITICAL RULES:
- Do NOT summarize sources individually
- Do NOT merge concepts into flowing prose — each section must stand alone
- Concept names must be precise and searchable (e.g. "Eigenvalues & Eigenvectors" not "linear algebra stuff")
- Include the visit count annotation on every h3 heading exactly as shown in the format below

OUTPUT FORMAT (strict markdown):
## Concepts You Studied

### [Concept Name]  [N lookup(s)]
[Clear, direct explanation from all pages on this concept. 2–5 sentences. No source attribution.]

### [Next Concept]  [N lookup(s)]
[explanation]

## Possible Gaps
Concepts you returned to multiple times — worth reviewing before the exam.
- [Concept] (looked up N times)

---
*[N] pages analyzed*`;

// --- Port management ---

let sidePanelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPort = port;
    port.onDisconnect.addListener(() => { sidePanelPort = null; });
    // Send current state to newly connected panel
    chrome.storage.local.get(['pages', 'savedNotes', 'topic', 'status', 'mode'], (data) => {
      if (data.savedNotes) {
        port.postMessage({ type: 'restore', text: data.savedNotes, count: (data.pages || []).length, mode: data.mode || 'research' });
      } else if (data.pages && data.pages.length > 0) {
        port.postMessage({ type: 'waiting', count: data.pages.length });
      }
    });
  }
});

function postToPanel(msg) {
  if (sidePanelPort) {
    try { sidePanelPort.postMessage(msg); } catch (_) { sidePanelPort = null; }
  }
}

// --- Tab event listeners ---

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.status !== 'complete') return;
  await handleTab(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  // Only track the active tab to avoid capturing background loads
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || activeTab.id !== tabId) return;
  await handleTab(tabId);
});

// Open side panel when action button is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// --- Tab handling ---

async function handleTab(tabId) {
  const { active } = await chrome.storage.local.get('active');
  if (!active) return; // Not started yet

  const page = await captureTab(tabId);
  await onTabCaptured(page);
}

async function captureTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const clone = document.body.cloneNode(true);
        ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'iframe',
          '[role="banner"]', '[role="navigation"]', '.ad', '.sidebar', '.cookie-banner']
          .forEach(sel => {
            try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch (_) {}
          });
        const main = clone.querySelector('article') ||
                     clone.querySelector('main') ||
                     clone.querySelector('[role="main"]') || clone;
        return {
          url: location.href,
          title: document.title,
          text: (main.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000)
        };
      }
    });
    const result = results[0]?.result ?? null;
    // Skip empty/useless captures
    if (!result || result.text.length < 100) return null;
    return result;
  } catch (_) {
    return null; // chrome://, PDFs, CSP-locked sites, etc.
  }
}

async function onTabCaptured(page) {
  if (!page) return;

  const { pages = [], topic, mode = 'research', visitCounts = {} } =
    await chrome.storage.local.get(['pages', 'topic', 'mode', 'visitCounts']);

  // Increment visit count before deduplication
  visitCounts[page.url] = (visitCounts[page.url] || 0) + 1;
  await chrome.storage.local.set({ visitCounts });

  // Deduplicate by URL
  const deduped = pages.filter(p => p.url !== page.url);
  const updated = [...deduped, page];
  await chrome.storage.local.set({ pages: updated });

  if (updated.length >= 2) {
    await callClaudeStreaming(topic, updated, mode, visitCounts);
  } else {
    postToPanel({ type: 'waiting', count: updated.length });
  }
}

// --- Claude API ---

function buildUserMessage(topic, pages) {
  return `Research topic: "${topic}"\n\n` +
    `Synthesize my notes from these ${pages.length} sources:\n\n` +
    pages.map((p, i) =>
      `### Source ${i + 1}: ${p.title}\nURL: ${p.url}\n\n${p.text}`
    ).join('\n\n---\n\n');
}

function buildStudyUserMessage(topic, pages, visitCounts) {
  return `Study topic: "${topic}"\n\n` +
    `Analyze these ${pages.length} pages. Group by concept, weight by visit frequency.\n\n` +
    pages.map((p, i) => {
      const visits = visitCounts[p.url] || 1;
      return `### Page ${i + 1}: ${p.title}\nURL: ${p.url}\nVisit count: ${visits}\n\n${p.text}`;
    }).join('\n\n---\n\n');
}

async function callClaudeStreaming(topic, pages, mode = 'research', visitCounts = {}) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    postToPanel({ type: 'error', message: 'No API key set. Please enter your Anthropic API key.' });
    return;
  }

  postToPanel({ type: 'stream_start', count: pages.length, mode });

  const systemPrompt = mode === 'study' ? STUDY_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userMessage = mode === 'study'
    ? buildStudyUserMessage(topic, pages, visitCounts)
    : buildUserMessage(topic, pages);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        stream: true,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
  } catch (err) {
    postToPanel({ type: 'error', message: `Network error: ${err.message}` });
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    postToPanel({ type: 'error', message: `API error ${res.status}: ${body.slice(0, 200)}` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          accumulated += parsed.delta.text;
          postToPanel({ type: 'chunk', text: parsed.delta.text });
        }
      } catch (_) {}
    }
  }

  await chrome.storage.local.set({ savedNotes: accumulated });
  postToPanel({ type: 'stream_end', count: pages.length, mode });
}

// --- Message handler (for commands from side panel) ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'start') {
    chrome.storage.local.set({
      active: true, topic: msg.topic, apiKey: msg.apiKey, pages: [], savedNotes: null,
      mode: msg.mode || 'research', visitCounts: {}, masteredConcepts: []
    }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'reset') {
    chrome.storage.local.set({ active: false, pages: [], savedNotes: null, visitCounts: {}, masteredConcepts: [] }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'get_pages') {
    chrome.storage.local.get('pages', (data) => {
      sendResponse({ pages: data.pages || [] });
    });
    return true;
  }
});

// Testability: export pure/mockable functions for unit tests
if (typeof module !== 'undefined') {
  module.exports = { buildUserMessage, buildStudyUserMessage, captureTab, onTabCaptured, callClaudeStreaming, handleTab, postToPanel };
}
