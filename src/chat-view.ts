import { ItemView, WorkspaceLeaf, requestUrl, MarkdownRenderer, Notice } from "obsidian";
import MyPlugin from "./main";

export type ProcessingState = {
	status: 'idle' | 'searching_cache' | 'loading_cache' | 'reading' | 'chunking' | 'embedding' | 'complete' | 'error';
	progress?: number;
	total?: number;
}

interface GeminiContent {
	role: 'user' | 'model';
	parts: { text: string; }[];
}

export const CHAT_VIEW_TYPE = "pdf-chat-view";

export class ChatView extends ItemView {
	private conversationHistory: GeminiContent[] = [];
	private messagesEl: HTMLDivElement;
    private inputEl: HTMLInputElement;
    private sendButton: HTMLButtonElement;
	private viewContainer: HTMLDivElement;
	private resizeObserver: ResizeObserver;
	private statusEl: HTMLDivElement | null = null;
	private hasChatStarted: boolean = false;

	constructor(leaf: WorkspaceLeaf, private plugin: MyPlugin) { super(leaf); }
	getViewType() { return "pdf-chat-view"; }
	getDisplayText() { return "PDF Chat"; }

	async onOpen() {
		const container = this.contentEl;
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
			new Notice("Chat history has been cleared.");
		});
		this.messagesEl = this.viewContainer.createDiv({ cls: "chat-messages" });
		const inputContainer = this.viewContainer.createDiv({ cls: "chat-input-container" });
		this.inputEl = inputContainer.createEl("input", { type: "text", placeholder: "..." });
		this.sendButton = inputContainer.createEl("button", { text: "送信" });

		this.registerDomEvent(this.sendButton, 'click', async () => {
			if (!this.hasChatStarted) {
				this.hasChatStarted = true;
				if (this.statusEl) {
					this.statusEl.remove();
					this.statusEl = null;
				}
			}
			const userInput = this.inputEl.value;
			if (!userInput || !this.messagesEl.isConnected || this.inputEl.disabled) return;
			this.messagesEl.createEl("div", { text: userInput, cls: "user-message" });
			this.inputEl.value = "";
			this.conversationHistory.push({ role: 'user', parts: [{ text: userInput }] });
			this.checkLayout();
			this.scrollToBottom(); 

			const aiResponseWrapper = this.messagesEl.createDiv({ cls: 'ai-response-wrapper' });
			const answerBubbleEl = aiResponseWrapper.createDiv({ text: "AIが考え中...", cls: "ai-message" });
			this.checkLayout();
			this.scrollToBottom();

			try {
				const systemPrompt = `あなたは、以下のPDF全文を読んだ上で、ユーザーの質問に答えるアシスタントです。会話の文脈も考慮して、自然な対話を行ってください。\n\n--- PDF CONTENT ---\n${this.plugin.currentPdfText}\n--- END PDF CONTENT ---\n\n以上の内容を踏まえて、次のユーザーの質問に答えてください。回答は必ずMarkdown形式で、見出しやリスト、太字などを使って分かりやすく整形してください。`;
				const url = `https://generativelanguage.googleapis.com/v1beta/${this.plugin.settings.selectedModel}:generateContent`;
				const requestBody = { contents: [ ...this.conversationHistory.slice(0, -1), { role: 'user', parts: [{ text: systemPrompt }, { text: userInput }] }] };

				const response = await requestUrl({
					url: url, method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.plugin.settings.apiKey },
					body: JSON.stringify(requestBody),
				});
				
				if (answerBubbleEl.isConnected) {
					if (response.json.candidates && response.json.candidates.length > 0) {
						const answer = response.json.candidates[0].content.parts[0].text;
						answerBubbleEl.empty();
						await MarkdownRenderer.render(this.app, answer, answerBubbleEl, this.plugin.app.vault.getRoot().path, this);
						this.conversationHistory.push({ role: 'model', parts: [{ text: answer }] });

						// ★★★ ここからが修正点：類似度を計算して表示 ★★★
						const answerEmbedding = await this.plugin.getEmbedding(answer);
						if (answerEmbedding) {
							const maxSimilarity = this.plugin.findMaxSimilarity(answerEmbedding);
							if (maxSimilarity > 0) {
								answerBubbleEl.createDiv({
									cls: 'similarity-score',
									text: `(最大関連度: ${(maxSimilarity * 100).toFixed(1)}%)`
								});
							}
						}
						// ★★★ 修正点ここまで ★★★

					} else {
						this.conversationHistory.pop();
						answerBubbleEl.setText(`AIからの応答がありませんでした。 (理由: ${response.json.promptFeedback?.blockReason || '不明'})`);
					}
				}
			} catch (error) {
				this.conversationHistory.pop();
				if (answerBubbleEl.isConnected) { answerBubbleEl.setText("API呼び出しに失敗しました。詳細はコンソールを確認してください。"); }
			} finally {
				this.checkLayout();
				this.scrollToBottom();
			}
		});

        this.plugin.onStateChange = this.updateProcessingState;
		this.resizeObserver = new ResizeObserver(() => { this.checkLayout(); });
		this.resizeObserver.observe(this.contentEl);
		this.updateProcessingState({ status: this.plugin.currentPdfText ? 'complete' : 'idle' });
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
			if (this.viewContainer.classList.contains('is-sticky')) { return; }
			const availableHeight = this.contentEl.clientHeight;
			const contentHeight = this.viewContainer.scrollHeight;
			if (contentHeight > availableHeight) {
				this.viewContainer.classList.add('is-sticky');
			}
		});
	}

    private updateProcessingState = (state: ProcessingState) => {
		if (this.hasChatStarted) return;
		const createOrGetStatusEl = () => {
			if (!this.statusEl || !this.statusEl.isConnected) {
				this.messagesEl.querySelector('.chat-status-message')?.remove();
				this.statusEl = this.messagesEl.createDiv({ cls: 'chat-status-message' });
			}
			return this.statusEl;
		};
		const setInputState = (disabled: boolean, placeholder: string) => {
			if(!this.inputEl) return;
			this.inputEl.disabled = disabled;
			this.inputEl.placeholder = placeholder;
		};

		switch (state.status) {
			case 'searching_cache': createOrGetStatusEl().setText('エンべディングキャッシュの検索中...'); setInputState(true, 'PDFの前処理中のためお待ちください。'); break;
			case 'loading_cache': createOrGetStatusEl().setText('キャッシュからエンベディングを読み込んでいます...'); setInputState(true, 'PDFの前処理中のためお待ちください。'); break;
			case 'reading': createOrGetStatusEl().setText('PDFを読み込んでいます...'); setInputState(true, 'PDFの前処理中のためお待ちください。'); break;
			case 'chunking': createOrGetStatusEl().setText('テキストをチャンク化しています...'); setInputState(true, 'PDFの前処理中のためお待ちください。'); break;
			case 'embedding': createOrGetStatusEl().setText(`チャンクのエンベディングを計算中 - ${state.progress} / ${state.total} 完了`); setInputState(true, 'PDFの前処理中のためお待ちください。'); break;
			case 'complete':
				if (this.plugin.currentPdfText) {
					createOrGetStatusEl().setText('エンベディング取得完了');
					setInputState(false, '入力を受け付けます。');
				} else {
					if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; }
					setInputState(true, '解析対象のPDFを開いてください');
				}
				break;
			case 'idle':
				if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; }
				setInputState(true, '解析対象のPDFを開いてください');
				break;
			case 'error':
				createOrGetStatusEl().setText('エラーが発生しました。コンソールを確認してください。');
				setInputState(true, '前処理に失敗しました。');
				break;
		}
		this.checkLayout();
	}
}