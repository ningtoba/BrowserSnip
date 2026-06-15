<p align="center">
  <img src="public/logo.png" alt="BrowserSnip" width="64" height="64">
</p>

<h1 align="center">Browser<span style="color:#6366f1">Snip</span></h1>

<p align="center">
  <strong>100% client-side video &amp; PDF utility sandbox.<br>No uploads. No servers. Total privacy.</strong>
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/TypeScript-5.6-3178c6" alt="TypeScript 5.6"></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/React-18-61dafb" alt="React 18"></a>
  <a href="#tech-stack"><img src="https://img.shields.io/badge/Vite-6-646cff" alt="Vite 6"></a>
  <a href="#browser-support"><img src="https://img.shields.io/badge/WebAssembly-✓-34d399" alt="WebAssembly"></a>
  <a href="#philosophy"><img src="https://img.shields.io/badge/privacy-first-6366f1" alt="Privacy First"></a>
</p>

<br>

---

> **✂ Snip, process, and secure your media — all inside your browser tab.**  
> BrowserSnip is a collection of **34 focused micro-tools** for video and PDF work. Every operation — trimming a video, merging PDFs, compressing to a target size, signing a document, or OCR-scanning a photo — runs locally on your machine through WebAssembly. Nothing touches a server. Nothing leaves your device.

---

<br>

## What is BrowserSnip?

BrowserSnip is **not** a timeline-based video editor like CapCut or Premiere. It's not a desktop PDF suite like Acrobat. It's a **utility sandbox** — a curated set of single-purpose tools that each do one thing well and do it fast.

| | | |
|---|---|---|
| 🎬 **Video Tools** | 8 FFmpeg-powered micro-tools | Trim, resize, crop, compress, GIF, audio, speed, metadata |
| 📄 **PDF Tools** | 26 tools across 6 categories | Merge, split, convert, edit, sign, encrypt, OCR, redact |
| 🔒 **Privacy-first** | Runs entirely in your browser | WebAssembly + SharedArrayBuffer. Zero server footprint |
| ⚡ **Instant results** | Stream-copy where possible | Lossless operations finish in seconds, not minutes |
| 🌑 **Dark mode** | Developer-grade aesthetic | Indigo accent on zinc/slate, designed for long sessions |
| 📱 **Responsive** | Works on desktop and mobile | Hamburger nav, stacked layouts, touch-friendly controls |

<br>

---

## 🎬 Video Tools

Eight focused tools powered by [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) — a full FFmpeg binary compiled to WebAssembly.

| Tool | What it does | Best for |
|------|-------------|----------|
| **Trim & Cut** ✂ | Frame-accurate trimming with dual-handle scrub bar | Cutting intros, removing sections, clipping highlights |
| **Resize** ↔ | Scale to standard resolutions or custom dimensions | Preparing video for specific platforms (YouTube, TikTok) |
| **Crop & Reframe** ⊞ | Convert aspect ratios with direct crop or blurred padding | Repurposing landscape video to vertical short-form |
| **Compress** ↓ | Target specific file sizes with automatic bitrate calculation | Hitting Discord, Slack, email, or messaging limits |
| **GIF Converter** ◉ | Short clips to high-quality GIFs with palette optimization | Memes, reaction GIFs, product demos |
| **Audio Tools** ♪ | Mute, extract MP3, or adjust volume (0%–300%) | Podcast clips, ringtones, boosting quiet recordings |
| **Speed Control** ⏱ | Timelapse and slow-motion from 0.25× to 4.0× | Speed ramps, instructional videos, artistic effects |
| **Privacy Purge** 🛡 | Strip all metadata, EXIF, and location tags | Sharing video safely without leaking creation data |

<br>

## 📄 PDF Tools

