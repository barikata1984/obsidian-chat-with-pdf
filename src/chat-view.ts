import { ItemView, WorkspaceLeaf, requestUrl, MarkdownRenderer, Notice, setIcon } from "obsidian";
import MyPlugin from "./main";

export type ProcessingState = {
	status: 'idle' | 'reading' | 'complete' | 'error';
	progress?: number;
	total?: number;
}

interface GeminiContent {
	role: 'user' | 'model';
	parts: ({ text: string; } | { inline_data: { mime_type: string; data: string; }; })[];
}

export const CHAT_VIEW_TYPE = "pdf-chat-view";

export class ChatView extends ItemView {
	private conversationHistory: GeminiContent[] = [];
	private messagesEl: HTMLDivElement;
	// ★★★ 型をHTMLTextAreaElementに変更 ★★★
    private inputEl: HTMLTextAreaElement;
    private sendButton: HTMLButtonElement;
	private screenshotButton: HTMLButtonElement;
	private screenshotPreviewContainer: HTMLDivElement;
	private attachedScreenshot: string | null = null;
    private isSelectingScreenshot = false;
	private selectionRect: HTMLDivElement | null = null;
    private startX = 0;
    private startY = 0;
    private endX = 0;
    private endY = 0;
	private currentCanvas: HTMLCanvasElement | null = null;
	private currentPdfViewEl: HTMLElement | null = null;
	private viewContainer: HTMLDivElement;
	private resizeObserver: ResizeObserver;
	private statusEl: HTMLDivElement | null = null;
    private hasChatStarted = false;

	constructor(leaf: WorkspaceLeaf, private plugin: MyPlugin) { super(leaf); }

	getViewType() { return "pdf-chat-view"; }
	getDisplayText() { return "PDF Chat"; }
	getIcon() { return "messages-square"; }

	autoGrowTextarea = () => {
        if (this.inputEl) {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
        }
    }

