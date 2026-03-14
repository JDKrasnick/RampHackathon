/**
 * @jest-environment jsdom
 */
'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** HTML structure from sidepanel.html — only the elements sidepanel.js queries. */
const PANEL_HTML = `
<div id="view-setup" class="view active">
  <form id="setup-form">
    <input id="input-topic" type="text" />
    <input id="input-key" type="password" />
    <button id="btn-start" type="submit">Start Session</button>
  </form>
</div>
<div id="view-active" class="view">
  <span id="source-badge" class="source-badge">0 sources</span>
  <button id="btn-reset">Reset</button>
  <div id="status-bar" class="status-bar hidden">
    <span id="status-text"></span>
    <span id="status-spinner" class="spinner hidden"></span>
  </div>
  <div id="notes-container">
    <div id="notes-content" class="notes-content">
      <div id="notes-placeholder" class="placeholder"></div>
    </div>
  </div>
</div>
`;

function makeMockPort() {
  const listeners = { message: [], disconnect: [] };
  return {
    postMessage: jest.fn(),
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    _emit: (type, payload) => listeners[type].forEach(fn => fn(payload)),
    _listeners: listeners,
  };
}

function makeChromeMock() {
  const mockPort = makeMockPort();
  return {
    _port: mockPort,
    runtime: {
      connect: jest.fn(() => mockPort),
      sendMessage: jest.fn(),
    },
    storage: {
      local: {
        get: jest.fn((_, cb) => cb && cb({})),
        set: jest.fn(),
      },
    },
  };
}

// ── Module setup ──────────────────────────────────────────────────────────────

let sp; // sidepanel module exports
let chromeMock;

beforeEach(() => {
  document.body.innerHTML = PANEL_HTML;

  chromeMock = makeChromeMock();
  global.chrome = chromeMock;
  global.marked = { parse: (md) => `<parsed>${md}</parsed>` };
  global.confirm = jest.fn(() => true);

  jest.resetModules();
  sp = require('../sidepanel/sidepanel.js');
});

afterEach(() => {
  delete global.chrome;
  delete global.marked;
  delete global.confirm;
});

// ── setSourceCount ────────────────────────────────────────────────────────────

describe('setSourceCount', () => {
  test('0 → "0 sources", no has-sources class', () => {
    sp.setSourceCount(0);
    const badge = document.getElementById('source-badge');
    expect(badge.textContent).toBe('0 sources');
    expect(badge.classList.contains('has-sources')).toBe(false);
  });

  test('1 → "1 source" (singular)', () => {
    sp.setSourceCount(1);
    expect(document.getElementById('source-badge').textContent).toBe('1 source');
  });

  test('5 → "5 sources", has-sources class present', () => {
    sp.setSourceCount(5);
    const badge = document.getElementById('source-badge');
    expect(badge.textContent).toBe('5 sources');
    expect(badge.classList.contains('has-sources')).toBe(true);
  });

  test('transition from 0 to 1 adds has-sources; back to 0 removes it', () => {
    const badge = document.getElementById('source-badge');
    sp.setSourceCount(1);
    expect(badge.classList.contains('has-sources')).toBe(true);
    sp.setSourceCount(0);
    expect(badge.classList.contains('has-sources')).toBe(false);
  });
});

// ── setStatus ─────────────────────────────────────────────────────────────────

describe('setStatus', () => {
  test('empty string → status bar is hidden', () => {
    sp.setStatus('');
    expect(document.getElementById('status-bar').classList.contains('hidden')).toBe(true);
  });

  test('text with no spinner → bar visible, spinner hidden', () => {
    sp.setStatus('Ready');
    const bar = document.getElementById('status-bar');
    const spinner = document.getElementById('status-spinner');
    expect(bar.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('status-text').textContent).toBe('Ready');
    expect(spinner.classList.contains('hidden')).toBe(true);
  });

  test('text with spinner=true → spinner visible', () => {
    sp.setStatus('Synthesizing...', true);
    expect(document.getElementById('status-spinner').classList.contains('hidden')).toBe(false);
  });

  test('calling twice: second call overwrites first', () => {
    sp.setStatus('First');
    sp.setStatus('Second');
    expect(document.getElementById('status-text').textContent).toBe('Second');
  });
});

// ── showActiveView / showSetupView ────────────────────────────────────────────

describe('view switching', () => {
  test('showActiveView → active class on view-active, removed from view-setup', () => {
    sp.showActiveView();
    expect(document.getElementById('view-active').classList.contains('active')).toBe(true);
    expect(document.getElementById('view-setup').classList.contains('active')).toBe(false);
  });

  test('showSetupView → active class on view-setup, removed from view-active', () => {
    sp.showActiveView();   // go active first
    sp.showSetupView();
    expect(document.getElementById('view-setup').classList.contains('active')).toBe(true);
    expect(document.getElementById('view-active').classList.contains('active')).toBe(false);
  });
});

// ── handleMessage ─────────────────────────────────────────────────────────────

