import { ItemView, WorkspaceLeaf, requestUrl, Notice, MarkdownRenderer } from "obsidian";
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


	constructor(leaf: WorkspaceLeaf, private plugin: MyPlugin) {
		super(leaf);
	}

	getViewType() { return "pdf-chat-view"; }
	getDisplayText() { return "PDF Chat"; }

	async onOpen() {
		const container = this.contentEl;
		container.empty();
		
		const headerEl = container.createDiv({ cls: 'chat-header' });
		headerEl.createEl("h4", { text: "PDF Chat (Gemini)" });
		const clearButton = headerEl.createEl('button', { text: 'Clear Chat', cls: 'clear-chat-button' });

		this.registerDomEvent(clearButton, 'click', () => {
			this.conversationHistory = [];
			if (this.messagesEl) { this.messagesEl.empty(); }
			new Notice("Chat history has been cleared.");
		});

		const chatContainer = container.createDiv({ cls: "chat-container" });
		this.messagesEl = chatContainer.createDiv({ cls: "chat-messages" });
		const inputContainer = container.createDiv({ cls: "chat-input-container" });
		this.inputEl = inputContainer.createEl("input", { type: "text", placeholder: "..." });
		this.sendButton = inputContainer.createEl("button", { text: "送信" });

		// ★ 送信ボタンの処理を完全に復元
		this.registerDomEvent(this.sendButton, 'click', async () => {
			const userInput = this.inputEl.value;
			if (!userInput || !this.messagesEl.isConnected || this.inputEl.disabled) return;

			this.messagesEl.createEl("div", { text: userInput, cls: "user-message" });
			this.inputEl.value = "";
			
			this.conversationHistory.push({ role: 'user', parts: [{ text: userInput }] });
			
			const aiResponseWrapper = this.messagesEl.createDiv({ cls: 'ai-response-wrapper' });
			const answerBubbleEl = aiResponseWrapper.createDiv({ text: "AIが考え中...", cls: "ai-message" });
			
			const apiKey = this.plugin.settings.apiKey;
			const pdfText = this.plugin.currentPdfText;
			const modelName = this.plugin.settings.selectedModel;

			if (!apiKey || !pdfText || !modelName) {
				const errorMsg = !apiKey ? "エラー: APIキーが設定されていません。" : !modelName ? "エラー: モデルが選択されていません。" : "エラー: 解析対象のPDFが開かれていません。";
				if (answerBubbleEl.isConnected) answerBubbleEl.setText(errorMsg);
				this.conversationHistory.pop();
				return;
			}

			try {
				const systemPrompt = `あなたは、以下のPDF全文を読んだ上で、ユーザーの質問に答えるアシスタントです。会話の文脈も考慮して、自然な対話を行ってください。\n\n--- PDF CONTENT ---\n${pdfText}\n--- END PDF CONTENT ---\n\n以上の内容を踏まえて、次のユーザーの質問に答えてください。回答は必ずMarkdown形式で、見出しやリスト、太字などを使って分かりやすく整形してください。`;
				
				const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`;
				
				const requestBody = {
					contents: [
						...this.conversationHistory.slice(0, -1),
						{
							role: 'user',
							parts: [
								{ text: systemPrompt }, 
								{ text: userInput }
							]
						}
					]
				};

				const response = await requestUrl({
					url: url,
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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
						let errorMessage = "AIからの応答がありませんでした。";
						if (response.json.promptFeedback?.blockReason) {
							errorMessage += ` (理由: ${response.json.promptFeedback.blockReason})`;
						}
						answerBubbleEl.setText(errorMessage);
					}
				}
			} catch (error) {
				this.conversationHistory.pop();
				console.error("API Call failed:", error);
				let detailedError = "API呼び出しに失敗しました。";
				if (error.response) {
					try {
						const errorJson = JSON.parse(error.response);
						if (errorJson.error?.message) { detailedError = `エラー: ${errorJson.error.message}`; }
					} catch (e) { /* ignore parsing error */ }
				}
				if (answerBubbleEl.isConnected) {
					answerBubbleEl.setText(detailedError + " 詳細はコンソールを確認してください。");
				}
			}
		});

        this.plugin.onEmbeddingStateChange = this.updateInputState;
        this.updateInputState();
	}

    async onClose() {
        if (this.plugin) {
            this.plugin.onEmbeddingStateChange = null;
        }
        return super.onClose();
    }

    private updateInputState = () => {
        if (!this.inputEl || !this.sendButton) return;

        if (this.plugin.isEmbeddingInProgress) {
            this.inputEl.disabled = true;
            this.sendButton.disabled = true;
            this.inputEl.classList.add('is-processing');

            const progress = this.plugin.embeddingProgress;
            if (progress === 0) {
                this.inputEl.placeholder = "PDFの解析と準備をしています...";
            } else {
                this.inputEl.placeholder = `埋め込みベクトルを生成中... ${progress}%`;
            }
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
    }
}