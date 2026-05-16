# AsciiDoc Live

[![Obsidian Plugin](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?style=flat&logo=obsidian)](https://obsidian.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Desktop Only](https://img.shields.io/badge/platform-desktop%20only-orange)]()

AsciiDoc Live renders .adoc files natively with a live-updating preview that refreshes automatically while you type — no manual reload required.

AsciiDoc Live bundles [Asciidoctor.js](https://asciidoctor.org) directly and handles `.adoc`, `.asciidoc`, and `.asc` files out of the box.

---

## The problem this solves

Other AsciiDoc tools render the file on open but do not update the preview while you edit. You have to manually trigger a reload every time you change something. Markdown files in Obsidian don't have this limitation — AsciiDoc Live brings the same behaviour to AsciiDoc.

---

## Features

- Renders `.adoc` / `.asciidoc` / `.asc` files with full AsciiDoc support: headings, tables, admonitions, code blocks, images, TOC, footnotes, callout lists, and more
- **Live preview** — automatically re-renders while you type, with a configurable debounce delay
- **Three auto-refresh triggers** work simultaneously:
  1. Editing in AsciiDoc Live's own Source mode (textarea in a split pane)
  2. Editing the file in Obsidian's built-in plain-text editor in another pane
  3. Any external modification detected by the vault (auto-save, external editor)
- **Editor toolbar** — formatting shortcuts visible only in Source mode (see below)
- **Image paste from clipboard** — `Ctrl+V` in Source mode saves the image to the vault and inserts the correct `image::filename[]` syntax automatically
- **Math formulas** — `[latexmath]` and `[asciimath]` / `[stem]` macros rendered via Obsidian's built-in MathJax engine; AsciiMath is converted to TeX automatically using a bundled converter — no external plugins or internet connection required.

> [!IMPORTANT] 
> In the current version, only multiline `[stem]`/`[asciimath]` blocks and multiline `[latexmath]` blocks are supported

- **xref and cross-reference link resolution** — `xref:` links and `<<File#anchor>>` cross-references open the target `.adoc` file in a **new tab**; in-page anchors (`<<anchor>>`) scroll smoothly within the preview
- **Cross-document anchor navigation** — `xref:File.adoc#section[text]` opens the target file in a new tab and scrolls to the named anchor
- **Internal link handling** — all clicks in the preview are intercepted: external URLs open in the system browser, in-page anchors scroll smoothly, cross-file links open in Obsidian
- Image paths resolved to vault resources automatically; respects Obsidian's attachment folder settings
- **Table styling** follows the AsciiDoc `frame=` and `grid=` attributes — `[frame=none, grid=none]` fully removes borders
- **Admonition blocks** (NOTE / TIP / WARNING / CAUTION / IMPORTANT) rendered as cards with a coloured header
- Styles adapt to the active Obsidian theme via CSS variables

---

## Installation

### Disable other AsciiDoc plugins first

AsciiDoc Live registers the `.adoc`, `.asciidoc`, and `.asc` extensions. If another AsciiDoc-render plugin is active at the same time, there will probably be a conflict. **Disable any other AsciiDoc plugin before enabling AsciiDoc Live.**

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Koshlensky/asciidoc-live/releases/latest)
2. Copy all three files into `.obsidian/plugins/asciidoc-live/` inside your vault
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**

---

## Usage

Create or open any `.adoc` file — it opens in **Preview mode** by default.

### Split-pane live editing

1. Open a `.adoc` file → it shows the rendered preview
2. Right-click the tab → **Split right** (or use the command palette)
3. In one pane, click the **book icon** to switch to Source mode
4. Type in the Source pane — the Preview pane updates automatically

### New AsciiDoc note

- **Right-click** any file or folder in the file explorer → **New .adoc note**
- Or open the Command Palette (`Ctrl+P`) → **AsciiDoc Live: New AsciiDoc note**

The new file opens immediately and is created in the same folder as the selected item.

---

### Pasting images

- **`Ctrl+V` with an image in the clipboard** — AsciiDoc Live detects the image, saves it to the vault (using Obsidian's configured attachment folder), and inserts `image::Pasted image YYYYMMDD_HHmmss.png[]` at the cursor. No extra steps required.
- **Img toolbar button** — same behaviour when the clipboard contains an image; inserts a placeholder template otherwise.

### Cross-references and anchors

```asciidoc
// Define an anchor on a heading or block
[#my-section]
== My Section

// Link to it within the same document
<<my-section>>

// Link to it from another document (opens in a new tab and scrolls to the section)
xref:OtherFile.adoc#my-section[Go to My Section]

// Alternative cross-reference syntax
<<OtherFile.adoc#my-section,Go to My Section>>
```

All three forms work. External `.html` paths generated by Asciidoctor are automatically rewritten to `.adoc` before the lookup.

### Math formulas

AsciiDoc Live renders math **self-contained** — no external plugins or internet required. LaTeX is rendered via Obsidian's built-in MathJax; AsciiMath is automatically converted to TeX by a bundled converter.

Currently, the application supports only **multiline `stem` blocks** and **multiline `latexmath` blocks**.

Supported syntaxes follow [AsciiDoc stem documentation](https://docs.asciidoctor.org/asciidoc/latest/stem/):

```asciidoc
// latexmath block 
[latexmath]
++++
\lim_{n \to \infty}\frac{n}{\sqrt[n]{n!}} = {\large e}
++++

// asciimath block 
[asciimath]
++++
x = (-b +- sqrt(b^2 - 4ac)) / (2a)
++++

// stem block (defaults to asciimath)
[stem]
++++
\begin{equation}
c = \sqrt{a^2 + b^2}
\end{equation}
++++
```

---

## Settings

Open **Settings → AsciiDoc Live**.

| Setting | Default | Description |
|---|---|---|
| **Auto-refresh delay (ms)** | `500` | Milliseconds to wait after the last keystroke before re-rendering. Minimum: 100 ms. |

`.adoc` files always open in **Preview** mode.

---

## How the live refresh works

When a Preview pane is open, it listens to three independent triggers simultaneously:

| Trigger | Scenario |
|---|---|
| `workspace → editor-change` | The same file is open in Obsidian's built-in plain-text editor in another pane |
| Plugin internal broadcast | The file is open in AsciiDoc Live's Source mode in a split pane |
| `vault → modify` | The file was saved to disk (auto-save, Ctrl+S, or external editor) |

All three routes feed into the same `renderPreview()` function, which runs `Asciidoctor.convert()` on the latest content and injects the HTML into the preview pane.

---

## Repository structure

```
asciidoc-live/
├── main.ts               # Plugin source (TypeScript)
│                           ├─ AdocView       — TextFileView subclass
│                           │                    renderer · source editor · toolbar
│                           │                    link handler · image paste · anchor nav
│                           ├─ AdocPlugin     — Plugin entry point, shared Asciidoctor
│                           │                    processor, pending-anchor registry
│                           └─ AdocSettingTab — Settings UI
├── main.js               # Compiled & bundled output — committed for distribution
├── manifest.json         # Obsidian plugin metadata
├── versions.json         # Maps each release version to its minimum Obsidian version
├── styles.css            # View container, toolbar, source editor, and preview styles
│                           (admonition cards, frame/grid-aware table borders, theme vars)
├── esbuild.config.mjs    # esbuild bundler configuration
├── tsconfig.json         # TypeScript compiler options
├── package.json          # npm project config; includes @asciidoctor/core as a dependency
├── version-bump.mjs      # Syncs version across manifest.json and versions.json on npm version
└── LICENSE               # MIT License
```

---

## Development

**Requirements:** Node.js ≥ 18, npm

```bash
# Install dependencies (includes @asciidoctor/core, ~1.6 MB bundle)
npm install

# Watch mode — rebuilds on every save
npm run dev

# Production build — type-check then bundle
npm run build

# Bump version (updates package.json, manifest.json, versions.json)
npm version patch   # or: minor / major
```

To test locally, copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/asciidoc-live/` in your Obsidian vault, then reload Obsidian.

> [!NOTE]
> The production bundle is ~1.6 MB because Asciidoctor.js is included in full. This is expected for any AsciiDoc renderer plugin.
