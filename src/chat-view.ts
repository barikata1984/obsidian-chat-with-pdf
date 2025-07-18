import { ItemView, WorkspaceLeaf, requestUrl } from "obsidian";
import MyPlugin from "./main";

export const CHAT_VIEW_TYPE = "pdf-chat-view";

export class ChatView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: MyPlugin) {
		super(leaf);
	}

	getViewType() { return "pdf-chat-view"; }
	getDisplayText() { return "PDF Chat"; }

	async onOpen() {
		const container = this.contentEl;
		container.empty();
		container.createEl("h4", { text: "PDF Chat (Gemini)" });

		const chatContainer = container.createDiv({ cls: "chat-container" });
		const messagesEl = chatContainer.createDiv({ cls: "chat-messages" });
		const inputContainer = chatContainer.createDiv({ cls: "chat-input-container" });
		const inputEl = inputContainer.createEl("input", { type: "text", placeholder: "PDFについて質問..." });
		const sendButton = inputContainer.createEl("button", { text: "送信" });

		this.registerDomEvent(sendButton, 'click', async () => {
			const userInput = inputEl.value;
			if (!userInput || !messagesEl.isConnected) return;

			messagesEl.createEl("div", { text: `${userInput}`, cls: "user-message" });
			inputEl.value = "";
			const thinkingEl = messagesEl.createEl("div", { text: "AIが考え中...", cls: "ai-message" });
			
			const apiKey = this.plugin.settings.apiKey;
			const pdfText = this.plugin.currentPdfText;
			const modelName = this.plugin.settings.selectedModel;

			if (!apiKey || !pdfText || !modelName) {
				const errorMsg = !apiKey ? "エラー: APIキーが設定されていません。" : !modelName ? "エラー: モデルが選択されていません。" : "エラー: 解析対象のPDFが開かれていません。";
				if (thinkingEl.isConnected) thinkingEl.setText(errorMsg);
				return;
			}

			try {
				const prompt = `以下のPDFの内容に基づいて、次の質問に簡潔に答えてください。\n---\nPDF内容:\n${pdfText.substring(0, 12000)}\n---\n質問: ${userInput}`;
				
				const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent`;
				const requestBody = {
					contents: [{
						parts: [{
							text: prompt
						}]
					}]
				};

				const response = await requestUrl({
					url: url,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-goog-api-key': apiKey
					},
					body: JSON.stringify(requestBody),
				});
				
				if (thinkingEl.isConnected) {
					if (response.json.candidates && response.json.candidates.length > 0) {
						const answer = response.json.candidates[0].content.parts[0].text;
						thinkingEl.setText(answer);
					} else {
						console.warn("Gemini Response Blocked or Empty:", response.json);
						thinkingEl.setText("AIからの応答がありませんでした。プロンプトが安全性フィルターによってブロックされた可能性があります。");
					}
				}
			} catch (error) {
				console.error("API Call failed:", error);
				if (thinkingEl.isConnected) {
					thinkingEl.setText("エラー: AIからの応答取得に失敗しました。APIキーやインターネット接続、コンソールの詳細エラーを確認してください。");
				}
			}
		});
	}
	async onClose() {}
}