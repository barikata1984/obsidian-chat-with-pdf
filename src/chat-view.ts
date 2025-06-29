import { ItemView, WorkspaceLeaf, requestUrl, MarkdownRenderer, Notice } from "obsidian";
import MyPlugin from "./main";

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

	constructor(leaf: WorkspaceLeaf, private plugin: MyPlugin) {
		super(leaf);
	}

	getViewType() { return "pdf-chat-view"; }
	getDisplayText() { return "PDF Chat"; }

	async onOpen() {
		const container = this.contentEl;
		container.empty();
		
		this.viewContainer = container.createDiv({ cls: 'chat-view-container' });
		
		const headerEl = this.viewContainer.createDiv({ cls: 'chat-header' });
		headerEl.createEl("h4", { text: "PDF Chat (Gemini)" });
		const clearButton = headerEl.createEl('button', { text: 'Clear Chat', cls: 'clear-chat-button' });

		// ★ Clearボタンクリック時にレイアウトもリセットする
		this.registerDomEvent(clearButton, 'click', () => {
			this.conversationHistory = [];
			if (this.messagesEl) { this.messagesEl.empty(); }
			new Notice("Chat history has been cleared.");
			this.viewContainer.classList.remove('is-sticky'); // 固定レイアウトを解除
			this.checkLayout();
		});
		
		this.messagesEl = this.viewContainer.createDiv({ cls: "chat-messages" });
		const inputContainer = this.viewContainer.createDiv({ cls: "chat-input-container" });
		this.inputEl = inputContainer.createEl("input", { type: "text", placeholder: "..." });
		this.sendButton = inputContainer.createEl("button", { text: "送信" });

		this.registerDomEvent(this.sendButton, 'click', async () => {
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

        this.plugin.onEmbeddingStateChange = this.updateInputState;
        
		this.resizeObserver = new ResizeObserver(() => {
			this.checkLayout();
		});
		this.resizeObserver.observe(this.contentEl);

		this.updateInputState();
	}

    async onClose() {
        if (this.plugin) { this.plugin.onEmbeddingStateChange = null; }
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

	// ★★★ レイアウト判定ロジックをより安定なものに修正 ★★★
	private checkLayout = () => {
		requestAnimationFrame(() => {
			if (!this.viewContainer || !this.contentEl) return;

			// 既に下部固定レイアウトになっている場合は、何もしない
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

    private updateInputState = () => {
        if (!this.inputEl || !this.sendButton) return;
        if (this.plugin.isEmbeddingInProgress) {
            this.inputEl.disabled = true;
            this.sendButton.disabled = true;
            this.inputEl.classList.add('is-processing');
            this.inputEl.placeholder = `埋め込みベクトルを生成中... ${this.plugin.embeddingProgress}%`;
        } else {
            this.inputEl.disabled = false;
            this.sendButton.disabled = false;
            this.inputEl.classList.remove('is-processing');
            if (this.plugin.currentPdfText) {
                this.inputEl.placeholder = "PDFについて質問...";
            } else {
                this.inputEl.placeholder = "解析対象のPDFを開いてください";
            }
        }
        this.checkLayout();
    }
}