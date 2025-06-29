import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, requestUrl, Notice, TFile } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';

interface MyPluginSettings {
	apiKey: string;
	selectedModel: string;
	selectedEmbeddingModel: string;
	lastProcessedFile?: string | null;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	apiKey: '',
	selectedModel: 'models/gemini-1.5-pro-latest',
	selectedEmbeddingModel: 'models/text-embedding-004',
	lastProcessedFile: null,
}

export interface PdfChunk {
  text: string;
  page: number;
  embedding: number[];
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	currentPdfText: string = "";
	currentPdfChunks: PdfChunk[] = [];
    public isEmbeddingInProgress: boolean = false;
    public embeddingProgress: number = 0;
	public onEmbeddingStateChange: (() => void) | null = null;

	async onload() {
		await this.loadSettings();
		const workerPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/pdf.worker.mjs`;
		pdfjsLib.GlobalWorkerOptions.workerSrc = this.app.vault.adapter.getResourcePath(workerPath);
		this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));
		this.addRibbonIcon("messages-square", "Open PDF Chat", () => { this.activateView(); });
		this.app.workspace.onLayoutReady(() => { this.processActiveLeaf(this.app.workspace.activeLeaf); });
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => { this.processActiveLeaf(leaf); }));
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
	}
	
	async processActiveLeaf(leaf: WorkspaceLeaf | null) {
		if (!leaf) return;
		const viewType = leaf.view.getViewType();
		if (viewType === 'pdf') {
			const file = leaf.view.file;
			if (file instanceof TFile) {
				if (this.settings.lastProcessedFile !== file.path || !this.currentPdfText) {
					await this.preparePdf(file);
				}
			}
			return;
		}
		if (viewType === CHAT_VIEW_TYPE) { return; }
		if (this.currentPdfText !== "") {
			this.currentPdfText = "";
			this.currentPdfChunks = [];
			this.settings.lastProcessedFile = null;
			await this.saveSettings();
			this.onEmbeddingStateChange?.();
		}
	}

	async parsePdf(data: ArrayBuffer): Promise<string> {
		try {
			const pdf = await pdfjsLib.getDocument(data).promise;
			let fullText = "";
			for (let i = 1; i <= pdf.numPages; i++) {
				const page = await pdf.getPage(i);
				const textContent = await page.getTextContent();
				const pageText = textContent.items
					.filter(item => 'str' in item)
					.map(item => (item as { str: string }).str)
					.join(' ');
				fullText += `[Page ${i}]\n${pageText}\n\n`;
			}
			return fullText;
		} catch (error) {
			console.error("PDF parsing failed:", error);
			new Notice("Failed to parse PDF.");
			return "";
		}
	}

	splitIntoChunks(fullText: string): { text: string; page: number }[] {
        const chunks: { text: string; page: number }[] = [];
        const pageContents = fullText.split(/(\[Page \d+\]\n)/).slice(1);
        for (let i = 0; i < pageContents.length; i += 2) {
            const pageHeader = pageContents[i];
            const pageText = pageContents[i + 1];
            const pageMatch = pageHeader.match(/\[Page (\d+)\]/);
            const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : 0;
            const paragraphs = pageText.split(/\n\s*\n/).filter(p => p.trim().length > 100);
            for (const para of paragraphs) {
                chunks.push({ text: para.trim(), page: pageNum });
            }
        }
        return chunks;
    }
	
	async preparePdf(file: TFile) {
		if (!this.settings.apiKey) { new Notice("API Key is not set."); return; }
        this.isEmbeddingInProgress = true;
        this.embeddingProgress = 0;
		this.settings.lastProcessedFile = file.path;
		await this.saveSettings();
        this.onEmbeddingStateChange?.();
		try {
			this.currentPdfText = await this.parsePdf(await this.app.vault.readBinary(file));
			this.currentPdfChunks = [];
			const chunksToEmbed = this.splitIntoChunks(this.currentPdfText);
			if (chunksToEmbed.length === 0) {
				new Notice("No text content found in the PDF to analyze.");
				return;
			}
            new Notice(`Generating embeddings for ${chunksToEmbed.length} text chunks...`);
			for (const chunk of chunksToEmbed) {
				const embedding = await this.getEmbedding(chunk.text);
				if (embedding) { this.currentPdfChunks.push({ ...chunk, embedding }); }
                this.embeddingProgress = Math.round((this.currentPdfChunks.length / chunksToEmbed.length) * 100);
                this.onEmbeddingStateChange?.();
			}
			if (this.currentPdfChunks.length > 0) { new Notice(`Ready to chat about ${file.basename}.`); }
		} catch (error) {
			new Notice("Failed to prepare PDF. Check API key or developer console.", 7000);
		} finally {
            this.isEmbeddingInProgress = false;
            this.onEmbeddingStateChange?.();
        }
	}

	async getEmbedding(text: string): Promise<number[] | null> {
		const model = this.settings.selectedEmbeddingModel;
        if (!model) { throw new Error("Embedding model not selected."); }
		const url = `https://generativelanguage.googleapis.com/v1beta/${model}:embedContent`;
		const response = await requestUrl({
			url: url, method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.settings.apiKey },
			body: JSON.stringify({ content: { parts: [{ text: text }] } })
		});
		return response.json?.embedding?.values || null;
	}

	async fetchAvailableModels(key: string): Promise<string[]> {
		if (!key) return [];
		try {
			const url = `https://generativelanguage.googleapis.com/v1beta/models`;
			const response = await requestUrl({ url, method: 'GET', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key } });
			return response.json.models
				.filter((model: any) => model.supportedGenerationMethods.includes("generateContent"))
				.map((model: any) => model.name);
		} catch (error) { new Notice("Failed to fetch models."); return []; }
	}

	async fetchAvailableEmbeddingModels(key: string): Promise<string[]> {
		if (!key) return [];
		try {
			const url = `https://generativelanguage.googleapis.com/v1beta/models`;
			const response = await requestUrl({ url, method: 'GET', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key } });
			return response.json.models
				.filter((model: any) => model.supportedGenerationMethods.includes("embedContent"))
				.map((model: any) => model.name);
		} catch (error) { new Notice("Failed to fetch embedding models."); return []; }
	}

	// ★★★ activateViewメソッドを修正 ★★★
	//async activateView() {
	//	// 既存のチャットビューがあれば、一旦閉じる
	//	this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
	//
	//	// 右サイドバーにリーフ（パネル）を確保する。存在しない場合は作成する(true)
	//	const rightLeaf = this.app.workspace.getRightLeaf(true);
	//	if (!rightLeaf) {
	//		new Notice("Failed to create a panel for the chat view.");
	//		return;
	//	}
	//
	//	// 新しいチャットビューをセットしてアクティブにする
	//	await rightLeaf.setViewState({
	//		type: CHAT_VIEW_TYPE,
	//		active: true,
	//	});
	//
	//	// 確実にビューが表示されるようにする
	//	this.app.workspace.revealLeaf(rightLeaf);
	//}

	// ★★★ activateViewメソッドを、より競合の少ないシンプルな方式に戻しました ★★★
	async activateView() {
		this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
		const rightLeaf = this.app.workspace.getRightLeaf(true);
		if (rightLeaf) {
			await rightLeaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
			});
			this.app.workspace.revealLeaf(rightLeaf);
		}
	}

	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	constructor(app: App, plugin: MyPlugin) { super(app, plugin); this.plugin = plugin; }
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'PDF Chat Plugin Settings' });

		new Setting(containerEl)
			.setName('Google Gemini API Key')
			.addText(text => text.setPlaceholder('Enter your API key...').setValue(this.plugin.settings.apiKey).onChange(async (value) => {
				this.plugin.settings.apiKey = value;
				await this.plugin.saveSettings();
			}));

		containerEl.createEl('h3', { text: 'Chat Model' });

		new Setting(containerEl)
			.setName("Model")
			.addDropdown(dropdown => {
				if (this.plugin.settings.selectedModel) { dropdown.addOption(this.plugin.settings.selectedModel, this.plugin.settings.selectedModel.replace("models/", "")); }
				dropdown.setValue(this.plugin.settings.selectedModel).onChange(async (value) => {
					this.plugin.settings.selectedModel = value;
					await this.plugin.saveSettings();
				});
			})
			.addButton(button => button.setButtonText("Refresh").onClick(async () => {
				const models = await this.plugin.fetchAvailableModels(this.plugin.settings.apiKey);
				const dropdownEl = button.buttonEl.previousElementSibling as HTMLSelectElement;
				if (models.length > 0 && dropdownEl) {
					new Notice("Chat models loaded!");
					dropdownEl.empty();
					models.forEach(m => dropdownEl.add(new Option(m.replace("models/", ""), m)));
					this.plugin.settings.selectedModel = dropdownEl.value;
					await this.plugin.saveSettings();
				}
			}));

		containerEl.createEl('h3', { text: 'Embedding Model' });
		
		new Setting(containerEl)
			.setName("Model")
			.addDropdown(dropdown => {
				if (this.plugin.settings.selectedEmbeddingModel) { dropdown.addOption(this.plugin.settings.selectedEmbeddingModel, this.plugin.settings.selectedEmbeddingModel.replace("models/", "")); }
				dropdown.setValue(this.plugin.settings.selectedEmbeddingModel).onChange(async (value) => {
					this.plugin.settings.selectedEmbeddingModel = value;
					await this.plugin.saveSettings();
				});
			})
			.addButton(button => button.setButtonText("Refresh").onClick(async () => {
				const models = await this.plugin.fetchAvailableEmbeddingModels(this.plugin.settings.apiKey);
				const dropdownEl = button.buttonEl.previousElementSibling as HTMLSelectElement;
				if (models.length > 0 && dropdownEl) {
					new Notice("Embedding models loaded!");
					dropdownEl.empty();
					models.forEach(m => dropdownEl.add(new Option(m.replace("models/", ""), m)));
					this.plugin.settings.selectedEmbeddingModel = dropdownEl.value;
					await this.plugin.saveSettings();
				}
			}));
	}
}