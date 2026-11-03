# FilmFlex

**FilmFlex** is a RAM-based torrent streaming server.

It takes the battle-tested [peerflix](https://github.com/mafintosh/peerflix) engine and swaps its default disk-backed chunk storage for a **pure in-memory (RAM) chunk store**. Movies and TV shows therefore stream straight out of memory — no writes to the disk, no temp folders, no cleanup.

Your theory. Your build. Your server. **Free to download, free to use.**

---

## Table of contents

- [Why FilmFlex](#why-filmflex)
- [How it works](#how-it-works)
- [The memory model](#the-memory-model)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Trackers](#trackers)
- [Troubleshooting](#troubleshooting)
- [Disclaimer](#disclaimer)
- [Credits](#credits)

---

## Why FilmFlex

Regular streaming torrent clients (like the stock `peerflix`) download a torrent through an on-disk chunk store — every piece gets written to a file under the temp directory before it is streamed to the player.

That works, but on low-RAM or embedded devices (Termux on Android, Raspberry Pi, NAS boxes, thin VPS instances) disk I/O adds latency and disk space is wasted on partially downloaded data.

**FilmFlex changes the storage backend:**

> Allocate RAM. Split the torrent into chunks. Stream. Forget.

Everything is held in RAM only, and once a chunk has been streamed past it is dropped from memory.

## How it works

1. You give FilmFlex a **torrent hash** (or build a magnet link around it):

   ```
   magnet:?xt=urn:btih:<YOUR_TORRENT_HASH>
   ```

2. FilmFlex creates a `magnet:?xt=urn:btih:<hash>` link and hands it to the **peerflix** engine (which wraps the [torrent-stream](https://github.com/mafintosh/torrent-stream) engine).

3. The engine normally uses a disk-backed chunk store. FilmFlex injects a **custom storage factory** that implements the same *abstract-chunk-store* interface:

   ```js
   storage(pieceLength, opts) // -> { chunkLength, get, put, close, destroy }
   ```

4. The torrent is split into **chunks**. By default each chunk is **50 MB** (`CHUNK_SIZE` env var). Torrent *pieces* (normally 256 KB – 4 MB each) are transparently assembled into these larger chunks.

5. Pieces arrive from peers via `put()` and live in RAM only.

6. When the engine reads a chunk via `get()`, the data is served straight from RAM.

7. When a chunk has been fully streamed past, it is **evicted** from RAM, keeping only the rolling window needed for smooth playback.

8. The peerflix HTTP server serves the stream, with HTTP **Range requests**, an **HLS playlist** and a **JSON stats endpoint**.

## The memory model

This is the core of the FilmFlex theory.

### Chunk states

| Symbol | Meaning |
| ------ | ------- |
| `o` | A downloaded chunk |
| `-` | A downloading chunk |
| `x` | A reserved chunk that has not been downloaded yet |
| `p` | The chunk that is currently playing / being streamed |

### Memory slots

```
Memory  | Playing (streaming)
________|____________________
x x x x | no
x x x - | no
x x - o | no
x - o o | yes
- o o x | yes
o o o x | yes
```

When we have **two downloaded chunks**, we stream one of them and prepare the next. The third slot is downloading the upcoming chunk.

```
- o o x | yes
o o o x | yes
```

### The rule

> At any moment, from here and on: **two chunks are downloaded, one of them is being streamed, the third chunk is downloading, and the last one is ready to receive the next download.**

In other words, FilmFlex keeps a small, always-ready rolling buffer:

```
[ playing ] [ buffered / next ] [ downloading ]
```

Only the chunks that are actually in use are held in RAM, which is what keeps the memory footprint tiny despite streaming from memory.

## Features

- **RAM-only storage** — no disk writes, no temp folders, no cleanup on exit (data lives in RAM).
- **Chunked caching** — torrents are split into configurable chunks (default **50 MB**).
- **Bounded cache** — only `MAX_CACHE_MB` (default **200 MB**) of completed chunks are kept in RAM; older ones are evicted.
- **Rolling buffer** — two downloaded chunks in flight: one playing, one ready, one downloading.
- **Range-request streaming** — via the underlying peerflix server (HTTP 206 responses, `Accept-Ranges`).
- **HLS + JSON endpoints** — `/.m3u` playlist and `/.json` stats out of the box.
- **Termux-friendly trackers** — TCP/HTTP/WebSocket trackers only, no UDP (avoids blocking issues on Termux).
- **Graceful shutdown** — `SIGINT` / `SIGTERM` handled.

## Requirements

- [Node.js](https://nodejs.org) >= 12 (recommended)
- npm
- A valid torrent hash / magnet link for legal content
- An HTTP client that understands Range requests (browser via HLS, VLC, VLC mobile, mpv, etc.)

No `ffmpeg` needed for plain HTTP-range streaming.

## Installation

From GitHub (recommended — always get the latest version):

```bash
git clone https://github.com/gladiatort571/FilmFlex.git
cd FilmFlex
npm install
node stream.js <TORRENT_HASH>
```

Or install directly from the source tree:

```bash
npm install -g .
filmflex <TORRENT_HASH>
```

## Usage

```bash
node stream.js <TORRENT_HASH>
```

or, if installed globally:

```bash
filmflex <TORRENT_HASH>
```

Example:

```bash
node stream.js 0123456789abcdef0123456789abcdef01234567
```

FilmFlex will print the local stream address once the engine is ready:

```
http://localhost:PORT/
```

Open that URL in your player:

```bash
vlc http://localhost:PORT/
```

or in a browser (HLS) / mobile app / whatever speaks HTTP range requests.

## Configuration

| Variable / Option | Default | Description |
| ------------------- | ------- | ----------- |
| `CHUNK_SIZE` | `50` | Chunk size in MB. Size of the in-RAM chunks the torrent is split into. |
| `MAX_CACHE_MB` | `200` | Maximum amount of completed chunks kept in RAM before eviction. |
| `TMPDIR` | `/tmp` | Temp root (unused when using RAM storage). |
| `connections` | `50` | Max peers connected to the swarm (passed to the engine). |
| Port | random | HTTP server port (random by default; can be set via engine options). |

Tune via environment variables:

```bash
CHUNK_SIZE=30 MAX_CACHE_MB=150 node stream.js <TORRENT_HASH>
```

## HTTP API

When the engine is ready it exposes (via peerflix):

| Endpoint | Description |
| -------- | ----------- |
| `/` | The stream. Supports HTTP Range requests (`206 Partial Content`, `Accept-Ranges: bytes`). |
| `/.json` | JSON stats: total length, downloaded, uploaded, speeds, peer counts. |
| `/.m3u` | HLS playlist for the selected file. |
| `/<index>` | Specific file from the torrent (multi-file support). |

## Trackers

FilmFlex uses TCP/HTTP/WebSocket trackers to avoid UDP blocking issues (e.g. on Termux):

```
http://open.tracker.cl:80/announce
http://tracker.opentrackr.org:1337/announce
http://openbittorrent.com:80/announce
wss://tracker.openwebtorrent.com:443/announce
```

## Troubleshooting

- `Error: Please provide a torrent hash!` — pass a torrent hash / magnet to the CLI.
- Nothing plays / connection issues — verify the hash and your network.
- Low-memory devices — lower `CHUNK_SIZE` and/or `MAX_CACHE_MB`.

## Disclaimer

FilmFlex is an independent, open-source streaming tool. Only stream content you have the rights to. The developers do not endorse or support the use of this tool for copyrighted material without permission.

## Credits

- [peerflix](https://github.com/mafintosh/peerflix) — Mathias Buus & contributors (MIT)
- [torrent-stream](https://github.com/mafintosh/torrent-stream) — Mathias Buus & contributors (MIT)
- Everyone who built the pieces this is made of.
