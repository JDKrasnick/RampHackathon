// FlowNotes — Side Panel UI

const viewSetup = document.getElementById('view-setup');
const viewActive = document.getElementById('view-active');
const setupForm = document.getElementById('setup-form');
const inputTopic = document.getElementById('input-topic');
const inputKey = document.getElementById('input-key');
const btnStart = document.getElementById('btn-start');
const btnReset = document.getElementById('btn-reset');
const sourceBadge = document.getElementById('source-badge');
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const statusSpinner = document.getElementById('status-spinner');
const notesContent = document.getElementById('notes-content');
const notesPlaceholder = document.getElementById('notes-placeholder');
const modeToggle = document.getElementById('mode-toggle');

let accumulated = '';
let port = null;
let selectedMode = 'research';

// --- Mode toggle ---

modeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  selectedMode = btn.dataset.mode;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
});

// --- Port connection ---

function connectPort() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // Reconnect after brief delay (service worker restarted)
    setTimeout(connectPort, 500);
  });
}

connectPort();

// --- Message handler ---

function handleMessage(msg) {
  switch (msg.type) {
    case 'restore':
      showActiveView();
      setNotes(msg.text);
      setSourceCount(msg.count);
      setStatus('');
      if (msg.mode === 'study') injectGotItButtons();
      break;

    case 'waiting':
      showActiveView();
      setSourceCount(msg.count);
      setStatus(`Tab ${msg.count} captured — visit another tab to start synthesis`);
      setPlaceholder();
      break;

    case 'stream_start':
      showActiveView();
      accumulated = '';
      setSourceCount(msg.count);
      setStatus(msg.mode === 'study' ? 'Analyzing study session…' : 'Synthesizing…', true);
      clearNotes();
      break;

    case 'chunk':
      accumulated += msg.text;
      renderNotes(accumulated);
      break;

    case 'stream_end':
      setSourceCount(msg.count);
      setStatus(msg.mode === 'study' ? `${msg.count} pages analyzed` : `${msg.count} sources synthesized`);
      if (msg.mode === 'study') injectGotItButtons();
      break;

    case 'error':
      setStatus(`Error: ${msg.message}`);
      showErrorInNotes(msg.message);
      break;
  }
}

// --- UI state helpers ---

function showSetupView() {
  viewSetup.classList.add('active');
  viewActive.classList.remove('active');
}

function showActiveView() {
  viewSetup.classList.remove('active');
  viewActive.classList.add('active');
}

function setSourceCount(n) {
  sourceBadge.textContent = `${n} source${n === 1 ? '' : 's'}`;
  sourceBadge.classList.toggle('has-sources', n > 0);
}

function setStatus(text, spinning = false) {
  if (!text) {
    statusBar.classList.add('hidden');
    return;
  }
  statusBar.classList.remove('hidden');
  statusText.textContent = text;
  statusSpinner.classList.toggle('hidden', !spinning);
}

function clearNotes() {
  notesContent.innerHTML = '<div class="synthesizing-pulse">Synthesizing across sources…</div>';
}

function setPlaceholder() {
  notesContent.innerHTML = `
    <div id="notes-placeholder" class="placeholder">
      <div class="placeholder-icon">◎</div>
      <p>Tab captured.</p>
      <p class="placeholder-sub">Visit another tab to start synthesis.</p>
    </div>`;
}

function renderNotes(markdown) {
  const html = marked.parse(markdown);
  notesContent.innerHTML = `<div class="markdown-body">${html}</div>`;
  // Auto-scroll to bottom while streaming
  notesContent.scrollTop = notesContent.scrollHeight;
}

function setNotes(markdown) {
  const html = marked.parse(markdown);
  notesContent.innerHTML = `<div class="markdown-body">${html}</div>`;
}

function showErrorInNotes(message) {
  notesContent.innerHTML = `<div class="error-block"><strong>Error</strong><p>${message}</p></div>`;
}

