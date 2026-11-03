#!/usr/bin/env node

const peerflix = require('peerflix');

const hash = (process.argv[2] || '').trim();

if (!hash) {
  console.error('Error: Please provide a torrent hash!');
  console.log('Usage: ff <TORRENT_HASH>');
  process.exit(1);
}

// Use TCP/HTTP/WebSocket-friendly trackers to avoid UDP blocking issues on Termux.
const trackers = [
  'http://open.tracker.cl:80/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'http://openbittorrent.com:80/announce',
  'wss://tracker.openwebtorrent.com:443/announce',
];

let magnetLink = `magnet:?xt=urn:btih:${hash}`;
trackers.forEach((tr) => {
  magnetLink += `&tr=${encodeURIComponent(tr)}`;
});

const MB = 1024 * 1024;

// In-memory (RAM) chunk storage so downloaded chunks never hit the disk.
// Implements the abstract-chunk-store interface expected by torrent-stream,
// using the rolling chunk strategy:
//  - the torrent is split into chunks of `chunkSize` bytes (default 50 MB)
//  - pieces are assembled into chunks that live in RAM only
//  - no disk writes happen, everything stays in RAM
//  - once a chunk has been fully streamed past, it is dropped from RAM
const memoryStorage = (pieceLength, opts) => {
  const chunkSize = (Number((opts && opts.chunkSize) || process.env.CHUNK_SIZE) || 50) * MB;
  const files = (opts && opts.files) || [];
  const totalLength = files.reduce((sum, f) => sum + (f.length || 0), 0);
  const endOfPiece = (index) => Math.min((index + 1) * pieceLength, totalLength || (index + 1) * pieceLength);
  const endOfChunk = (chunkId) => Math.min((chunkId + 1) * chunkSize, totalLength || (chunkId + 1) * chunkSize);
  const maxCacheBytes = (Number((opts && opts.maxCacheBytes) || process.env.MAX_CACHE_MB) || 200) * MB;

  const chunks = new Map();
  let servedUpTo = 0;

  const getChunk = (chunkId) => {
    let chunk = chunks.get(chunkId);
    if (!chunk) {
      chunk = {
        start: chunkId * chunkSize,
        end: endOfChunk(chunkId),
        pieces: new Map(),
        complete: false,
      };
      chunks.set(chunkId, chunk);
    }
    return chunk;
  };

  const checkComplete = (chunk) => {
    const first = Math.floor(chunk.start / pieceLength);
    const last = Math.ceil(chunk.end / pieceLength);
    let complete = true;
    for (let i = first; i < last; i++) {
      if (!chunk.pieces.has(i)) {
        complete = false;
        break;
      }
    }
    chunk.complete = complete;
    return complete;
  };

  const readRange = (chunk, start, end) => {
    const out = [];
    let pos = start;
    while (pos < end) {
      const pieceIndex = Math.floor(pos / pieceLength);
      const pieceEnd = endOfPiece(pieceIndex);
      const buf = chunk.pieces.get(pieceIndex);
      if (!buf) return null;
      out.push(buf.slice(pos - pieceIndex * pieceLength, Math.min(end, pieceEnd) - pieceIndex * pieceLength));
      pos = pieceEnd;
    }
    return out.length === 1 ? out[0] : Buffer.concat(out);
  };

  const evict = () => {
    const keys = Array.from(chunks.keys());
    for (let i = 0; i < keys.length; i++) {
      const chunk = chunks.get(keys[i]);
      if (chunk.complete && chunk.end <= servedUpTo) chunks.delete(keys[i]);
    }
    let cachedBytes = 0;
    chunks.forEach((chunk) => {
      if (chunk.complete) cachedBytes += chunk.end - chunk.start;
    });
    if (cachedBytes <= maxCacheBytes) return;
    const completed = Array.from(chunks.entries())
      .filter(([, chunk]) => chunk.complete)
      .sort((a, b) => a[0] - b[0]);
    for (const [chunkId, chunk] of completed) {
      if (cachedBytes <= maxCacheBytes) break;
      if (chunk.start <= servedUpTo && servedUpTo < chunk.end) continue;
      chunks.delete(chunkId);
      cachedBytes -= chunk.end - chunk.start;
    }
  };

  const get = (index, opts, cb) => {
    if (typeof opts === 'function') return get(index, null, opts);
    const start = (opts && opts.offset) || 0;
    const length = opts && opts.length ? opts.length : null;
    const absStart = index * pieceLength + start;
    const absEnd = length ? absStart + length : endOfPiece(index);
    const chunk = chunks.get(Math.floor(absStart / chunkSize));
    let data = null;
    if (chunk) data = readRange(chunk, absStart, absEnd);
    if (data) {
      servedUpTo = Math.max(servedUpTo, absEnd);
      evict();
    }
    if (cb) process.nextTick(() => cb(null, data));
  };

  const put = (index, buf, cb) => {
    const chunk = getChunk(Math.floor((index * pieceLength) / chunkSize));
    chunk.pieces.set(index, buf);
    checkComplete(chunk);
    evict();
    if (cb) process.nextTick(() => cb(null));
  };

  return {
    chunkLength: pieceLength,
    get,
    put,
    close: (cb) => process.nextTick(() => cb && cb()),
    destroy: (cb) => process.nextTick(() => cb && cb()),
  };
};

const engine = peerflix(magnetLink, {
  connections: 50,
  storage: memoryStorage,
  tmp: process.env.TMPDIR || '/tmp',
});

engine.on('error', (err) => {
  console.error('Peerflix engine error:', err);
  process.exit(1);
});

engine.server.on('listening', () => {
  const port = engine.server.address().port;
  // Success: only display the stream link.
  console.log(`http://localhost:${port}/`);
});

// Graceful shutdown on SIGINT/SIGTERM
const shutdown = () => {
  engine.destroy(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