describe('handleMessage', () => {
  test('restore → shows active view, renders notes, sets count, clears status', () => {
    sp.handleMessage({ type: 'restore', text: '# Heading', count: 3 });

    expect(document.getElementById('view-active').classList.contains('active')).toBe(true);
    expect(document.getElementById('notes-content').innerHTML).toContain('parsed');
    expect(document.getElementById('source-badge').textContent).toBe('3 sources');
    expect(document.getElementById('status-bar').classList.contains('hidden')).toBe(true);
  });

  test('waiting → shows active view, sets count, sets status text', () => {
    sp.handleMessage({ type: 'waiting', count: 1 });

    expect(document.getElementById('view-active').classList.contains('active')).toBe(true);
    expect(document.getElementById('source-badge').textContent).toBe('1 source');
    expect(document.getElementById('status-text').textContent).toContain('Tab 1 captured');
  });

  test('stream_start → clears accumulated, updates count, starts spinner', () => {
    // Seed some accumulated state via a prior chunk
    sp.handleMessage({ type: 'stream_start', count: 2 });
    sp.handleMessage({ type: 'chunk', text: 'hello' });

    // Now start a new stream
    sp.handleMessage({ type: 'stream_start', count: 3 });

    // Accumulated should reset — new chunk should only contain new text
    sp.handleMessage({ type: 'chunk', text: 'fresh' });
    const content = document.getElementById('notes-content').innerHTML;
    expect(content).toContain('fresh');
    expect(content).not.toContain('hello');

    expect(document.getElementById('source-badge').textContent).toBe('3 sources');
    expect(document.getElementById('status-spinner').classList.contains('hidden')).toBe(false);
  });

  test('chunk → text accumulates and notes are re-rendered', () => {
    sp.handleMessage({ type: 'stream_start', count: 2 });
    sp.handleMessage({ type: 'chunk', text: 'Part 1 ' });
    sp.handleMessage({ type: 'chunk', text: 'Part 2' });

    expect(sp.accumulated).toBe('Part 1 Part 2');
    // marked.parse is called with full accumulated string each time
    const content = document.getElementById('notes-content').innerHTML;
    expect(content).toContain('Part 1 Part 2');
  });

  test('stream_end → updates count, sets status (no spinner)', () => {
    sp.handleMessage({ type: 'stream_start', count: 2 });
    sp.handleMessage({ type: 'stream_end', count: 2 });

    expect(document.getElementById('source-badge').textContent).toBe('2 sources');
    expect(document.getElementById('status-text').textContent).toContain('2 sources synthesized');
    expect(document.getElementById('status-spinner').classList.contains('hidden')).toBe(true);
  });

  test('error → sets status with "Error:" prefix, shows error block in notes', () => {
    sp.handleMessage({ type: 'error', message: 'API key invalid' });

    expect(document.getElementById('status-text').textContent).toContain('Error:');
    expect(document.getElementById('status-text').textContent).toContain('API key invalid');
    expect(document.getElementById('notes-content').innerHTML).toContain('error-block');
    expect(document.getElementById('notes-content').innerHTML).toContain('API key invalid');
  });

  test('unknown message type → no throw, no state change', () => {
    const badgeBefore = document.getElementById('source-badge').textContent;
    expect(() => sp.handleMessage({ type: 'totally_unknown' })).not.toThrow();
    expect(document.getElementById('source-badge').textContent).toBe(badgeBefore);
  });
});

// ── clearNotes / setPlaceholder ───────────────────────────────────────────────

describe('notes content helpers', () => {
  test('clearNotes → shows synthesizing-pulse element', () => {
    sp.clearNotes();
    expect(document.getElementById('notes-content').innerHTML).toContain('synthesizing-pulse');
  });

  test('setPlaceholder → shows placeholder element', () => {
    sp.setPlaceholder();
    expect(document.getElementById('notes-content').innerHTML).toContain('placeholder');
  });

  test('renderNotes → calls marked.parse and wraps in markdown-body', () => {
    sp.renderNotes('# Title');
    const content = document.getElementById('notes-content').innerHTML;
    expect(content).toContain('markdown-body');
    expect(content).toContain('parsed');
  });

  test('showErrorInNotes → renders error-block with message', () => {
    sp.showErrorInNotes('Something went wrong');
    const content = document.getElementById('notes-content').innerHTML;
    expect(content).toContain('error-block');
    expect(content).toContain('Something went wrong');
  });
});

// ── Port reconnect ────────────────────────────────────────────────────────────

describe('port lifecycle', () => {
  test('on disconnect, reconnects after timeout', () => {
    jest.useFakeTimers();
    // Trigger disconnect
    chromeMock._port._emit('disconnect', undefined);
    expect(chromeMock.runtime.connect).toHaveBeenCalledTimes(1); // initial connect on load

    jest.advanceTimersByTime(600);
    expect(chromeMock.runtime.connect).toHaveBeenCalledTimes(2); // reconnected
    jest.useRealTimers();
  });
});
