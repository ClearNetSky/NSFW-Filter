# Changelog

## v2.0.0 — Major Architecture Overhaul

### Architecture
- **Removed sandbox layer** — TF.js runs directly in offscreen document (3-layer instead of 4-layer)
- **WebGPU backend** — GPU acceleration without `unsafe-eval` CSP; CPU fallback if unavailable
- **fetch() + blob image loading** — bypasses CORS restrictions on all CDNs (Google, Bing, Reddit, etc.)
- **esbuild bundle** — TF.js 4.22.0 + nsfwjs 4.3.0 in a single 1.5MB file (down from 38MB)

### Models
- **MobileNet v2** as default model (224px, 2.6MB, fast)
- **InceptionV3** as optional model (299px, 22MB, more accurate)
- Model selection in popup settings

### Classification
- **5-class algorithm** preserved (Drawing, Hentai, Neutral, Porn, Sexy)
- Drawing/Neutral score-aware threshold adjustments (reduces false positives on anime/illustrations)
- Combined NSFW score fallback (blocks when individual scores are below threshold but combined > 70%)
- Per-category enable/disable support (porn/sexy/hentai)

### Content Script
- **Google Images support** — processes `data:image/jpeg` thumbnails
- **Lazy-load support** — `data-src`, `data-lazy-src`, `data-original`, `data-lazy`, `data-actualsrc` (VK), `data-thumb-url` / `data-preview-url` (Reddit)
- **srcset / currentSrc** resolution for responsive images
- **SPA re-scan** — periodic scan for Reddit, VK, Twitter, Instagram, Facebook, TikTok, Tumblr
- **Video poster** filtering
- Smart URL filtering — skips SVG, GIF, favicons, sprites, tracking pixels
- `Extension context invalidated` error handling with graceful degradation

### Queues & Cache
- **LoadingQueue** — 100 concurrent image loads, 3s timeout
- **PredictionQueue** — 1 sequential prediction (prevents GPU contention)
- **LRU cache** — 500 entries shared across all tabs
- **Request deduplication** — same URL = single prediction, multiple waiters

### Popup
- Model selection (MobileNet v2 / InceptionV3)
- Version number in footer
- Dark mode (automatic, follows system preference)

### Performance
- Bundle size: 1.5MB (was 38MB with embedded models)
- No `unsafe-eval` needed (WebGPU doesn't require it)
- Tab lifecycle management — cancels predictions for closed/navigated tabs

---

## v1.8.0
- Opacity-hide pending images
- Removed whitelist/blur/click-to-reveal

## v1.7.0
- Whitelist, badge, SVG placeholder, memory & filtering improvements

## v1.6.0
- Performance & coverage improvements

## v1.5.1
- WebGL recovery & CORS fixes

## v1.5.0
- Initial WebGL-based filtering