Twenty-six tools across six categories. Powered by [pdf-lib](https://github.com/Hopding/pdf-lib), [PDF.js](https://github.com/mozilla/pdf.js), [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), and [ONNX Runtime](https://github.com/microsoft/onnxruntime).

### 📑 Organize PDF

| Tool | Description |
|------|-------------|
| **Merge PDF** | Combine multiple PDFs with drag-and-drop ordering |
| **Split PDF** | Extract by page range, every page, or odd/even separation |
| **Remove Pages** | Delete unwanted pages with a visual page selector |
| **Extract Pages** | Pull out selected pages and save as a new document |
| **Organize PDF** | Drag-and-drop to reorder, duplicate, insert blanks, or delete |
| **Rotate PDF** | Rotate individual pages or the entire document 90°/180°/270° |
| **Scan to PDF** | Camera capture with edge detection and perspective correction |

### ⚡ Optimize PDF

| Tool | Description |
|------|-------------|
| **Compress PDF** | Three-level compression (low/medium/high) with image re-encoding |
| **Repair PDF** | Three-strategy recovery for damaged or corrupted files |

### 📥 Convert to PDF

| Tool | Description |
|------|-------------|
| **Image to PDF** | JPG, PNG, WEBP, GIF, AVIF, and TIFF images to PDF |
| **Digitize Document** | OCR a photo of a document into searchable digital PDF |
| **HTML to PDF** | Convert HTML files or rendered web content to PDF |

### 📤 Convert from PDF

| Tool | Description |
|------|-------------|
| **PDF to Image** | Export pages as JPG, PNG, or WEBP at configurable resolution |
| **PDF to Word** | Extract text and structure into editable .docx format |
| **PDF to Excel** | Extract tables into structured .xlsx spreadsheet data |
| **PDF to PDF/A** | Convert to PDF/A-2b for long-term archival compliance |

### ✏️ Edit PDF

| Tool | Description |
|------|-------------|
| **Add Watermark** | Text or image watermarks with opacity, rotation, tiling, and positioning |
| **Page Numbers** | Custom page numbers with font, size, and position controls |
| **Crop PDF** | Visual crop handles or precise numeric margin input |

### 🔒 PDF Security

| Tool | Description |
|------|-------------|
| **Protect PDF** | Password encryption with 7 fine-grained permissions (AES-128/256, RC4-128) |
| **Unlock PDF** | Remove password protection from encrypted documents |
| **Sign PDF** | Hand-drawn, image, or text signatures with visual drag-and-drop placement |
| **Redact PDF** | True raster-burn redaction — permanent data removal, not visual masking |
| **Compare PDF** | Side-by-side pixel-diff comparison with configurable sensitivity |

<br>

---

## 🧬 How It Works

### Video Pipeline

```
Your video file
  → FileReader → ArrayBuffer
    → ffmpeg.wasm writes to in-memory filesystem (MEMFS)
      → FFmpeg executes your chosen operation
        → Log parser reads stderr for real-time progress
          → Output read back as Uint8Array → Blob → Object URL
            → Preview in-browser with one-click download
```

### PDF Pipeline

```
Your PDF file
  → FileReader → ArrayBuffer
    → pdf-lib loads + parses the document
      → Pure function applies the transformation (merge, split, sign, etc.)
        → Document serialized back to Uint8Array → Blob → Object URL
          → PDF.js renders pages to canvas for live preview
            → Download, copy to clipboard, or preview in-browser
```

### Why WebAssembly?

| | Traditional SaaS | BrowserSnip |
|---|---|---|
| **Where data lives** | Uploaded to remote servers | Stays in your browser tab |
| **Processing speed** | Native (fast) | 5–10× slower than native (acceptable for one-off tasks) |
| **Privacy model** | Trust the provider | Verify nothing leaves — open DevTools Network tab |
| **File size limits** | Provider-defined | ~500 MB soft limit (WebAssembly memory ceiling) |
| **Availability** | Requires internet | Works offline after first load |

<br>

---

## 🏗 Tech Stack

| Layer | Technology | What it powers |
|-------|-----------|----------------|
| **UI Framework** | React 18 + TypeScript 5.6 | Component architecture, type safety |
| **Build** | Vite 6 | Dev server, bundling, code splitting |
| **Routing** | React Router v6 (hash) | Static-host-friendly navigation |
| **State** | Zustand v5 | Stores for files, processing, and UI with session persistence |
| **Styling** | TailwindCSS 3 | Utility-first dark theme with custom design tokens |
| **Video Engine** | `@ffmpeg/ffmpeg` v0.12 | FFmpeg compiled to WebAssembly (single + multi-threaded cores) |
| **PDF Manipulation** | `pdf-lib` v1.17 | Create, modify, merge, split, sign, watermark PDFs |
| **PDF Rendering** | `pdfjs-dist` v4.0 | Canvas-based page preview, thumbnails, text extraction |
| **PDF Encryption** | `@pdfsmaller/*-lite` | RC4 128-bit encrypt/decrypt |
| **OCR** | `ppu-paddle-ocr` v5.8 + `onnxruntime-web` v1.26 | Text detection and recognition from document images |
| **Document Export** | `docx` v9.7, `xlsx` v0.18, `html2canvas` v1.4 | Word/Excel generation, HTML→Image conversion |

<br>

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+  •  **npm** 9+  •  A modern browser (Chrome 91+, Firefox 90+, Edge 91+, Safari 16.4+)

### Quick Start

```bash
git clone git@github.com:ningtoba/BrowserSnip.git
cd browsersnip
npm install
npm run dev
```

Open `http://localhost:5173`. Drop a video or PDF to get started.

### Camera Access (Scan to PDF)

```bash
npm run dev:phone   # Starts Vite with self-signed HTTPS cert
```

### Production Build

```bash
npm run build       # TypeScript check + Vite bundle
npx vite preview    # Serve the built dist/
```

> ⚠️ Don't open `dist/index.html` directly from disk (`file://`). ES modules, SharedArrayBuffer, and service workers require a real HTTP server.

### Cross-Origin Isolation

Both ffmpeg.wasm and PDF.js need `SharedArrayBuffer`, which browsers gate behind cross-origin isolation. The dev server is pre-configured:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If you see `SharedArrayBuffer is not defined`, your server isn't sending these headers.

<br>

---

## 🌐 Deployment

BrowserSnip deploys to any static host. The app uses **hash routing** (`/#/tool/trim`) and includes a **coi-serviceworker** polyfill for platforms that can't set custom headers (GitHub Pages).

### Platform-specific config

<details>
<summary><strong>Vercel</strong></summary>

```json
// vercel.json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
      { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
    ]
  }]
}
```
</details>

<details>
<summary><strong>Cloudflare Pages</strong></summary>

```
# _headers file in output directory
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```
</details>

<details>
<summary><strong>GitHub Pages</strong></summary>

No extra config needed. The built-in service worker injects the headers client-side. On first visit the page may need a refresh after the worker activates (~100–200ms).

```bash
npm run build
# Push the repo → Settings → Pages → deploy from main branch / /docs / /dist
```
</details>

<br>

---

## 🧭 Architecture

```
/                    Landing page (hero, category cards, Blur promo)
/video               Video Tools dashboard (8 tools)
/pdf                 PDF Tools dashboard (26 tools in 6 categories)
/tool/:toolId        Unified ToolWorkspace — dispatches video vs PDF by category
```

All routes share an `AppLayout` shell with a persistent top navigation bar. Mobile uses a hamburger drawer.

### Directory Map

```
src/
├── main.tsx                       Entry — HashRouter + StrictMode
├── App.tsx                        Nested routes with AppLayout <Outlet />
├── index.css                      Tailwind layers + custom component classes
├── lib/
│   ├── constants.ts               Tool registry (34 tools + 7 categories)
│   ├── ffmpeg/                    FFmpeg WASM — core, commands, log-parser
│   ├── pdf-engine/                pdf-lib — core, commands (~1500 loc pure functions)
│   ├── renderer/                  PDF.js wrapper — page render, thumbnails, text
│   ├── ocr/                       PaddleOCR + ONNX Runtime — init, preprocess, recognize
│   └── utils/                     time, bitrate, download, aspect-ratio
├── stores/                        Zustand — file-store, process-store, ui-store
├── hooks/                         useFFmpeg, usePDFEngine, usePDFRenderer
├── types/                         Shared interfaces — ToolId, params, metadata
└── components/
    ├── landing/Landing.tsx        Home page
    ├── layout/
    │   ├── AppLayout.tsx          Top nav + mobile drawer + <Outlet />
    │   └── ToolWorkspace.tsx      Unified sidebar+main split (video & PDF dispatch)
    ├── dashboard/                 VideoDashboard, PdfDashboard, ToolCard
    ├── player/                    VideoPreview, TrimScrubber
    ├── viewer/                    PDFViewer, ThumbnailStrip
    ├── tools/                     Video tools (8 files)
    ├── tools/pdf/                 PDF tools (7 subdirectories, 31 files)
    └── ui/                        FileDropZone, ProgressBar, OutputActions, etc.
```

### Data Flow

```
FileDropZone → file-store
    ↓
Dashboard → navigate to /tool/:toolId
    ↓
ToolWorkspace dispatches on tool.category:
    ├─ Video → VideoPreview + useFFmpeg().process()
    └─ PDF   → PDFViewer/ThumbnailStrip + usePDFEngine().process()
    ↓
OutputActions → Download / Copy / Preview
```

### State Management

| Store | Concern | Key state |
|-------|---------|-----------|
| `file-store` | Input files | `file`, `files[]`, `metadata`, `isLargeFile`, `previewFileIndex`, `codecWarning` |
| `process-store` | Processing | `isProcessing`, `progress`, `logs[]`, `outputBlob`, `outputUrl`, `outputBlobs[]`, `error` |
| `ui-store` | UI toggles | `activeTool`, `sidebarOpen`, `showLogMonitor` |

**Session persistence:** Each tool's file and process state is cached when switching tools. Returning to a previously-used tool restores your files and parameters.

<br>

---

## 🧬 Under the Hood

<details>
<summary><strong>Video processing details</strong></summary>

### FFmpeg WebAssembly lifecycle

1. On first use, the ffmpeg.wasm core downloads (~31 MB compressed). Cached by the browser thereafter.
2. The app detects multi-threading support (`SharedArrayBuffer` + `crossOriginIsolated`) and loads the optimized core, or falls back to single-threaded.
3. Processing pipeline: `ArrayBuffer → MEMFS write → exec() → stderr parse → MEMFS read → Blob → Object URL`
4. The instance is terminated (`ffmpeg.terminate()`) between operations to fully release WASM memory.

### Bitrate formula (Compress tool)

```
B_v = (S_t × 1024 × 8 / D) - B_a

B_v = target video bitrate (kbps)
S_t = target file size (MB)
D   = duration (seconds)
B_a = audio bitrate (fixed 128 kbps)
```

A buffer size of `2 × B_v` is applied for rate control stability.

### Codec support

- **Input:** Any format decodable by ffmpeg.wasm (H.264, H.265/HEVC, VP8, VP9, AV1, MP3, AAC, etc.)
- **Output:** H.264 + AAC in MP4 container. Exceptions: GIF (`.gif`), MP3 extract (`.mp3`)

</details>

<details>
<summary><strong>PDF processing details</strong></summary>

### Dual-engine design

- **pdf-lib** handles all document manipulation (create, modify, merge, split, sign, encrypt, watermark)
- **PDF.js** handles all rendering (page preview, thumbnails, text extraction, image export)
- The two engines never overlap — manipulation is pdf-lib only, display is PDF.js only

### Redaction: true data destruction

Unlike visual-masking approaches that draw black boxes over content (the original text remains in the file), BrowserSnip's redaction tool rasterizes each page at 2× resolution, burns opaque rectangles into the pixel data, and re-embeds the result as JPEG pages in a new PDF. The original vector text is irreversibly destroyed.

### OCR pipeline

1. Document image loaded to canvas
2. Grayscale conversion + contrast stretch + sharpen preprocessing
3. PaddleOCR ONNX model performs text detection and recognition
4. Recognized text placed as an invisible text layer over the original image in the output PDF (searchable)

### Supported PDF versions

PDF 1.0 through 2.0. Encrypted PDFs require the correct password. Some PDF/A-3 extended features may not be fully supported.

</details>

<br>

---

## 📋 Tool Reference

### Video Tool Parameters

<details>
<summary><strong>Trim & Cut</strong></summary>

| Parameter | Range | Notes |
|-----------|-------|-------|
| `startTime` | 0 – duration | Trim start (seconds) |
| `endTime` | startTime – duration | Trim end (seconds) |

Uses stream copy (`-c copy`) for near-instant lossless cuts at keyframe boundaries.
</details>

<details>
<summary><strong>Resize</strong></summary>

| Preset | Resolution |
|--------|------------|
| 1080p | 1920 × 1080 |
| 720p | 1280 × 720 |
| 480p | 854 × 480 |
| 360p | 640 × 360 |
| Custom | User-defined dimensions |

Aspect ratio locked by default. Toggle to unlock for freeform dimensions.
</details>

<details>
<summary><strong>Crop & Reframe</strong></summary>

| Aspect Ratio | Target platform |
|--------------|----------------|
| 9:16 | TikTok, Reels, Shorts |
| 1:1 | Instagram square |
| 21:9 | Cinematic widescreen |

Two modes: direct crop (removes pixels) or blurred padding (preserves all content behind cropped frame).
</details>

<details>
<summary><strong>Compress</strong></summary>

| Target Size | Typical use case |
|-------------|-----------------|
| 10 MB | Email attachments |
| 25 MB | Discord free tier, WhatsApp |
| 50 MB | Standard Discord, Telegram |
| 100 MB | Slack, Microsoft Teams |
| 250 MB | Large file transfers |
</details>

<details>
<summary><strong>GIF Converter</strong></summary>

| Parameter | Range | Default |
|-----------|-------|---------|
| Start Time | 0 – 60s | 0s |
| Duration | 0.5 – 10s | 3s |
| FPS | 10, 15, 20, 30 | 15 |
| Width | 240 – 720px | 480px |

Dual-pass palette generation (`palettegen` + `paletteuse`) with Lanczos scaling. Capped at 10s for WASM memory safety.
</details>

<details>
<summary><strong>Audio Tools</strong></summary>

| Mode | Output | Typical use |
|------|--------|-------------|
| Mute | MP4 (no audio) | Remove background noise, prep for voiceover |
| Extract MP3 | MP3 audio | Podcast clips, ringtones, audio sampling |
| Volume | MP4 (adjusted) | Boost quiet audio (up to 300%) or reduce loud audio |
</details>

<details>
<summary><strong>Speed Control</strong></summary>

| Speed | Effect | PTS factor | Audio tempo |
|-------|--------|-----------|--------------|
| 0.25× | Quarter-speed slow-motion | `setpts=4.0*PTS` | `atempo=0.25` |
| 0.5× | Half-speed slow-motion | `setpts=2.0*PTS` | `atempo=0.5` |
| 1.5× | Slight speed-up | `setpts=0.667*PTS` | `atempo=1.5` |
| 2.0× | Double-speed timelapse | `setpts=0.5*PTS` | `atempo=2.0` |
| 4.0× | Fast timelapse | `setpts=0.25*PTS` | `atempo=4.0` |
</details>

<details>
<summary><strong>Privacy Purge</strong></summary>

Strips all of the following via stream copy (near-instant, no re-encode):
- Global and stream-level metadata
- EXIF data and GPS location tags
- Creation date and software markers
- Chapter markers and embedded thumbnails
- Cover art
</details>

<br>

---

## 🌍 Browser Support

| Browser | Min version | Notes |
|---------|------------|-------|
| **Chrome** | 91+ | Full support |
| **Edge** | 91+ | Full support |
| **Firefox** | 90+ | Full support (Clipboard API limited for non-text types) |
| **Safari** | 16.4+ | SharedArrayBuffer requires experimental features |
| **Opera** | 77+ | Full support |

**Mobile:** Safari iOS 16.4+ and Chrome Android 91+ supported. Responsive layout with hamburger nav and stacked tool panels below 768px.

**Camera:** HTTPS required for Scan to PDF (`npm run dev:phone` for local dev with self-signed cert).

<br>

---

## ⚠️ Known Limitations

| Limitation | Detail | Mitigation |
|------------|--------|------------|
| **File size** | ~500 MB soft limit. WebAssembly has a ~4 GB addressable memory ceiling shared between input, output, and working memory. | Compress or resize first; split large files before importing |
| **Video speed** | ffmpeg.wasm is 5–10× slower than native FFmpeg. 30s 1080p re-encode: 2–5 min | Stream-copy operations (trim, mute, metadata strip) are near-instant |
| **PDF OCR speed** | OCR digitization is 30s+ per page depending on hardware | Use for short documents; batch processing not recommended |
| **Clipboard API** | Firefox and Safari have limited/nonexistent support for copying non-text types via `navigator.clipboard.write()` | Use the Download button + drag into target app |
| **Multi-threading** | Requires `SharedArrayBuffer` which needs cross-origin isolation headers | Dev server pre-configured; coi-serviceworker polyfill for static hosts |

<br>

---

## 🤝 Contributing

Each tool is a self-contained component with a clear `input → process → output` flow. Adding a new tool:

1. Add types in `src/types/index.ts`
2. Register in `src/lib/constants.ts` (with `category`)
3. Implement the command in `src/lib/ffmpeg/commands.ts` or `src/lib/pdf-engine/commands.ts`
4. Create the component in `src/components/tools/` (video) or `src/components/tools/pdf/<category>/` (PDF)
5. Register in `TOOL_COMPONENTS` (and `TOOL_MAIN_COMPONENTS` for visual overlays) in `ToolWorkspace.tsx`

### Before submitting

```bash
npm run build         # Must pass with zero errors
npx tsc --noEmit      # Must pass with zero type errors
npx vitest run        # All tests must pass
```

### Conventions

- **TypeScript** throughout — explicit types, no `any`
- **Immutability** — pure functions for all PDF commands and FFmpeg argument builders
- **One component per file** — named exports with Props interfaces
- **Dark mode** — indigo accent (`#6366f1`) on zinc/slate background (`#0a0b10`)

<br>

---

## 📜 License

MIT © BrowserSnip Contributors

---

## 🙏 Acknowledgments

BrowserSnip stands on the shoulders of remarkable open-source projects:

| Project | What it provides |
|---------|-----------------|
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) | FFmpeg compiled to WebAssembly (Jerome Wu + contributors) |
| [FFmpeg](https://ffmpeg.org) | The universal multimedia engine |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | Pure JavaScript PDF creation and manipulation (Andrew Dillon) |
| [PDF.js](https://mozilla.github.io/pdf.js) | In-browser PDF rendering (Mozilla) |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | ONNX-accelerated text detection and recognition (PaddlePaddle) |
| [ONNX Runtime](https://onnxruntime.ai) | Cross-platform ML model inference (Microsoft) |
| [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) | Cross-origin isolation polyfill (Gideon Zuidhof) |
| [Zustand](https://zustand.docs.pmnd.rs) | Lightweight React state management (Poimandres) |
| [TailwindCSS](https://tailwindcss.com) | Utility-first CSS framework |
