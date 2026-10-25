import {
    App,
    Editor,
    Menu,
    Plugin,
    PluginSettingTab,
    Setting,
    TAbstractFile,
    TFile,
    TFolder,
    TextFileView,
    WorkspaceLeaf,
    debounce,
    Debouncer,
    setIcon,
    SettingDefinitionItem,
    loadMathJax,
    renderMath,
    finishRenderMath,
} from 'obsidian';

// @ts-ignore
import AsciiMathParser from 'asciimath2tex';
const _am2tex = new AsciiMathParser();

// @ts-ignore
import Asciidoctor from '@asciidoctor/core';

const VIEW_TYPE_ADOC = 'adoc';

interface AdocPluginSettings {
    refreshDelay: number;
}

interface AsciidoctorProcessor {
    convert(content: string, options?: Record<string, unknown>): string;
}

interface FileManagerExt {
    getAvailablePathForAttachment(fileName: string): Promise<string>;
}

interface MathJaxAPI {
    typesetPromise?: (elements: HTMLElement[]) => Promise<void>;
}

const DEFAULT_SETTINGS: AdocPluginSettings = {
    refreshDelay: 500,
};

// ─── View ────────────────────────────────────────────────────────────────────

class AdocView extends TextFileView {
    private plugin: AdocPlugin;
    private previewEl: HTMLDivElement;
    private sourceEl: HTMLTextAreaElement;
    private sourceWrapEl: HTMLDivElement;
    private mirrorEl: HTMLDivElement;
    private toolbarEl: HTMLDivElement;
    private mode: 'source' | 'preview';
    private debouncedRender: Debouncer<[], void>;
    private softWrap = false;

    // find-in-document state
    private findBarEl: HTMLDivElement;
    private findInputEl: HTMLInputElement;
    private findCountEl: HTMLSpanElement;
    private findIndex = 0;
    private findRanges: Range[] = [];
    private findSourceHits: number[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: AdocPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.mode = 'preview';
    }

    getViewType(): string { return VIEW_TYPE_ADOC; }
    getDisplayText(): string { return this.file?.basename ?? 'AsciiDoc'; }
    getIcon(): string { return 'file-text'; }

    getViewData(): string {
        if (this.mode === 'source' && this.sourceEl) return this.sourceEl.value;
        return this.data;
    }

    setViewData(data: string, clear: boolean): void {
        this.data = data;
        if (!this.sourceEl || !this.previewEl) return;
        if (this.mode === 'source') {
            if (clear) {
                this.sourceEl.value = data;
            } else {
                const s = this.sourceEl.selectionStart;
                const e = this.sourceEl.selectionEnd;
                this.sourceEl.value = data;
                try { this.sourceEl.setSelectionRange(s, e); } catch { /* best-effort: ignore selection restore */ }
            }
        } else {
            if (clear) this.renderPreview();
            else this.debouncedRender();
        }
    }

    clear(): void {
        this.data = '';
        if (this.sourceEl) this.sourceEl.value = '';
        if (this.previewEl) this.previewEl.innerHTML = '';
    }

    pushContentUpdate(content: string): void {
        if (this.mode !== 'preview') return;
        this.data = content;
        this.debouncedRender();
    }

    isPreviewMode(): boolean { return this.mode === 'preview'; }

    // Scroll the preview to an in-page anchor (called externally for cross-doc navigation)
    scrollToAnchor(id: string): void {
        if (this.mode !== 'preview' || !this.previewEl) return;
        this.previewEl.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
            ?.scrollIntoView({ behavior: 'smooth' });
    }