	async onOpen() {
		const container = this.contentEl;

		if (this.viewContainer && this.viewContainer.isConnected) {
			return;
		}
		container.empty();
		
		this.viewContainer = container.createDiv({ cls: 'chat-view-container' });
		
		const headerEl = this.viewContainer.createDiv({ cls: 'chat-header' });
		headerEl.createEl("h4", { text: "PDF Chat (Gemini)" });
		const clearButton = headerEl.createEl('button', { text: 'Clear Chat', cls: 'clear-chat-button' });

		this.registerDomEvent(clearButton, 'click', () => {
			this.conversationHistory = [];
			if (this.messagesEl) { this.messagesEl.empty(); }
			this.hasChatStarted = false;
			if(this.viewContainer) { this.viewContainer.classList.remove('is-sticky'); }
			this.updateProcessingState({ status: this.plugin.currentPdfText ? 'complete' : 'idle' });
			this.checkLayout();
			new Notice("Chat history has been cleared.");
		});
		
		this.messagesEl = this.viewContainer.createDiv({ cls: "chat-messages" });
		const inputContainer = this.viewContainer.createDiv({ cls: "chat-input-container" });

		// ★★★ inputをtextareaに変更し、イベントリスナーを追加 ★★★
		this.inputEl = inputContainer.createEl("textarea", { placeholder: "..." });
		this.inputEl.rows = 1; // 初期状態では1行の高さにする

		const buttonContainer = inputContainer.createDiv({ cls: "chat-button-container" });
		this.screenshotButton = buttonContainer.createEl("button", { text: "Take Screenshot", cls: "screenshot-button" });
		this.sendButton = buttonContainer.createEl("button", { text: "Send", cls: "send-button" });

		this.screenshotPreviewContainer = inputContainer.createDiv({ cls: "screenshot-preview-container" });

		// 入力に応じて高さを自動調整
		this.registerDomEvent(this.inputEl, 'input', this.autoGrowTextarea);
		// Enterで送信、Shift+Enterで改行
		this.registerDomEvent(this.inputEl, 'keydown', (evt) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				this.sendButton.click();
			}
		});

		this.registerDomEvent(this.screenshotButton, 'click', async () => {
			const pdfLeaves = this.app.workspace.getLeavesOfType('pdf');
			if (pdfLeaves.length === 0) {
				new Notice("No PDF file is currently open.");
				return;
			}

			let activePdfLeaf: WorkspaceLeaf | undefined;
			let foundCanvas: HTMLCanvasElement | null = null;

			for (const leaf of pdfLeaves) {
				const pdfViewEl = leaf.view.containerEl;
				const canvas = pdfViewEl.querySelector('canvas');
				if (canvas && canvas.offsetParent !== null) { // Check if canvas is visible
					activePdfLeaf = leaf;
					foundCanvas = canvas;
					break;
				}
			}

			if (!activePdfLeaf || !foundCanvas) {
				new Notice("Please open and focus on a PDF view to take a screenshot.");
				return;
			}

			this.currentPdfViewEl = activePdfLeaf.view.containerEl;
			this.currentCanvas = foundCanvas;

			if (window.getComputedStyle(this.currentPdfViewEl).position === 'static') {
				this.currentPdfViewEl.style.position = 'relative';
			}

			new Notice("Click and drag on the PDF to select an area. Press ESC to cancel.");

			this.isSelectingScreenshot = true;
			this.currentCanvas.addEventListener('mousedown', this.onMouseDown, { once: true });
			document.addEventListener('keydown', this.onKeyDown);
		});

        // ===== ここからデバッグコード =====
        const eventsToLog: (keyof HTMLElementEventMap)[] = ['keydown', 'keyup', 'keypress', 'paste', 'input', 'focus', 'blur'];
        eventsToLog.forEach(eventName => {
            this.registerDomEvent(this.inputEl, eventName, (evt) => {
                console.log(`Input Element Event: ${evt.type}`, {
                    key: (evt instanceof KeyboardEvent) ? evt.key : undefined,
                    target: evt.target,
                    isDefaultPrevented: evt.defaultPrevented,
                });
            });
        });
        // ===== ここまでデバッグコード =====

        this.registerDomEvent(this.sendButton, 'click', async () => {
            if (!this.hasChatStarted) {
                this.hasChatStarted = true;
                if (this.statusEl) {
                    this.statusEl.remove();
                    this.statusEl = null;
                }
                this.checkLayout();
            }
            const userInput = this.inputEl.value;
            if (!userInput && !this.attachedScreenshot || !this.messagesEl.isConnected || this.inputEl.disabled) return;

            const userMessageEl = this.messagesEl.createDiv({ cls: "user-message" });
            if (userInput) {
                userMessageEl.createSpan({ text: userInput });
            }
            if (this.attachedScreenshot) {
                const img = userMessageEl.createEl("img", { cls: "attached-screenshot-display" });
                img.src = this.attachedScreenshot;
            }

            this.inputEl.value = "";
            this.autoGrowTextarea(); // 
            const userParts: ({ text: string; } | { inline_data: { mime_type: string; data: string; }; })[] = [];
            if (userInput) {
                userParts.push({ text: userInput });
            }
            if (this.attachedScreenshot) {
                const base64Data = this.attachedScreenshot.split(',')[1];
                userParts.push({ inline_data: { mime_type: "image/png", data: base64Data } });
            }
            this.conversationHistory.push({ role: 'user', parts: userParts });
            this.attachedScreenshot = null;
            this.screenshotPreviewContainer.empty();
            this.checkLayout();
            this.scrollToBottom();

            const aiResponseWrapper = this.messagesEl.createDiv({ cls: 'ai-response-wrapper' });
            const answerBubbleEl = aiResponseWrapper.createDiv({ text: "AIが考え中...", cls: "ai-message" });
            this.checkLayout();
            this.scrollToBottom();

            try {
                const basePrompt = await this.app.vault.adapter.read(`${this.plugin.manifest.dir}/system_prompt.md`);
                const MAX_PDF_CONTEXT_CHARS = this.plugin.settings.pdfContextCharLimit || 100000;
                const pdfText = this.plugin.currentPdfText || '';
                const truncatedPdf = pdfText.length > MAX_PDF_CONTEXT_CHARS
                    ? `${pdfText.slice(0, MAX_PDF_CONTEXT_CHARS)}\n...（PDF内容は長いため一部のみ送信しています）`
                    : pdfText;
                if (pdfText.length > MAX_PDF_CONTEXT_CHARS) {
                    console.warn(`[chat-with-pdf] PDF context truncated from ${pdfText.length} to ${MAX_PDF_CONTEXT_CHARS} chars.`);
                }
                const pdfContext = `\n## 議論の対象\n議論の対象となるのは以下の内容です： ${truncatedPdf}`;
                const systemPrompt = basePrompt + pdfContext;

                const url = `https://generativelanguage.googleapis.com/v1beta/${this.plugin.settings.selectedModel}:generateContent`;
                const historyBase = this.conversationHistory.slice(0, -1);
                const MAX_HISTORY_MESSAGES = 10;
                const historyToSend = historyBase.slice(Math.max(0, historyBase.length - MAX_HISTORY_MESSAGES));
                const requestBody = { contents: [ ...historyToSend, { role: 'user', parts: [{ text: systemPrompt }, ...userParts] }] };

                const MAX_ATTEMPTS = this.plugin.settings.maxRetryAttempts || 3;
                let attempt = 0;
                interface ApiResponse { status: number; json: unknown; headers?: Record<string, string>; }
                let response: ApiResponse | null = null;
                type CandidateJSON = { candidates?: { content: { parts: { text?: string }[] } }[]; promptFeedback?: { blockReason?: string } };
                const hasCandidates = (r: ApiResponse | null): r is ApiResponse & { json: CandidateJSON } => {
                    if (!r || typeof r.json !== 'object' || r.json === null) return false;
                    const j = r.json as CandidateJSON;
                    return Array.isArray(j.candidates) && j.candidates.length > 0 && !!j.candidates[0].content?.parts?.[0];
                };
                while (attempt < MAX_ATTEMPTS) {
                    attempt++;
                    if (attempt > 1 && answerBubbleEl.isConnected) {
                        answerBubbleEl.setText(`一時的なエラーが発生しました。再試行中 (${attempt}/${MAX_ATTEMPTS})...`);
                        this.scrollToBottom();
                    }
                    try {
                        const raw = await requestUrl({
                            url: url, method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.plugin.settings.apiKey },
                            body: JSON.stringify(requestBody),
                        });
                        response = { status: raw.status, json: raw.json as unknown, headers: raw.headers as Record<string, string> };
                        const status = response.status;
                        if (status === 429 || status >= 500) {
                            const category = status === 429 ? 'rate-limit' : 'server';
                            console.warn('[chat-with-pdf] Transient error, will retry', { status, category, attempt, max: MAX_ATTEMPTS, headers: response.headers });
                            if (attempt < MAX_ATTEMPTS) {
                                let delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
                                const retryAfter = response.headers?.['retry-after'] || response.headers?.['Retry-After'];
                                if (retryAfter) {
                                    const raNum = parseInt(retryAfter, 10);
                                    if (!Number.isNaN(raNum) && raNum > 0) { delayMs = raNum * 1000; }
                                }
                                await new Promise(r => setTimeout(r, delayMs));
                                continue;
                            }
                        }
                        // Non-retry or success path
                        break;
                    } catch (err: unknown) {
                        console.error('[chat-with-pdf] Request attempt failed with exception', { attempt, max: MAX_ATTEMPTS, err });
                        if (attempt < MAX_ATTEMPTS) {
                            const delayMs = 1000 * Math.pow(2, attempt - 1);
                            await new Promise(r => setTimeout(r, delayMs));
                            continue;
                        }
                        throw err; // will be caught by outer catch
                    }
                }
                
                if (answerBubbleEl.isConnected) {
                    if (response && (response.status === 429 || response.status >= 500)) {
                        this.conversationHistory.pop();
                        const status = response.status;
                        try {
                            console.error('[chat-with-pdf] Final transient error after retries', { status, responseJson: response.json });
                        } catch (_) { /* swallow */ }
                        if (status === 429) {
                            answerBubbleEl.setText(`レート制限中です (HTTP 429)。数十秒～数分待ってから再度お試しください。`);
                        } else {
                            answerBubbleEl.setText(`サーバ側の一時的な問題が発生しています (HTTP ${status}). 少し待って再度お試しください。`);
                        }
                    } else if (hasCandidates(response)) {
                        const firstCandidate = (response.json as CandidateJSON).candidates?.[0];
                        const answer = firstCandidate?.content?.parts?.[0]?.text || '';
                        answerBubbleEl.empty();

                        await MarkdownRenderer.render(this.app, answer, answerBubbleEl, this.plugin.app.vault.getRoot().path, this);

                        const copyButton = answerBubbleEl.createEl('button', { cls: 'copy-code-button' });
                        copyButton.setAttribute('aria-label', 'Copy message');
                        setIcon(copyButton, "copy");
                        this.registerDomEvent(copyButton, 'click', () => {
                            navigator.clipboard.writeText(answer).then(() => {
                                new Notice("Copied to clipboard");
                            }, (err) => {
                                new Notice("Failed to copy text");
                                console.error('Failed to copy text: ', err);
                            });
                        });
                        
                        this.conversationHistory.push({ role: 'model', parts: [{ text: answer }] });
                    } else {
                        this.conversationHistory.pop();
                        try {
                            if (response && typeof response.json === 'object' && response.json !== null) {
                                const data = response.json as CandidateJSON;
                                console.warn('[chat-with-pdf] No candidates in response.', {
                                    status: response.status,
                                    promptFeedback: data?.promptFeedback,
                                    responseJson: data,
                                });
                            } else {
                                console.warn('[chat-with-pdf] No response object available when checking candidates.');
                            }
                        } catch (_) {
                            // no-op logging guard
                        }
                        if (response && typeof response.json === 'object' && response.json !== null) {
                            const data = response.json as CandidateJSON;
                            answerBubbleEl.setText(`AIからの応答がありませんでした。 (理由: ${data?.promptFeedback?.blockReason || '不明'})`);
                        } else {
                            answerBubbleEl.setText('AIからの応答がありませんでした。 (理由: 不明 - 応答オブジェクトなし)');
                        }
                    }
                }
            } catch (error) {
                this.conversationHistory.pop();
                try {
                    const maskedKey = (this.plugin?.settings?.apiKey || '').replace(/.(?=.{4})/g, '*');
                    const debugContext = {
                        model: this.plugin?.settings?.selectedModel,
                        apiKeyConfigured: !!this.plugin?.settings?.apiKey,
                        maskedApiKey: maskedKey,
                        hasPdfContext: !!this.plugin?.currentPdfText,
                        conversationLength: this.conversationHistory?.length,
                        hadImage: userParts.some(p => 'inline_data' in p),
                    };
                    console.error('[chat-with-pdf] API request failed with an exception.', error, debugContext);
                } catch (_) {
                    // if logging itself fails, avoid breaking UI
                }
                if (answerBubbleEl.isConnected) { answerBubbleEl.setText("API呼び出しに失敗しました。詳細はコンソールを確認してください。"); }
            } finally {
                this.checkLayout();
                this.scrollToBottom();
            }
        });

		this.plugin.onStateChange = this.updateProcessingState;
		
		this.resizeObserver = new ResizeObserver(() => {
			this.checkLayout();
		});
		this.resizeObserver.observe(this.contentEl);

		this.updateProcessingState({ status: this.plugin.currentPdfText ? 'complete' : 'idle' });
		this.updateScreenshotButtonText();
    }

	async onClose() {
		if (this.plugin) { this.plugin.onStateChange = null; }
		if (this.resizeObserver) { this.resizeObserver.disconnect(); }
		return super.onClose();
	}

	private scrollToBottom() {
		requestAnimationFrame(() => {
			if (this.viewContainer && this.viewContainer.classList.contains('is-sticky')) {
				this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
			}
		});
	}

	private checkLayout = () => {
		requestAnimationFrame(() => {
			if (!this.viewContainer || !this.contentEl) return;
			if (this.viewContainer.classList.contains('is-sticky')) {
				return;
			}
			const availableHeight = this.contentEl.clientHeight;
			const contentHeight = this.viewContainer.scrollHeight;
			if (contentHeight > availableHeight) {
				this.viewContainer.classList.add('is-sticky');
			}
		});
	}

	

    private displayScreenshotPreview = () => {
        if (this.attachedScreenshot) {
            this.screenshotPreviewContainer.empty();
            const img = this.screenshotPreviewContainer.createEl('img', { cls: 'screenshot-preview' });
            img.src = this.attachedScreenshot;

            const removeButton = this.screenshotPreviewContainer.createEl('button', { cls: 'remove-screenshot-button', text: 'X' });
            this.registerDomEvent(removeButton, 'click', () => {
                this.attachedScreenshot = null;
                this.screenshotPreviewContainer.empty();
                this.updateScreenshotButtonText();
                this.checkLayout();
            });
            this.updateScreenshotButtonText();
            this.checkLayout();
        } else {
            this.screenshotPreviewContainer.empty();
            this.updateScreenshotButtonText();
            this.checkLayout();
        }
    }

    private updateScreenshotButtonText = () => {
        if (this.screenshotButton) {
            this.screenshotButton.setText(this.attachedScreenshot ? "Take Screenshot ✅" : "Take Screenshot");
        }
    }

    private updateProcessingState = (state: ProcessingState) => {
        if (this.hasChatStarted) return;
        const createOrGetStatusEl = () => {
            if (!this.statusEl || !this.statusEl.isConnected) {
                this.messagesEl.querySelector('.chat-status-message')?.remove();
                this.statusEl = this.messagesEl.createDiv({ cls: 'chat-status-message' });
                this.checkLayout();
            }
            return this.statusEl;
        };
        const setInputState = (disabled: boolean, placeholder: string) => {
            if(!this.inputEl) return;
            this.inputEl.disabled = disabled;
            this.inputEl.placeholder = placeholder;
            this.autoGrowTextarea(); // プレースホルダー変更時も高さを調整
        };

        switch (state.status) {
            case 'reading': createOrGetStatusEl().setText('PDFを読み込んでいます...'); setInputState(true, 'PDFの前処理中のためお待ちください。'); break;
            case 'complete':
                if (this.plugin.currentPdfText) {
                    createOrGetStatusEl().setText('PDFの読み込みが完了しました。');
                    setInputState(false, '入力を受け付けます。');
                } else {
                    if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; this.checkLayout(); }
                    setInputState(true, '解析対象のPDFを開いてください');
                }
                break;
            case 'idle':
                if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; this.checkLayout(); }
                    setInputState(true, '解析対象のPDFを開いてください');
                break;
            case 'error':
                createOrGetStatusEl().setText('エラーが発生しました。コンソールを確認してください。');
                setInputState(true, '前処理に失敗しました。');
                break;
        }
    }

	private cleanupScreenshotListeners = () => {
		if (!this.isSelectingScreenshot) return;
		this.isSelectingScreenshot = false;

		if (this.currentCanvas) {
			this.currentCanvas.removeEventListener('mousedown', this.onMouseDown);
		}
		document.removeEventListener('mousemove', this.onMouseMove);
		document.removeEventListener('mouseup', this.onMouseUp);
		document.removeEventListener('keydown', this.onKeyDown);

		if (this.selectionRect) {
			this.selectionRect.remove();
			this.selectionRect = null;
		}
	}

    private onMouseDown = (e: MouseEvent) => {
		if (!this.isSelectingScreenshot || !this.currentCanvas || !this.currentPdfViewEl) return;
		e.preventDefault();
		e.stopPropagation();

        this.startX = e.offsetX;
        this.startY = e.offsetY;

        this.selectionRect = this.currentPdfViewEl.createDiv({ cls: 'screenshot-selection-rect' });
        Object.assign(this.selectionRect.style, {
            left: `${this.startX}px`,
            top: `${this.startY}px`,
            width: '0px',
            height: '0px',
        });

        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp);
    };

    private onMouseMove = (e: MouseEvent) => {
        if (!this.isSelectingScreenshot || !this.selectionRect) {
            return;
        }
        this.endX = e.offsetX;
        this.endY = e.offsetY;

        const x = Math.min(this.startX, this.endX);
        const y = Math.min(this.startY, this.endY);
        const width = Math.abs(this.startX - this.endX);
        const height = Math.abs(this.startY - this.endY);

        Object.assign(this.selectionRect.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: `${width}px`,
            height: `${height}px`,
        });
    };

    private onMouseUp = () => {
        if (!this.isSelectingScreenshot || !this.currentCanvas) return;

        const x = Math.min(this.startX, this.endX);
        const y = Math.min(this.startY, this.endY);
        const width = Math.abs(this.startX - this.endX);
        const height = Math.abs(this.startY - this.endY);

        if (width > 5 && height > 5) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = width;
            tempCanvas.height = height;
            const tempCtx = tempCanvas.getContext('2d');
            if (tempCtx) {
                tempCtx.drawImage(this.currentCanvas, x, y, width, height, 0, 0, width, height);
                this.attachedScreenshot = tempCanvas.toDataURL('image/png');
                this.displayScreenshotPreview();
            } else {
                new Notice("Failed to process screenshot.");
            }
        } else {
            new Notice("Screenshot area too small.");
        }
		this.cleanupScreenshotListeners();
    };

    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.isSelectingScreenshot) {
            new Notice("Screenshot selection cancelled.");
			this.cleanupScreenshotListeners();
        }
    }
}
