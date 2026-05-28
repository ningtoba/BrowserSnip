# BrowserSnip

**100% client-side video utility sandbox. No uploads, no servers, total privacy.**

BrowserSnip is a modular suite of high-velocity video micro-tools that run entirely inside your browser tab using WebAssembly. Every operation — trimming, resizing, cropping, compressing, converting — happens locally on your machine. Zero video data is sent to any server.

![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)
![React](https://img.shields.io/badge/React-18-61dafb)
![Vite](https://img.shields.io/badge/Vite-6-646cff)

---

## Table of Contents

- [Philosophy](#philosophy)
- [Features](#features)
- [Screenshot](#screenshot)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Deployment](#deployment)
- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [Module Reference](#module-reference)
- [Browser Support](#browser-support)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Philosophy

BrowserSnip is **not** a timeline-based video editor (like CapCut, Premiere, or iMovie). It is a **Video Utility Sandbox** — a collection of focused, single-purpose micro-tools. Each tool solves one everyday video task instantly and securely.

### Core Principles

- **No server footprint.** All transcoding, cutting, and manipulation runs in your browser via [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). Your files never leave your device.
- **Instant start, fast execution.** The UI avoids heavy abstractions. It should feel like a lightning-fast native utility, not a bloated web app.
- **Frictionless output.** One-click copy-to-clipboard, drag-to-export, instant download. Get your processed file and move on.

---

## Features

### 9 Micro-Tools

| Tool | Description |
|------|-------------|
| **Trim & Cut** | Frame-accurate trimming with dual-handle scrub bar. Lossless stream copy (near-instant) or accurate re-encode modes. |
| **Resize** | Scale video to standard resolutions (1080p, 720p, 480p, 360p) or custom dimensions. Locks aspect ratio by default. |
| **Crop & Reframe** | Convert horizontal video to vertical (9:16 TikTok/Reels), square (1:1), or cinematic (21:9). Direct crop or blurred sidebar padding. |
| **Compress** | Target specific file size limits (10MB, 25MB, 50MB, 100MB, 250MB). Automatically calculates the required video bitrate from duration. |
| **GIF Converter** | Convert short clips to high-quality looping GIFs with dual-pass palette generation. Capped at 10 seconds for memory safety. |
| **Audio Tools** | Mute/strip audio layers, extract standalone MP3, or adjust volume from 0% to 300%. |
| **Speed Control** | Create timelapse or slow-motion. Presets at 0.25x, 0.5x, 1.5x, 2.0x, and 4.0x. Synchronizes PTS and audio tempo. |
| **Privacy Purge** | Strip all metadata, EXIF, location tags, and creation markers. Near-instant stream copy — no re-encode needed. |
| **Stitch & Merge** | Concatenate multiple videos in sequence. Drag-and-drop file queue with reorder. |

### Cross-Cutting Features

- **Live FFmpeg log streaming** — Real-time progress bar with parsed timecode, frame count, and FPS
- **Copy to Clipboard** — Paste processed video directly into Slack, Discord, or Teams without saving to disk
- **Memory guardrails** — Polite warning banner for files over 500MB to prevent WASM out-of-memory crashes
- **Dark mode** — Developer-grade dark aesthetic with zinc/slate backgrounds and indigo interactive elements

---

## Tech Stack

| Concern | Technology |
|---------|-----------|
| Framework | React 18 with TypeScript |
| Build Tool | Vite 6 (static bundler) |
| Video Engine | `@ffmpeg/ffmpeg` v0.12+ (multi-threaded WebAssembly) |
| State Management | Zustand v5 |
| Styling | TailwindCSS 3 |
| Routing | React Router v6 |

ffmpeg.wasm runs a full FFmpeg binary compiled to WebAssembly. This gives BrowserSnip access to the same codecs, filters, and processing pipelines as native FFmpeg — entirely inside the browser sandbox.

---

## Getting Started

### Prerequisites

- **Node.js** 18 or later
- **npm** 9 or later
- A modern browser (Chrome 91+, Firefox 90+, Edge 91+, Safari 16.4+)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/your-username/browsersnip.git
cd browsersnip

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open `http://localhost:5173` in your browser.

### Important: Cross-Origin Isolation

ffmpeg.wasm requires `SharedArrayBuffer`, which browsers only expose when the page is **cross-origin isolated**. The Vite dev server is pre-configured to serve the required headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If you see errors about `SharedArrayBuffer` being undefined, verify the dev server is running (not a static file open) and check that the headers are present in the Network tab.

### Build for Production

```bash
npm run build
```

The output lands in `dist/` and can be deployed to any static host.

---

## Deployment

### Vercel / Cloudflare Pages / Netlify

These platforms support custom headers. Configure the following in your deployment settings:

| Platform | Configuration |
|----------|--------------|
| **Vercel** | Add a `vercel.json` with the `headers` array (see below) |
| **Cloudflare Pages** | Add a `_headers` file in the output directory |
| **Netlify** | Add a `netlify.toml` or `_headers` file |

**vercel.json:**

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

**Cloudflare Pages `_headers`:**

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

### GitHub Pages

GitHub Pages does not allow setting custom HTTP headers. As a workaround, BrowserSnip includes [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) — a service worker that intercepts all requests and injects the cross-origin isolation headers client-side.

This file (`public/coi-serviceworker.js`) is loaded automatically in `index.html`. No additional configuration is needed when deploying to GitHub Pages.

**Known trade-off:** The service worker approach adds a brief initialization delay on first visit (~100-200ms while the worker registers). Subsequent visits are fast since the worker is cached.

---

## Architecture

### Directory Structure

```
src/
├── main.tsx                    # Application entry point
├── App.tsx                     # Router: / (Dashboard) → /tool/:toolId (Workspace)
├── index.css                   # Tailwind directives + custom styles
│
├── lib/
│   ├── ffmpeg/
│   │   ├── core.ts             # FFmpeg WASM instance management
│   │   ├── commands.ts         # FFmpeg argument builders for all 9 tools
│   │   ├── log-parser.ts       # Regex-based progress extraction from stderr
│   │   └── types.ts            # FFmpeg-specific type definitions
│   ├── utils/
│   │   ├── time.ts             # HH:MM:SS.ms formatting and parsing
│   │   ├── bitrate.ts          # Target-size bitrate calculator
│   │   ├── clipboard.ts        # Clipboard API wrapper + download helper
│   │   └── aspect-ratio.ts     # Resolution presets and ratio calculations
│   └── constants.ts            # Tool definitions (id, name, description, icon)
│
├── stores/
│   ├── file-store.ts           # Input file(s), metadata, large-file detection
│   ├── process-store.ts        # FFmpeg progress, logs, output blob, errors
│   └── ui-store.ts             # Active tool, sidebar state, log monitor toggle
│
├── hooks/
│   └── useFFmpeg.ts            # Primary hook: orchestrate FFmpeg lifecycle
│
├── types/
│   └── index.ts                # Shared TypeScript interfaces
│
├── components/
│   ├── dashboard/
│   │   ├── Dashboard.tsx       # Landing page with 9 tool cards
│   │   └── ToolCard.tsx        # Individual tool card with glow hover effect
│   ├── layout/
│   │   └── ToolWorkspace.tsx   # Split view: sidebar (import + params) + main (preview + output)
│   ├── player/
│   │   ├── VideoPreview.tsx    # HTML5 video element with input/output source
│   │   └── TrimScrubber.tsx    # Dual-handle range slider with pointer capture
│   ├── tools/
│   │   ├── TrimTool.tsx        # Module 1: Trim & Cut
│   │   ├── ResizeTool.tsx      # Module 2: Resolution Scaling
│   │   ├── CropTool.tsx        # Module 3: Crop & Reframe
│   │   ├── CompressTool.tsx    # Module 4: Target-Size Compressor
│   │   ├── GifTool.tsx         # Module 5: Video-to-GIF Converter
│   │   ├── AudioTool.tsx       # Module 6: Audio Manipulation
│   │   ├── SpeedTool.tsx       # Module 7: Playback Speed
│   │   ├── MetadataTool.tsx    # Module 8: Privacy Purge
│   │   └── StitchTool.tsx      # Module 9: Linear Video Stitcher
│   └── ui/
│       ├── FileDropZone.tsx    # Drag-and-drop file import with >500MB detection
│       ├── MemoryWarning.tsx   # Yellow banner for large file warnings
│       ├── ProgressBar.tsx     # Animated progress with FFmpeg time/frame/fps stats
│       ├── LogMonitor.tsx      # Scrollable monospaced FFmpeg log viewer
│       └── OutputActions.tsx   # Download + Copy to Clipboard buttons with preview
```

### Data Flow

```
User drops file
    │
    ▼
FileDropZone → file-store (File + isLargeFile)
    │
    ▼
User selects tool on Dashboard → navigates to /tool/:toolId
    │
    ▼
ToolWorkspace renders the tool component (e.g., TrimTool)
    │
    ▼
User adjusts parameters → local React state
    │
    ▼
User clicks "Process" → useFFmpeg hook:
    │  1. Creates FFmpeg WASM instance
    │  2. Writes input file to MEMFS (in-memory filesystem)
    │  3. Runs FFmpeg command with tool-specific arguments
    │  4. Parses stderr log stream → process-store (progress, logs)
    │  5. Reads output file from MEMFS → Blob → Object URL
    │  6. Sets output in process-store
    │
    ▼
OutputActions renders Download + Copy to Clipboard buttons
```

### State Management

Three Zustand stores isolate different concerns:

| Store | Purpose | Key Keys |
|-------|---------|----------|
| `file-store` | Input file management | `file`, `files[]`, `metadata`, `isLargeFile` |
| `process-store` | FFmpeg lifecycle | `isProcessing`, `progress`, `logs[]`, `outputBlob`, `outputUrl`, `error` |
| `ui-store` | UI state | `activeTool`, `sidebarOpen`, `showLogMonitor` |

Zustand was chosen because it minimizes re-renders — critical when FFmpeg's log stream fires at high frequency. The log parsing hook accumulates lines in a plain array and only pushes batched updates to the store every ~10 log lines to prevent React render thrashing.

---

## How It Works

### FFmpeg WebAssembly

When you first process a video, BrowserSnip downloads the ffmpeg.wasm core (~31 MB compressed). It is cached by the browser, so subsequent operations start faster. The core is loaded from [unpkg.com](https://unpkg.com) by default.

The application detects whether your browser supports multi-threaded WebAssembly (`SharedArrayBuffer` + `crossOriginIsolated`) and loads the optimized multi-threaded core if available, or falls back to single-threaded.

### Processing Pipeline

1. **Input** — The file is read into an `ArrayBuffer` using the FileReader API
2. **Write to MEMFS** — `ffmpeg.writeFile()` copies the binary into FFmpeg's in-memory virtual filesystem
3. **Execute** — `ffmpeg.exec()` runs the FFmpeg command inside the WASM sandbox
4. **Monitor** — `ffmpeg.on('log')` fires for each stderr line; the log parser extracts `time=HH:MM:SS.ms` and converts it to a progress percentage
5. **Read output** — `ffmpeg.readFile()` reads the processed file back as `Uint8Array`
6. **Create Blob** — A `Blob` is created with the appropriate MIME type (`video/mp4`, `image/gif`, or `audio/mpeg`)
7. **Object URL** — `URL.createObjectURL(blob)` creates a local URL for preview and download

### Memory Management

Browser WebAssembly has a ~4 GB addressable memory ceiling per tab. To prevent crashes:

- Files over **500 MB** trigger a yellow warning banner advising the user to compress or scale down first
- The FFmpeg instance is terminated via `ffmpeg.terminate()` between operations to fully release WASM memory
- Old Object URLs are revoked via `URL.revokeObjectURL()` when new output replaces previous output
- The GIF converter caps input segments at **10 seconds** to keep palette generation within safe memory bounds

### Bitrate Calculation (Compress Tool)

The Compress tool uses a two-pass bitrate formula:

```
B_v = (S_t × 1024 × 8 / D) - B_a
```

Where:
- `B_v` = target video bitrate (kbps)
- `S_t` = target file size (MB)
- `D` = video duration (seconds)
- `B_a` = audio bitrate (fixed at 128 kbps)

A buffer size of `2 × B_v` is used for rate control stability. The result is displayed in real-time as the user adjusts the target size.

---

## Module Reference

### Trim & Cut

| Parameter | Description |
|-----------|-------------|
| `startTime` | Trim start in seconds (0 to duration) |
| `endTime` | Trim end in seconds (startTime to duration) |
| `mode` | `lossless` — stream copy at nearest keyframes (fast, no quality loss) |
| | `accurate` — re-encode for frame-precise cuts (slower, slight quality loss) |

FFmpeg equivalent:
```bash
# Lossless
ffmpeg -ss 00:00:01.500 -to 00:00:30.000 -i input.mp4 -c copy output.mp4

# Accurate
ffmpeg -ss 00:00:01.500 -to 00:00:30.000 -i input.mp4 -c:v libx264 -crf 23 -c:a aac output.mp4
```

### Resize

| Preset | Resolution |
|--------|------------|
| 1080p | 1920 × 1080 |
| 720p | 1280 × 720 |
| 480p | 854 × 480 |
| 360p | 640 × 360 |
| Custom | User-defined width × height |

### Crop & Reframe

| Aspect Ratio | Use Case |
|--------------|----------|
| 9:16 | TikTok, Instagram Reels, YouTube Shorts |
| 1:1 | Instagram square posts, profile pictures |
| 21:9 | Cinematic widescreen |

Two modes:
- **Direct Crop** — Physically removes pixels outside the target frame
- **Blurred Padding** — Scales and blurs the original as a background layer behind the cropped frame (preserves all original content)

### Compress

| Target Size | Typical Use |
|-------------|-------------|
| 10 MB | Email attachment limits |
| 25 MB | Free Discord tier, WhatsApp |
| 50 MB | Standard Discord, Telegram |
| 100 MB | Slack, Microsoft Teams |
| 250 MB | Large file transfers |

### GIF Converter

| Parameter | Range | Default | Notes |
|-----------|-------|---------|-------|
| Start Time | 0 – 60s | 0s | Where to begin the clip |
| Duration | 0.5 – 10s | 3s | Capped at 10s for WASM memory safety |
| FPS | 10, 15, 20, 30 | 15 | Lower FPS = smaller file |
| Width | 240 – 720px | 480px | Height auto-calculated maintaining aspect ratio |

Uses FFmpeg's two-pass palette generation (`palettegen` + `paletteuse`) with Lanczos scaling for smooth downscaling and reduced color banding.

### Audio Tools

| Mode | Output | Use Case |
|------|--------|----------|
| Mute | MP4 (no audio) | Remove unwanted background noise, prepare for voiceover |
| Extract MP3 | MP3 | Isolate audio track for podcasts, ringtones, sampling |
| Volume | MP4 | Boost quiet audio (up to 300%) or reduce loud audio |

### Speed Control

| Speed | Effect | PTS Factor | Audio Tempo |
|-------|--------|------------|--------------|
| 0.25× | Quarter-speed slow-motion | `setpts=4.0*PTS` | `atempo=0.25` |
| 0.5× | Half-speed slow-motion | `setpts=2.0*PTS` | `atempo=0.5` |
| 1.0× | Normal (no change) | — | — |
| 1.5× | Slight speed-up | `setpts=0.667*PTS` | `atempo=1.5` |
| 2.0× | Double-speed timelapse | `setpts=0.5*PTS` | `atempo=2.0` |
| 4.0× | Fast timelapse | `setpts=0.25*PTS` | `atempo=4.0` |

### Privacy Purge

Removes all of the following from the video container:

- Global and stream-level metadata
- EXIF data
- GPS location tags
- Creation date and software markers
- Chapter markers
- Cover art / embedded thumbnails

This uses stream copy (`-c copy`), so it completes in seconds without re-encoding.

### Stitch & Merge

Concatenates multiple videos sequentially using FFmpeg's concat demuxer. The videos must share the same codec, resolution, and frame rate for stream copy to work. Drag cards in the queue to reorder before processing.

---

## Browser Support

| Browser | Minimum Version | Notes |
|---------|----------------|-------|
| Chrome | 91+ | Full support |
| Edge | 91+ | Full support |
| Firefox | 90+ | Full support |
| Safari | 16.4+ | Requires experimental features for SharedArrayBuffer |
| Opera | 77+ | Full support |

**Mobile browsers:** Safari on iOS 16.4+ and Chrome on Android 91+ are supported. The UI is responsive and collapses to single-column layout below 768px viewport width.

### Checking Cross-Origin Isolation

Open the DevTools console. If you see:

```
Cross-Origin isolation is enabled
```

ffmpeg.wasm will use the multi-threaded core for faster processing. If you see errors about `SharedArrayBuffer`, verify your deployment is serving the correct headers (see [Deployment](#deployment)).

---

## Known Limitations

### File Size

- **Soft limit: 500 MB.** Files above this trigger a warning banner. The browser tab may crash for files approaching or exceeding 1 GB due to WebAssembly memory limits (max ~4 GB addressable, shared between input, output, and working memory).
- **Workaround:** Use the Compress or Resize tool first, or split large files before importing.

### Processing Speed

- ffmpeg.wasm is **5–10x slower** than native FFmpeg. A 30-second 1080p video re-encode might take 2–5 minutes, depending on your hardware.
- **Stream copy** operations (lossless trim, metadata strip, mute) are near-instant regardless of video length.
- **Re-encode** operations (resize, speed, accurate trim) scale with video duration and resolution.

### Codec Support

- **Input:** BrowserSnip accepts any format your browser can decode (`video/*` MIME type), subject to the codecs available in ffmpeg.wasm (H.264, H.265/HEVC, VP8, VP9, AV1, MP3, AAC, etc.)
- **Output:** All tools output **H.264 video + AAC audio in MP4 container**, except:
  - GIF Converter outputs `.gif`
  - MP3 Extract outputs `.mp3`

### Clipboard API

- The "Copy to Clipboard" feature uses `navigator.clipboard.write()` with `ClipboardItem`. This is supported in Chrome, Edge, and Opera. Firefox and Safari have limited or no support for copying non-text MIME types.
- **Fallback:** Use the "Download File" button, then drag the downloaded file into your target app.

---

## Contributing

Contributions are welcome. BrowserSnip is designed to be approachable — each tool is a self-contained component with a clear input → FFmpeg command → output flow.

### Development Setup

```bash
npm install
npm run dev
```

### Code Conventions

- **TypeScript** throughout — no `any` in application code
- **Components** — one component per file, named exports, Props interface for each
- **FFmpeg commands** — all argument builders live in `src/lib/ffmpeg/commands.ts` and are pure functions
- **State** — use Zustand stores for cross-component state, local React state for tool-specific parameter UI
- **Styling** — Tailwind utility classes, dark mode by default, zinc/slate palette

### Adding a New Tool

1. Add a type definition in `src/types/index.ts`
2. Add the tool definition to the `TOOLS` array in `src/lib/constants.ts`
3. Create an FFmpeg command builder in `src/lib/ffmpeg/commands.ts`
4. Create the tool component in `src/components/tools/`
5. Register it in `TOOL_COMPONENTS` in `src/components/layout/ToolWorkspace.tsx`

### Before Submitting a PR

```bash
npm run build      # Must pass with no errors
npx tsc --noEmit   # Must pass with no type errors
```

---

## License

MIT © BrowserSnip Contributors

---

## Acknowledgments

- [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) — FFmpeg compiled to WebAssembly by Jerome Wu and contributors
- [FFmpeg](https://ffmpeg.org) — The universal multimedia toolkit
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) — Cross-origin isolation polyfill by Gideon Zuidhof
- [Zustand](https://github.com/pmndrs/zustand) — State management by Poimandres
- [TailwindCSS](https://tailwindcss.com) — Utility-first CSS framework