    onOpen(): Promise<void> {
        this.plugin.registerAdocView(this);

        this.debouncedRender = debounce(
            () => this.renderPreview(),
            this.plugin.settings.refreshDelay,
            true
        );

        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('adoc-view-container');

        // ── Toolbar ──────────────────────────────────────────────────────────
        this.toolbarEl = container.createDiv({ cls: 'adoc-toolbar' });
        this.buildToolbar();

        // Find bar (Ctrl+F, works in both source and preview modes)
        this.buildFindBar(container);
        // Listen on window (capture) so Ctrl+F works even when focus is not inside the view
        this.registerDomEvent(window, 'keydown', (e: KeyboardEvent) => {
            if (this.app.workspace.getActiveViewOfType(AdocView) !== this) return;
            const mod = e.ctrlKey || e.metaKey;
            if (mod && !e.shiftKey && !e.altKey && (e.code === 'KeyF' || e.key.toLowerCase() === 'f')) {
                e.preventDefault();
                e.stopPropagation();
                this.openFind();
            } else if (e.key === 'F3' && this.isFindOpen()) {
                e.preventDefault();
                this.stepFind(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape' && this.isFindOpen()) {
                e.preventDefault();
                this.closeFind();
            }
        }, { capture: true });

        // ── Source editor ────────────────────────────────────────────────────
        this.sourceWrapEl = container.createDiv({ cls: 'adoc-source-wrap' });
        this.mirrorEl = this.sourceWrapEl.createDiv({ cls: 'adoc-source-mirror' });
        this.sourceEl = this.sourceWrapEl.createEl('textarea', { cls: 'adoc-source-editor' });
        this.sourceEl.addEventListener('scroll', () => this.syncMirrorScroll());
        this.registerDomEvent(window, 'resize', () => { if (this.isFindOpen()) this.updateMirror(); });
        this.sourceEl.spellcheck = false;

        this.sourceEl.addEventListener('input', () => {
            this.data = this.sourceEl.value;
            this.requestSave();
            this.plugin.broadcastContentChange(this.file, this.data);
            if (this.isFindOpen()) this.runFind(false);
        });

        // Intercept paste: if clipboard contains an image, save it to vault
        this.sourceEl.addEventListener('paste', (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of Array.from(items)) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    void this.handleImagePaste(item);
                    return;
                }
            }
        });

        // ── Preview pane ─────────────────────────────────────────────────────
        this.previewEl = container.createDiv({ cls: 'adoc-preview', attr: { tabindex: '-1' } });

        // ── Header toggle button ─────────────────────────────────────────────
        this.addAction('book-open', 'Toggle source / preview', () => this.toggleMode());

        // ── Event listeners ──────────────────────────────────────────────────

        // 1. File saved to vault (auto-save, external editor, Ctrl+S)
        this.registerEvent(
            this.app.vault.on('modify', async (file: TAbstractFile) => {
                if (!(file instanceof TFile) || file !== this.file || this.mode !== 'preview') return;
                const content = await this.app.vault.read(file);
                this.data = content;
                this.renderPreview();
            })
        );

        // 2. Real-time edits from Obsidian's built-in CodeMirror editor in another pane
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor: Editor) => {
                if (this.app.workspace.getActiveFile() !== this.file || this.mode !== 'preview') return;
                this.data = editor.getValue();
                this.debouncedRender();
            })
        );

        this.applyModeDisplay();
        return Promise.resolve();
    }

    onClose(): Promise<void> {
        this.plugin.unregisterAdocView(this);
        this.clearFindHighlights();
        return Promise.resolve();
    }

    // ── Toolbar ───────────────────────────────────────────────────────────────

    private buildToolbar(): void {
        const t = this.toolbarEl;

        const mkBtn = (iconName: string, fallback: string, label: string, act: string, fn: () => void) => {
            const b = t.createEl('button', {
                cls: 'adoc-toolbar-btn',
                attr: { title: label, 'data-action': act },
            });
            setIcon(b, iconName);
            if (!b.querySelector('svg')) b.setText(fallback);
            b.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
            return b;
        };

        const sep = () => t.createSpan({ cls: 'adoc-toolbar-sep' });

        mkBtn('bold',          'B',    'Toggle bold',           'bold',      () => this.wrapOrInsert('*', '*', 'bold text'));
        mkBtn('italic',        'I',    'Toggle italic',         'italic',    () => this.wrapOrInsert('_', '_', 'italic text'));
        mkBtn('code',          '`',    'Toggle mono',           'mono',      () => this.wrapOrInsert('`', '`', 'code'));
        mkBtn('strikethrough', 'S',    'Toggle strikethrough',  'strike',    () => this.wrapOrInsert('[line-through]#', '#', 'text'));
        mkBtn('highlighter',   '#',    'Toggle highlight',      'highlight', () => this.wrapOrInsert('#', '#', 'highlighted'));
        sep();
        mkBtn('type',          'H1',   'Make title',            'title',     () => this.insertTitle());
        mkBtn('link',          'Link', 'Create link',           'link',      () => this.insertLink());
        mkBtn('image',         'Img',  'Paste image',           'image',     () => { void this.insertImage(); });
        mkBtn('table',         'Tbl',  'Create table',          'table',     () => this.insertTable());
        sep();
        mkBtn('clipboard',     'Fmt',  'Paste formatted text',  'paste',     () => { void this.pasteFormatted(); });
        sep();
        mkBtn('wrap-text',     'Wrap', 'Toggle soft wrap',      'wrap',      () => this.toggleSoftWrap());
    }

    // ── Formatting helpers ────────────────────────────────────────────────────

    private wrapOrInsert(before: string, after: string, placeholder: string): void {
        const ta  = this.sourceEl;
        const s   = ta.selectionStart;
        const e   = ta.selectionEnd;
        const sel = ta.value.slice(s, e);

        if (sel) {
            const pre  = ta.value.slice(Math.max(0, s - before.length), s);
            const post = ta.value.slice(e, e + after.length);
            if (pre === before && post === after) {
                ta.setRangeText(sel, s - before.length, e + after.length, 'end');
                ta.setSelectionRange(s - before.length, s - before.length + sel.length);
            } else {
                ta.setRangeText(before + sel + after, s, e, 'end');
                ta.setSelectionRange(s + before.length, s + before.length + sel.length);
            }
        } else {
            const ins = before + placeholder + after;
            ta.setRangeText(ins, s, e, 'end');
            ta.setSelectionRange(s + before.length, s + before.length + placeholder.length);
        }

        ta.focus();
        this.syncData();
    }

    private insertTitle(): void {
        const ta        = this.sourceEl;
        const pos       = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
        const rawEnd    = ta.value.indexOf('\n', pos);
        const lineEnd   = rawEnd === -1 ? ta.value.length : rawEnd;
        const line      = ta.value.slice(lineStart, lineEnd);
        const m         = line.match(/^(=+) /);

        if (m) {
            const level = m[1].length;
            const next  = level >= 6 ? '' : '='.repeat(level + 1) + ' ';
            ta.setRangeText(next + line.slice(m[0].length), lineStart, lineEnd, 'end');
        } else {
            ta.setRangeText('= ' + line, lineStart, lineEnd, 'end');
        }

        ta.focus();
        this.syncData();
    }

    private insertLink(): void {
        const ta  = this.sourceEl;
        const s   = ta.selectionStart;
        const e   = ta.selectionEnd;
        const sel = ta.value.slice(s, e);
        const ins = sel ? `link:URL[${sel}]` : 'link:URL[Link text]';
        ta.setRangeText(ins, s, e, 'end');
        ta.setSelectionRange(s + 5, s + 8);
        ta.focus();
        this.syncData();
    }

    // Paste Image: if clipboard contains an image save it; otherwise insert template
    private async insertImage(): Promise<void> {
        try {
            const clipItems: ClipboardItem[] = await (navigator.clipboard as unknown as { read(): Promise<ClipboardItem[]> }).read();
            for (const item of clipItems) {
                const imgType = item.types.find((t: string) => t.startsWith('image/'));
                if (imgType) {
                    const blob = await item.getType(imgType);
                    const savedFile = await this.saveImageToVault(blob, imgType);
                    this.insertImageReference(savedFile);
                    return;
                }
            }
        } catch (err) {
            console.warn('[AsciiDoc Live] Could not read clipboard image:', err);
        }

        // Fallback: insert placeholder
        const ta  = this.sourceEl;
        const pos = ta.selectionStart;
        const ins = 'image::path/to/image.png[Alt text]';
        ta.setRangeText(ins, pos, ta.selectionEnd, 'end');
        ta.setSelectionRange(pos + 8, pos + 29);
        ta.focus();
        this.syncData();
    }

    private insertTable(): void {
        const ta  = this.sourceEl;
        const pos = ta.selectionStart;
        const ins = '\n[cols="1,1,1"]\n|===\n| Header 1 | Header 2 | Header 3\n\n| Cell 1   | Cell 2   | Cell 3\n| Cell 4   | Cell 5   | Cell 6\n|===\n';
        ta.setRangeText(ins, pos, ta.selectionEnd, 'end');
        ta.focus();
        this.syncData();
    }

    private async pasteFormatted(): Promise<void> {
        try {
            const text = await navigator.clipboard.readText();
            if (!text) return;
            const ta  = this.sourceEl;
            const pos = ta.selectionStart;
            ta.setRangeText(text, pos, ta.selectionEnd, 'end');
            ta.focus();
            this.syncData();
        } catch (err) {
            console.warn('[AsciiDoc Live] Could not read clipboard text:', err);
        }
    }

    private toggleSoftWrap(): void {
        this.softWrap = !this.softWrap;
        this.sourceEl.style.whiteSpace   = this.softWrap ? 'pre-wrap' : 'pre';
        this.sourceEl.style.overflowWrap = this.softWrap ? 'break-word' : 'normal';
        this.sourceEl.style.overflowX    = this.softWrap ? 'hidden' : 'auto';
        if (this.isFindOpen()) this.updateMirror();
        this.toolbarEl
            .querySelector<HTMLElement>('[data-action="wrap"]')
            ?.classList.toggle('is-active', this.softWrap);
    }

    // ── Image helpers ─────────────────────────────────────────────────────────

    private async handleImagePaste(item: DataTransferItem): Promise<void> {
        const blob = item.getAsFile();
        if (!blob) return;
        try {
            const savedFile = await this.saveImageToVault(blob, item.type);
            this.insertImageReference(savedFile);
        } catch (err) {
            console.error('[AsciiDoc Live] Failed to save pasted image:', err);
        }
    }

    private async saveImageToVault(blob: Blob, mimeType: string): Promise<TFile> {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const ext = mimeType === 'image/jpeg' ? 'jpg'
                  : mimeType === 'image/gif'  ? 'gif'
                  : mimeType === 'image/webp' ? 'webp'
                  : 'png';
        const fileName = `Pasted image ${stamp}.${ext}`;

        let savePath: string;
        try {
            savePath = await (this.app.fileManager as unknown as FileManagerExt).getAvailablePathForAttachment(fileName);
        } catch {
            const parent = this.file?.parent;
            const prefix = parent && !parent.isRoot() ? `${parent.path}/` : '';
            savePath = `${prefix}${fileName}`;
        }

        const arrayBuffer = await blob.arrayBuffer();
        return await this.app.vault.createBinary(savePath, arrayBuffer);
    }

    // Build an image:: reference using a path relative to the current file.
    // Falls back to full vault path when the image lives in a different folder.
    private insertImageReference(savedFile: TFile): void {
        const currentParent = this.file?.parent;
        const currentParentPath = (currentParent && !currentParent.isRoot()) ? currentParent.path : '';

        let insertPath: string;
        if (!currentParentPath) {
            // Current file is at vault root — use full vault path of the image
            insertPath = savedFile.path;
        } else if (savedFile.path.startsWith(currentParentPath + '/')) {
            // Image is under the same folder — use relative filename
            insertPath = savedFile.path.slice(currentParentPath.length + 1);
        } else {
            // Image is in a different folder — use full vault path so resolveImages can find it
            insertPath = savedFile.path;
        }

        const ta  = this.sourceEl;
        const pos = ta.selectionStart;
        ta.setRangeText(`image::${insertPath}[]\n`, pos, ta.selectionEnd, 'end');
        ta.focus();
        this.syncData();
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private syncData(): void {
        this.data = this.sourceEl.value;
        this.requestSave();
        this.plugin.broadcastContentChange(this.file, this.data);
    }

    private toggleMode(): void {
        this.mode = this.mode === 'source' ? 'preview' : 'source';
        this.applyModeDisplay();
    }

    private applyModeDisplay(): void {
        const isSource = this.mode === 'source';
        this.previewEl.toggleClass('adoc-hidden', isSource);
        this.sourceWrapEl.toggleClass('adoc-hidden', !isSource);
        this.toolbarEl.toggleClass('adoc-hidden', !isSource);
        if (isSource) {
            this.sourceEl.value = this.data ?? '';
            this.sourceEl.focus();
        } else {
            if (this.data) this.renderPreview();
        }
        if (this.isFindOpen()) this.runFind(false);
    }

    private renderPreview(): void {
        if (!this.previewEl) return;
        try {
            const html = this.plugin.processor.convert(this.data ?? '', {
                safe: 'safe',
                attributes: {
                    showtitle: '',
                    icons: 'font',
                    'source-highlighter': 'highlight.js',
                    stem: '@',
                },
            });
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            this.previewEl.empty();
            Array.from(parsed.body.childNodes).forEach(n => this.previewEl.appendChild(n));
            this.resolveImages();
            this.handleLinks();
            void this.renderMathFormulas().then(() => { if (this.isFindOpen()) this.runFind(false); });
            if (this.isFindOpen()) this.runFind(false);

            // If another view requested navigation to an anchor in this file, consume it
            const pending = this.plugin.pendingAnchor;
            if (pending && this.file && pending.file === this.file) {
                this.plugin.pendingAnchor = null;
                activeWindow.requestAnimationFrame(() => this.scrollToAnchor(pending.id));
            }
        } catch (e) {
            console.error('[AsciiDoc Live] Render error:', e);
            this.previewEl.empty();
            const errEl = this.previewEl.createDiv({ cls: 'adoc-render-error' });
            errEl.createEl('strong', { text: 'Render error' });
            errEl.createEl('pre', { text: String(e) });
        }
    }

    private handleLinks(): void {
        if (!this.previewEl) return;
        this.previewEl.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(link => {
            const fresh = link.cloneNode(true) as HTMLAnchorElement;
            link.replaceWith(fresh);
            fresh.addEventListener('click', (e) => {
                e.preventDefault();
                void this.handleLinkClick(fresh.getAttribute('href') ?? '');
            });
        });
    }

    private async handleLinkClick(href: string): Promise<void> {
        if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) {
            window.open(href, '_blank', 'noopener,noreferrer');
            return;
        }

        // Same-document anchor — e.g. href="#my-section"
        if (href.startsWith('#')) {
            this.scrollToAnchor(href.slice(1));
            return;
        }

        const hashIdx  = href.indexOf('#');
        const fragment = hashIdx !== -1 ? href.slice(hashIdx + 1) : '';
        let filePart   = hashIdx !== -1 ? href.slice(0, hashIdx) : href;

        if (!filePart) {
            // href was just a bare "#fragment" handled above; nothing else to do
            if (fragment) this.scrollToAnchor(fragment);
            return;
        }

        // xref fix: Asciidoctor generates .html hrefs — map back to .adoc
        filePart = filePart.replace(/\.html$/, '.adoc');

        // URL-decode: Asciidoctor encodes spaces/specials in filenames (e.g. %20)
        try { filePart = decodeURIComponent(filePart); } catch { /* invalid URI encoding — use as-is */ }

        const parent  = this.file?.parent;
        const absPath = !parent || parent.isRoot() ? filePart : `${parent.path}/${filePart}`;
        const target  = this.app.vault.getAbstractFileByPath(absPath);

        if (!(target instanceof TFile)) return;

        // Store the anchor so the target view can scroll after it renders
        if (fragment) {
            this.plugin.pendingAnchor = { file: target, id: fragment };
        }

        // Open cross-document links in a new tab
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.openFile(target);

        // Fallback: if renderPreview() already ran before we set pendingAnchor
        // (or the file was already open), try a direct scroll now
        if (fragment && this.plugin.pendingAnchor?.file === target) {
            this.plugin.pendingAnchor = null;
            const view = leaf.view;
            if (view instanceof AdocView) {
                activeWindow.requestAnimationFrame(() => view.scrollToAnchor(fragment));
            }
        }
    }

    // ── Math rendering ────────────────────────────────────────────────────────

    // Self-contained math rendering using Obsidian's renderMath API + asciimath2tex.
    // No external plugins or CDN required.
    //
    // Asciidoctor.js output format:
    //   latexmath:[...]         → <span class="stem">\(...\)</span>
    //   [latexmath] ++++ ... →   <div class="stemblock"><div class="content">\[...\]</div></div>
    //   asciimath:[...] / stem  → <span class="stem">\$...\$</span>
    //   [asciimath] ++++ ... →   <div class="stemblock"><div class="content">\$...\$</div></div>
    //
    // Flow: strip Asciidoctor delimiters → convert AsciiMath to TeX → renderMath → finishRenderMath
    private async renderMathFormulas(): Promise<void> {
        if (!this.previewEl) return;
        const hasBlocks = !!this.previewEl.querySelector('.stem, .stemblock');
        const txt = this.previewEl.textContent ?? '';
        if (!hasBlocks && !txt.includes('\\$') && !txt.includes('\\(')) return;
        // Wait for Obsidian's bundled MathJax to initialise (safe to call multiple times)
        await loadMathJax();

        // Re-query AFTER the await so we always have fresh DOM refs in case
        // renderPreview() ran again while loadMathJax() was resolving
        const stems = Array.from(
            this.previewEl.querySelectorAll<HTMLElement>('.stem, .stemblock')
        );

        const toTypeset: HTMLElement[] = [];

        for (const el of stems) {
            // Skip detached nodes (previewEl was replaced while we awaited)
            if (!el.isConnected) continue;
            // Skip already-rendered elements
            if (el.querySelector('mjx-container')) continue;

            const isBlock = el.classList.contains('stemblock');

            // For block stems the actual formula lives in the nested .content div
            const srcEl = isBlock
                ? (el.querySelector<HTMLElement>('.content') ?? el)
                : el;

            let src    = srcEl.textContent?.trim() ?? '';
            let display = isBlock;

            if (src.startsWith('\\(') && src.endsWith('\\)')) {
                // LaTeX inline
                src = src.slice(2, -2).trim();
            } else if (src.startsWith('\\[') && src.endsWith('\\]')) {
                // LaTeX block
                src = src.slice(2, -2).trim();
                display = true;
            } else if (src.startsWith('\\$') && src.endsWith('\\$')) {
                // AsciiMath — convert to TeX with bundled parser
                try {
                    src = _am2tex.parse(src.slice(2, -2).trim());
                } catch {
                    src = src.slice(2, -2).trim();
                }
            }

            if (!src) continue;

            try {
                const rendered = renderMath(src, display);
                el.empty();
                el.appendChild(rendered);
                if (!display) toTypeset.push(el);
            } catch (e) {
                console.error('[AsciiDoc Live] renderMath error:', e, { src, display });
            }
        }

        // Inline stem:[], latexmath:[], asciimath:[] are emitted by Asciidoctor as raw
        // \(...\) or \$...\$ text inside paragraphs, so replace those text runs.
        this.renderInlineMath(toTypeset);
        // Apply MathJax stylesheet for all rendered elements
        await finishRenderMath();

        // For inline math: ensure MathJax processes the newly attached containers
        // by triggering a typeset pass if the MathJax 3 API is available
        if (toTypeset.length > 0) {
            const MJ = (window as unknown as { MathJax?: MathJaxAPI }).MathJax;
            if (typeof MJ?.typesetPromise === 'function') {
                try {
                    await MJ.typesetPromise(toTypeset);
                } catch (e) {
                    // non-fatal; renderMath already created the containers
                    console.debug('[AsciiDoc Live] MathJax.typesetPromise error:', e);
                }
            }
        }
    }

    // ---- Find in document ----

    private buildFindBar(container: HTMLElement): void {
        this.findBarEl = container.createDiv({ cls: 'adoc-find-bar adoc-hidden' });
        this.findInputEl = this.findBarEl.createEl('input', {
            cls: 'adoc-find-input',
            attr: { type: 'text', placeholder: 'Find in document', spellcheck: 'false' },
        });
        this.findCountEl = this.findBarEl.createSpan({ cls: 'adoc-find-count' });

        const mk = (icon: string, title: string, fn: () => void) => {
            const b = this.findBarEl.createEl('button', { cls: 'adoc-toolbar-btn', attr: { title } });
            setIcon(b, icon);
            b.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
        };
        mk('chevron-up', 'Previous match (Shift+Enter)', () => this.stepFind(-1));
        mk('chevron-down', 'Next match (Enter)', () => this.stepFind(1));
        mk('x', 'Close (Esc)', () => this.closeFind());

        this.findInputEl.addEventListener('input', () => this.runFind(true));
        this.findInputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.stepFind(e.shiftKey ? -1 : 1);
            }
        });
    }

    isFindOpen(): boolean {
        return !!this.findBarEl && !this.findBarEl.hasClass('adoc-hidden');
    }

    openFind(): void {
        if (!this.findBarEl) return;
        let seed = '';
        if (this.mode === 'source') {
            const ta = this.sourceEl;
            seed = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        } else {
            seed = activeWindow.getSelection()?.toString() ?? '';
        }
        if (seed && !seed.includes('\n')) this.findInputEl.value = seed;
        this.findBarEl.removeClass('adoc-hidden');
        this.findInputEl.focus();
        this.findInputEl.select();
        this.runFind(true);
    }

    closeFind(): void {
        if (!this.findBarEl) return;
        this.findBarEl.addClass('adoc-hidden');
        this.clearFindHighlights();
        this.findRanges = [];
        this.findSourceHits = [];
        if (this.mode === 'source') this.sourceEl.focus();
        else this.previewEl.focus();
    }

    private clearFindHighlights(): void {
        const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
        hl?.delete('adoc-find');
        hl?.delete('adoc-find-current');
        this.mirrorEl?.empty();
    }

    // Paint all matches in the source textarea via a transparent mirror layer behind it
    private updateMirror(): void {
        const ta = this.sourceEl;
        const m = this.mirrorEl;
        m.empty();
        if (this.mode !== 'source' || !this.findSourceHits.length) return;

        const cs = getComputedStyle(ta);
        for (const p of ['font-family', 'font-size', 'line-height', 'padding-top', 'padding-right',
            'padding-bottom', 'padding-left', 'white-space', 'overflow-wrap', 'word-break',
            'tab-size', 'letter-spacing']) {
            m.style.setProperty(p, cs.getPropertyValue(p));
        }
        m.style.setProperty('width', `${ta.clientWidth}px`);
        m.style.setProperty('height', `${ta.clientHeight}px`);

        const text = ta.value;
        const len = this.findInputEl.value.length;
        let pos = 0;
        this.findSourceHits.forEach((h, i) => {
            m.appendText(text.slice(pos, h));
            m.createEl('mark', {
                cls: i === this.findIndex ? 'adoc-find-mark adoc-find-mark-current' : 'adoc-find-mark',
                text: text.slice(h, h + len),
            });
            pos = h + len;
        });
        m.appendText(text.slice(pos) + '\n');
        this.syncMirrorScroll();
    }

    private syncMirrorScroll(): void {
        this.mirrorEl.scrollTop = this.sourceEl.scrollTop;
        this.mirrorEl.scrollLeft = this.sourceEl.scrollLeft;
    }

    private runFind(reset: boolean): void {
        const query = this.findInputEl.value;
        this.clearFindHighlights();
        this.findRanges = [];
        this.findSourceHits = [];
        if (!query) {
            this.findCountEl.setText('');
            return;
        }
        const needle = query.toLowerCase();

        if (this.mode === 'source') {
            const hay = this.sourceEl.value.toLowerCase();
            let i = hay.indexOf(needle);
            while (i !== -1) {
                this.findSourceHits.push(i);
                i = hay.indexOf(needle, i + Math.max(1, needle.length));
            }
            if (reset) {
                const from = this.sourceEl.selectionStart;
                const idx = this.findSourceHits.findIndex(p => p >= from);
                this.findIndex = idx === -1 ? 0 : idx;
            }
        } else {
            const walker = activeDocument.createTreeWalker(this.previewEl, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const parent = (n as Text).parentElement;
                if (parent?.closest('mjx-container, script, style')) continue;
                const text = (n.nodeValue ?? '').toLowerCase();
                let i = text.indexOf(needle);
                while (i !== -1) {
                    const r = activeDocument.createRange();
                    r.setStart(n, i);
                    r.setEnd(n, i + needle.length);
                    this.findRanges.push(r);
                    i = text.indexOf(needle, i + Math.max(1, needle.length));
                }
            }
            if (reset) this.findIndex = 0;
        }

        const total = this.mode === 'source' ? this.findSourceHits.length : this.findRanges.length;
        if (this.findIndex >= total) this.findIndex = 0;
        this.showFindCurrent(reset);
    }

    private stepFind(dir: 1 | -1): void {
        const total = this.mode === 'source' ? this.findSourceHits.length : this.findRanges.length;
        if (total === 0) { this.runFind(true); return; }
        this.findIndex = (this.findIndex + dir + total) % total;
        this.showFindCurrent(true);
    }

    private showFindCurrent(scroll: boolean): void {
        const total = this.mode === 'source' ? this.findSourceHits.length : this.findRanges.length;
        this.findCountEl.setText(total ? `${this.findIndex + 1}/${total}` : 'No results');
        if (!total) return;

        if (this.mode === 'source') {
            const ta = this.sourceEl;
            const start = this.findSourceHits[this.findIndex];
            const end = start + this.findInputEl.value.length;
            if (scroll) {
                // Scroll the textarea so the match is roughly centred
                const full = ta.value;
                ta.value = full.slice(0, start);
                ta.scrollTop = ta.scrollHeight;
                const target = Math.max(0, ta.scrollTop - ta.clientHeight / 2);
                ta.value = full;
                ta.scrollTop = target;
            }
            ta.setSelectionRange(start, end);
            this.updateMirror();
            return;
        }

        const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
        const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
        if (HL && hl) {
            hl.set('adoc-find', new HL(...this.findRanges));
            hl.set('adoc-find-current', new HL(this.findRanges[this.findIndex]));
        }
        if (scroll) {
            this.findRanges[this.findIndex].startContainer.parentElement
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }
    private renderInlineMath(toTypeset: HTMLElement[]): void {
        const re = /\\\$([^\n]+?)\\\$|\\\(([^\n]+?)\\\)/g;
        const walker = activeDocument.createTreeWalker(this.previewEl, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n as Text;
            const v = t.nodeValue ?? '';
            if (!v.includes('\\$') && !v.includes('\\(')) continue;
            if (t.parentElement?.closest('pre, code, .stemblock, mjx-container, script, style')) continue;
            nodes.push(t);
        }
        for (const t of nodes) {
            const v = t.nodeValue ?? '';
            const frag = createFragment();
            let last = 0;
            let found = false;
            re.lastIndex = 0;
            for (let m = re.exec(v); m; m = re.exec(v)) {
                let tex = (m[1] ?? m[2] ?? '').trim();
                if (!tex) continue;
                // \$...\$ is AsciiMath unless it already looks like LaTeX
                if (m[1] !== undefined && !tex.includes('\\')) {
                    try { tex = _am2tex.parse(tex); } catch { /* keep raw */ }
                }
                try {
                    const rendered = renderMath(tex, false);
                    frag.appendChild(activeDocument.createTextNode(v.slice(last, m.index)));
                    const span = createSpan({ cls: 'adoc-inline-math' });
                    span.appendChild(rendered);
                    frag.appendChild(span);
                    toTypeset.push(span);
                    last = m.index + m[0].length;
                    found = true;
                } catch (e) {
                    console.error('[AsciiDoc Live] inline renderMath error:', e, { tex });
                }
            }
            if (!found) continue;
            frag.appendChild(activeDocument.createTextNode(v.slice(last)));
            t.replaceWith(frag);
        }
    }
    // Resolve image src attributes to vault resource URLs.
    // Tries relative path first (standard AsciiDoc), then absolute vault path.
    private resolveImages(): void {
        if (!this.previewEl) return;
        const parentPath = (this.file?.parent && !this.file.parent.isRoot())
            ? this.file.parent.path
            : '';

        this.previewEl.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
            const rawSrc = img.getAttribute('src') ?? '';
            if (!rawSrc
                || rawSrc.startsWith('http')
                || rawSrc.startsWith('data:')
                || rawSrc.startsWith('blob:')
                || rawSrc.startsWith('app:')) return;

            // URL-decode: Asciidoctor may encode spaces as %20 in src attributes
            let src: string;
            try { src = decodeURIComponent(rawSrc); } catch { src = rawSrc; }

            // 1. Relative to current file's parent folder (standard AsciiDoc resolution)
            if (parentPath) {
                const f = this.app.vault.getAbstractFileByPath(`${parentPath}/${src}`);
                if (f instanceof TFile) { img.src = this.app.vault.getResourcePath(f); return; }
            }

            // 2. Absolute vault path (used when image is in a different attachment folder)
            const f = this.app.vault.getAbstractFileByPath(src);
            if (f instanceof TFile) img.src = this.app.vault.getResourcePath(f);
        });
    }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class AdocPlugin extends Plugin {
    settings: AdocPluginSettings;
    processor: AsciidoctorProcessor;
    private activeViews: Set<AdocView> = new Set();

    // Pending cross-document anchor navigation set by handleLinkClick,
    // consumed by the target view's renderPreview()
    pendingAnchor: { file: TFile; id: string } | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.processor = Asciidoctor() as unknown as AsciidoctorProcessor;

        this.registerView(VIEW_TYPE_ADOC, leaf => new AdocView(leaf, this));
        this.registerExtensions(['adoc', 'asciidoc', 'asc'], VIEW_TYPE_ADOC);

        this.addSettingTab(new AdocSettingTab(this.app, this));

        this.addCommand({
            id: 'find-in-document',
            name: 'Find in document',
            checkCallback: (checking: boolean) => {
                const view = this.app.workspace.getActiveViewOfType(AdocView);
                if (!view) return false;
                if (!checking) view.openFind();
                return true;
            },
        });

        this.addCommand({
            id: 'new-adoc-note',
            name: 'New .adoc note',
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                const folder = activeFile?.parent ?? this.app.vault.getRoot();
                await this.createAdocNote(folder);
            },
        });

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
                const folder = file instanceof TFolder ? file : file.parent;
                if (!folder) return;
                menu.addItem(item => {
                    item
                        .setTitle('New .adoc note')
                        .setIcon('file-plus-2')
                        .setSection('action')
                        .onClick(async () => {
                            await this.createAdocNote(folder);
                        });
                });
            })
        );
    }

    private async createAdocNote(folder: TFolder): Promise<void> {
        const folderPath = folder.isRoot() ? '' : folder.path;
        const newPath = this.uniqueAdocPath(folderPath, 'Untitled');
        const newFile = await this.app.vault.create(newPath, '= Untitled\n\n');
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(newFile);
    }

    private uniqueAdocPath(folderPath: string, baseName: string): string {
        const prefix = folderPath ? `${folderPath}/` : '';
        let path = `${prefix}${baseName}.adoc`;
        let i = 1;
        while (this.app.vault.getAbstractFileByPath(path)) {
            path = `${prefix}${baseName} ${i++}.adoc`;
        }
        return path;
    }

    registerAdocView(view: AdocView): void { this.activeViews.add(view); }
    unregisterAdocView(view: AdocView): void { this.activeViews.delete(view); }

    broadcastContentChange(file: TFile | null, content: string): void {
        if (!file) return;
        for (const view of this.activeViews) {
            if ((view as TextFileView).file === file) view.pushContentUpdate(content);
        }
    }

    async loadSettings(): Promise<void> {
        const saved = (await this.loadData()) as Partial<AdocPluginSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    onunload(): void { this.activeViews.clear(); }
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class AdocSettingTab extends PluginSettingTab {
    plugin: AdocPlugin;

    constructor(app: App, plugin: AdocPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // Declarative settings (Obsidian 1.13+, enables settings search); display() below is the fallback.
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: 'Auto-refresh delay (ms)',
                desc: 'How long to wait after the last keystroke before updating the preview',
                control: {
                    type: 'number',
                    key: 'refreshDelay',
                    defaultValue: 500,
                    min: 100,
                    placeholder: '500',
                    validate: (v: number) => (v >= 100 ? undefined : 'Minimum is 100 ms'),
                },
            },
        ];
    }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Auto-refresh delay (ms)')
            .setDesc('How long to wait after the last keystroke before updating the preview')
            .addText(text =>
                text
                    .setPlaceholder('500')
                    .setValue(this.plugin.settings.refreshDelay.toString())
                    .onChange(async value => {
                        const parsed = parseInt(value);
                        this.plugin.settings.refreshDelay =
                            isNaN(parsed) || parsed < 100 ? 500 : parsed;
                        await this.plugin.saveSettings();
                    })
            );
    }
}
