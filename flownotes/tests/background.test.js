'use strict';

// Helpers ─────────────────────────────────────────────────────────────────────

/** Build a minimal chrome mock. Tests override specific methods as needed. */
function makeChrome(overrides = {}) {
  const store = {};
  return {
    runtime: {
      onConnect: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn() },
    },
    tabs: {
      onActivated: { addListener: jest.fn() },
      onUpdated: { addListener: jest.fn() },
      get: jest.fn(),
      query: jest.fn(),
    },
    scripting: {
      executeScript: jest.fn(),
    },
    sidePanel: { open: jest.fn() },
    action: { onClicked: { addListener: jest.fn() } },
    storage: {
      local: {
        _store: store,
        get: jest.fn((keys, cb) => {
          const result = {};
          const keyArr = Array.isArray(keys) ? keys : [keys];
          keyArr.forEach(k => { if (store[k] !== undefined) result[k] = store[k]; });
          if (cb) cb(result);
          return Promise.resolve(result);
        }),
        set: jest.fn((data, cb) => {
          Object.assign(store, data);
          if (cb) cb();
          return Promise.resolve();
        }),
      },
    },
    ...overrides,
  };
}

/** Build a ReadableStream that emits the provided Uint8Array chunks sequentially. */
function makeStream(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

/** Encode a string as Uint8Array. */
const enc = (s) => new TextEncoder().encode(s);

/** Format a Claude SSE data line. */
const sseChunk = (text) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text } })}\n`;

// Load module ─────────────────────────────────────────────────────────────────

let bg;

beforeEach(() => {
  global.chrome = makeChrome();
  jest.resetModules();
  bg = require('../background.js');
});

afterEach(() => {
  delete global.chrome;
});

// ── buildUserMessage ──────────────────────────────────────────────────────────

describe('buildUserMessage', () => {
  test('single page — contains topic, source header, url, text', () => {
    const msg = bg.buildUserMessage('battery recycling', [
      { title: 'Li-Ion Overview', url: 'https://example.com/li-ion', text: 'Lithium ions are recovered.' },
    ]);
    expect(msg).toContain('Research topic: "battery recycling"');
    expect(msg).toContain('### Source 1: Li-Ion Overview');
    expect(msg).toContain('URL: https://example.com/li-ion');
    expect(msg).toContain('Lithium ions are recovered.');
  });

  test('multiple pages — numbered in order, separated by ---', () => {
    const pages = [
      { title: 'Page A', url: 'https://a.com', text: 'Content A' },
      { title: 'Page B', url: 'https://b.com', text: 'Content B' },
      { title: 'Page C', url: 'https://c.com', text: 'Content C' },
    ];
    const msg = bg.buildUserMessage('topic', pages);
    expect(msg).toContain('Source 1: Page A');
    expect(msg).toContain('Source 2: Page B');
    expect(msg).toContain('Source 3: Page C');
    expect(msg).toContain('Synthesize my notes from these 3 sources');
    // Separated by ---
    const separatorCount = (msg.match(/^---$/gm) || []).length;
    expect(separatorCount).toBe(2); // between 1-2 and 2-3
  });

  test('special characters in topic are preserved', () => {
    const msg = bg.buildUserMessage('AI & "ethics"', [
      { title: 'T', url: 'https://t.com', text: 'text' },
    ]);
    expect(msg).toContain('Research topic: "AI & "ethics""');
  });

  test('empty pages array — returns message with 0 sources', () => {
    const msg = bg.buildUserMessage('topic', []);
    expect(msg).toContain('0 sources');
  });
});

// ── captureTab ────────────────────────────────────────────────────────────────

describe('captureTab', () => {
  test('executeScript throws → returns null (chrome://, CSP-blocked, etc.)', async () => {
    chrome.scripting.executeScript.mockRejectedValue(new Error('Cannot access chrome://'));
    const result = await bg.captureTab(1);
    expect(result).toBeNull();
  });

  test('results[0].result is null → returns null', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: null }]);
    const result = await bg.captureTab(1);
    expect(result).toBeNull();
  });

  test('text shorter than 100 chars → returns null (empty/boilerplate page)', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{
      result: { url: 'https://x.com', title: 'X', text: 'Too short.' },
    }]);
    const result = await bg.captureTab(1);
    expect(result).toBeNull();
  });

  test('valid capture → returns page object', async () => {
    const page = { url: 'https://x.com', title: 'X', text: 'A'.repeat(200) };
    chrome.scripting.executeScript.mockResolvedValue([{ result: page }]);
    const result = await bg.captureTab(1);
    expect(result).toEqual(page);
  });

  test('results array empty → returns null', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: undefined }]);
    const result = await bg.captureTab(1);
    expect(result).toBeNull();
  });
});

// ── onTabCaptured ─────────────────────────────────────────────────────────────

describe('onTabCaptured', () => {
  const page1 = { url: 'https://a.com', title: 'A', text: 'A'.repeat(200) };
  const page2 = { url: 'https://b.com', title: 'B', text: 'B'.repeat(200) };

  test('null page → no storage write, no port message', async () => {
    await bg.onTabCaptured(null);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  test('first page → stored, posts waiting message', async () => {
    const posted = [];
    const port = { postMessage: (m) => posted.push(m), onDisconnect: { addListener: jest.fn() } };
    chrome.runtime.onConnect.addListener.mock.calls[0]?.[0]?.(port);

    // Re-require so the port listener is registered with our mock
    jest.resetModules();
    global.chrome = makeChrome();
    const fresh = require('../background.js');

    // Simulate port connect
    const connectCb = chrome.runtime.onConnect.addListener.mock.calls[0][0];
    connectCb({ name: 'sidepanel', postMessage: (m) => posted.push(m), onDisconnect: { addListener: jest.fn() } });

    await fresh.onTabCaptured(page1);

    const stored = chrome.storage.local._store.pages;
    expect(stored).toHaveLength(1);
    expect(stored[0].url).toBe('https://a.com');
    expect(posted.some(m => m.type === 'waiting' && m.count === 1)).toBe(true);
  });

  test('second unique page → triggers callClaudeStreaming (needs apiKey)', async () => {
    chrome.storage.local._store.pages = [page1];
    chrome.storage.local._store.apiKey = undefined; // no key — will post error not crash
    jest.resetModules();
    global.chrome = makeChrome();
    // Seed storage
    chrome.storage.local._store.pages = [page1];

    const fresh = require('../background.js');

    // Capture posted messages
    const posted = [];
    const connectCb = chrome.runtime.onConnect.addListener.mock.calls[0][0];
    connectCb({ name: 'sidepanel', postMessage: (m) => posted.push(m), onDisconnect: { addListener: jest.fn() } });

    await fresh.onTabCaptured(page2);

    const stored = chrome.storage.local._store.pages;
    expect(stored).toHaveLength(2);
    // No API key → error posted, not a crash
    expect(posted.some(m => m.type === 'error')).toBe(true);
  });

  test('duplicate URL → replaces existing entry (deduplication)', async () => {
    const updatedPage1 = { url: 'https://a.com', title: 'A updated', text: 'A'.repeat(200) };
    jest.resetModules();
    global.chrome = makeChrome();
    chrome.storage.local._store.pages = [page1];

    const fresh = require('../background.js');
    const posted = [];
    const connectCb = chrome.runtime.onConnect.addListener.mock.calls[0][0];
    connectCb({ name: 'sidepanel', postMessage: (m) => posted.push(m), onDisconnect: { addListener: jest.fn() } });

    await fresh.onTabCaptured(updatedPage1);

    const stored = chrome.storage.local._store.pages;
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('A updated');
    // Still only 1 page → waiting
    expect(posted.some(m => m.type === 'waiting' && m.count === 1)).toBe(true);
  });
});

// ── postToPanel ───────────────────────────────────────────────────────────────

describe('postToPanel', () => {
  test('null port → does not throw', () => {
    // No port connected; sidePanelPort is null
    expect(() => bg.postToPanel({ type: 'test' })).not.toThrow();
  });

  test('port.postMessage throws → clears port silently', () => {
    jest.resetModules();
    global.chrome = makeChrome();
    const fresh = require('../background.js');

    const throwingPort = {
      name: 'sidepanel',
      postMessage: jest.fn().mockImplementation(() => { throw new Error('Port closed'); }),
      onDisconnect: { addListener: jest.fn() },
    };
    const connectCb = chrome.runtime.onConnect.addListener.mock.calls[0][0];
    connectCb(throwingPort);

    expect(() => fresh.postToPanel({ type: 'test' })).not.toThrow();
    // Second call should also not throw (port was cleared after first failure)
    expect(() => fresh.postToPanel({ type: 'test' })).not.toThrow();
  });
});

// ── handleTab ─────────────────────────────────────────────────────────────────

describe('handleTab', () => {
  test('session not active → returns early, executeScript never called', async () => {
    // active not set in storage
    jest.resetModules();
    global.chrome = makeChrome();
    const fresh = require('../background.js');

    await fresh.handleTab(42);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  test('session active → calls executeScript', async () => {
    jest.resetModules();
    global.chrome = makeChrome();
    chrome.storage.local._store.active = true;
    chrome.scripting.executeScript.mockResolvedValue([{ result: null }]);
    const fresh = require('../background.js');

    await fresh.handleTab(42);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 42 } })
    );
  });
});

// ── callClaudeStreaming — error paths ─────────────────────────────────────────

describe('callClaudeStreaming error paths', () => {
  function setupWithPort() {
    jest.resetModules();
    global.chrome = makeChrome();
    const fresh = require('../background.js');
    const posted = [];
    const connectCb = chrome.runtime.onConnect.addListener.mock.calls[0][0];
    connectCb({ name: 'sidepanel', postMessage: (m) => posted.push(m), onDisconnect: { addListener: jest.fn() } });
    return { fresh, posted };
  }

  test('no API key → posts error message', async () => {
    const { fresh, posted } = setupWithPort();
    await fresh.callClaudeStreaming('topic', [{ url: 'a', title: 'A', text: 'x' }]);
    expect(posted.some(m => m.type === 'error' && m.message.includes('API key'))).toBe(true);
  });

  test('fetch throws (network error) → posts error message', async () => {
    const { fresh, posted } = setupWithPort();
    chrome.storage.local._store.apiKey = 'sk-ant-test';
    global.fetch = jest.fn().mockRejectedValue(new Error('Failed to fetch'));

    await fresh.callClaudeStreaming('topic', []);
    expect(posted.some(m => m.type === 'error' && m.message.includes('Network error'))).toBe(true);
    delete global.fetch;
  });

  test('non-ok HTTP response → posts error with status code', async () => {
    const { fresh, posted } = setupWithPort();
    chrome.storage.local._store.apiKey = 'sk-ant-test';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_api_key"}',
    });

    await fresh.callClaudeStreaming('topic', []);
    expect(posted.some(m => m.type === 'error' && m.message.includes('401'))).toBe(true);
    delete global.fetch;
  });
});

// ── callClaudeStreaming — streaming ───────────────────────────────────────────

describe('callClaudeStreaming streaming', () => {
  function setupWithPort() {
    jest.resetModules();
    global.chrome = makeChrome();
    chrome.storage.local._store.apiKey = 'sk-ant-test';
    const fresh = require('../background.js');
    const posted = [];
    const connectCb = chrome.runtime.onConnect.addListener.mock.calls[0][0];
    connectCb({ name: 'sidepanel', postMessage: (m) => posted.push(m), onDisconnect: { addListener: jest.fn() } });
    return { fresh, posted };
  }

  test('clean stream → posts stream_start, chunks in order, stream_end', async () => {
    const { fresh, posted } = setupWithPort();
    const body = makeStream([
      enc(sseChunk('Hello ') + sseChunk('world') + '\n'),
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body });

    const pages = [
      { url: 'https://a.com', title: 'A', text: 'x' },
      { url: 'https://b.com', title: 'B', text: 'y' },
    ];
    await fresh.callClaudeStreaming('topic', pages);

    expect(posted[0]).toEqual({ type: 'stream_start', count: 2 });
    const chunks = posted.filter(m => m.type === 'chunk').map(m => m.text);
    expect(chunks).toEqual(['Hello ', 'world']);
    expect(posted[posted.length - 1]).toEqual({ type: 'stream_end', count: 2 });
    delete global.fetch;
  });

  test('partial line split across chunks — reassembled correctly', async () => {
    const { fresh, posted } = setupWithPort();
    // Split the SSE line in the middle across two read() calls
    const fullLine = sseChunk('partial');
    const mid = Math.floor(fullLine.length / 2);
    const body = makeStream([
      enc(fullLine.slice(0, mid)),
      enc(fullLine.slice(mid) + '\n'),
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body });

    await fresh.callClaudeStreaming('topic', []);
    const chunks = posted.filter(m => m.type === 'chunk').map(m => m.text);
    expect(chunks).toContain('partial');
    delete global.fetch;
  });

  test('[DONE] line is skipped without error', async () => {
    const { fresh, posted } = setupWithPort();
    const body = makeStream([
      enc(sseChunk('text') + 'data: [DONE]\n\n'),
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body });

    await expect(fresh.callClaudeStreaming('topic', [])).resolves.not.toThrow();
    expect(posted.filter(m => m.type === 'chunk')[0].text).toBe('text');
    delete global.fetch;
  });

  test('non-content_block_delta events are ignored', async () => {
    const { fresh, posted } = setupWithPort();
    const ignoredEvent = JSON.stringify({ type: 'message_start', message: {} });
    const body = makeStream([
      enc(`data: ${ignoredEvent}\n` + sseChunk('kept') + '\n'),
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body });

    await fresh.callClaudeStreaming('topic', []);
    const chunks = posted.filter(m => m.type === 'chunk').map(m => m.text);
    expect(chunks).toEqual(['kept']);
    delete global.fetch;
  });

  test('malformed JSON in SSE line is swallowed silently', async () => {
    const { fresh, posted } = setupWithPort();
    const body = makeStream([
      enc('data: {not valid json}\n' + sseChunk('after') + '\n'),
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body });

    await expect(fresh.callClaudeStreaming('topic', [])).resolves.not.toThrow();
    const chunks = posted.filter(m => m.type === 'chunk').map(m => m.text);
    expect(chunks).toContain('after');
    delete global.fetch;
  });

  test('accumulated text is saved to storage after stream_end', async () => {
    const { fresh } = setupWithPort();
    const body = makeStream([
      enc(sseChunk('note one ') + sseChunk('note two') + '\n'),
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body });

    await fresh.callClaudeStreaming('topic', []);
    expect(chrome.storage.local._store.savedNotes).toBe('note one note two');
    delete global.fetch;
  });
});