// --- Setup form ---

// Pre-fill saved API key and restore mode toggle
chrome.storage.local.get(['apiKey', 'topic', 'active', 'mode'], (data) => {
  if (data.apiKey) inputKey.value = data.apiKey;
  if (data.topic) inputTopic.value = data.topic;
  if (data.mode) {
    selectedMode = data.mode;
    modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === data.mode));
  }
  if (data.active) {
    showActiveView();
    chrome.runtime.sendMessage({ type: 'get_pages' }, (res) => {
      if (res && res.pages) setSourceCount(res.pages.length);
    });
  }
});

setupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const topic = inputTopic.value.trim();
  const apiKey = inputKey.value.trim();
  if (!topic) { inputTopic.focus(); return; }
  if (!apiKey) { inputKey.focus(); return; }

  btnStart.disabled = true;
  btnStart.textContent = 'Starting…';

  chrome.runtime.sendMessage({ type: 'start', topic, apiKey, mode: selectedMode }, () => {
    btnStart.disabled = false;
    btnStart.textContent = 'Start Session';
    showActiveView();
    setSourceCount(0);
    setStatus('Ready — browse a tab to begin capturing');
  });
});

// --- Reset ---

btnReset.addEventListener('click', () => {
  if (!confirm('Clear all captured tabs and notes and start over?')) return;
  accumulated = '';
  chrome.runtime.sendMessage({ type: 'reset' }, () => {
    showSetupView();
    setSourceCount(0);
    setStatus('');
  });
});

// --- Study mode: concept sections and Got it buttons ---

function wrapConceptSections() {
  const body = notesContent.querySelector('.markdown-body');
  if (!body) return;
  const h3s = Array.from(body.querySelectorAll('h3'));
  h3s.forEach(h3 => {
    if (h3.closest('.concept-section')) return; // already wrapped
    const wrapper = document.createElement('div');
    wrapper.className = 'concept-section';
    h3.parentNode.insertBefore(wrapper, h3);
    wrapper.appendChild(h3);
    // Absorb following siblings until the next h3, h2, or hr
    let next = wrapper.nextSibling;
    while (next && !(next.nodeType === 1 && (next.tagName === 'H3' || next.tagName === 'H2' || next.tagName === 'HR'))) {
      const toMove = next;
      next = next.nextSibling;
      wrapper.appendChild(toMove);
    }
  });
}

function injectGotItButtons() {
  wrapConceptSections();
  chrome.storage.local.get('masteredConcepts', ({ masteredConcepts = [] }) => {
    notesContent.querySelectorAll('.concept-section').forEach(section => {
      const h3 = section.querySelector('h3');
      if (!h3 || section.querySelector('.got-it-btn')) return;

      // Strip visit count annotation e.g. "Eigenvalues & Eigenvectors  [3 lookups]"
      const concept = h3.textContent.trim().replace(/\s*\[\d+\s+look-?ups?\]\s*$/i, '').trim();

      const btn = document.createElement('button');
      btn.className = 'got-it-btn';
      btn.textContent = 'Got it ✓';
      btn.dataset.concept = concept;
      h3.appendChild(btn);

      if (masteredConcepts.includes(concept)) {
        section.classList.add('mastered');
      }

      btn.addEventListener('click', () => {
        chrome.storage.local.get('masteredConcepts', ({ masteredConcepts: mc = [] }) => {
          if (!mc.includes(concept)) {
            mc.push(concept);
            chrome.storage.local.set({ masteredConcepts: mc });
          }
          section.classList.add('mastered');
        });
      });
    });
  });
}

// Testability: export functions for unit tests
if (typeof module !== 'undefined') {
  module.exports = {
    handleMessage, setSourceCount, setStatus,
    showActiveView, showSetupView,
    renderNotes, setNotes, clearNotes, setPlaceholder, showErrorInNotes,
    get accumulated() { return accumulated; },
  };
}
