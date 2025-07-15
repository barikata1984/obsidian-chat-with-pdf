import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, FileView, requestUrl, Notice, TFile, normalizePath } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
import { ChatView, CHAT_VIEW_TYPE, ProcessingState } from './chat-view';

interface MyPluginSettings {
	apiKey: string;
	selectedModel: string;
	selectedEmbeddingModel: string;
	lastProcessedFile?: string | null;
	concurrency: number;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	apiKey: '',
	selectedModel: 'models/gemini-1.5-pro-latest',
	selectedEmbeddingModel: 'models/text-embedding-004',
	lastProcessedFile: null,
	concurrency: 10,
}

export interface PdfChunk {
	text: string;
	page: number;
	embedding: number[];
}

interface PdfCache {
	chunks: PdfChunk[];
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	currentPdfText: string = "";
	currentPdfChunks: PdfChunk[] = [];
	public onStateChange: ((state: ProcessingState) => void) | null = null;
	private cacheDir: string;
	private isProcessing: boolean = false;

	// ★★★ 修正点: onloadメソッドの中でキャッシュディレクトリを初期化する ★★★
	async onload() {
		await this.loadSettings();

		this.cacheDir = normalizePath(`${this.manifest.dir}/cache`);
		if (!await this.app.vault.adapter.exists(this.cacheDir)) {
			await this.app.vault.adapter.mkdir(this.cacheDir);
		}

		const workerPath = `${this.manifest.dir}/pdf.worker.mjs`;
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
			const file = (leaf.view as FileView).file;
			if (file) {
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
			this.onStateChange?.({ status: 'idle' });
		}
	}

	async parsePdf(data: ArrayBuffer): Promise<string> {
		try {
			const pdf = await pdfjsLib.getDocument(data).promise;
			let fullText = "";
			for (let i = 1; i <= pdf.numPages; i++) {
				const page = await pdf.getPage(i);
				const textContent = await page.getTextContent({ disableCombineTextItems: true });
				const items = textContent.items.filter(item => 'str' in item).slice();
				let lastY: number | undefined;
				let pageText = "";
				for (const item of items) {
					const anyItem = item as any;
					const currentY = anyItem.transform[5];
					if (lastY !== undefined && pageText.length > 0) {
						if (Math.abs(currentY - lastY) > (anyItem.height * 1.2)) {
							pageText += '\n\n';
						} else if (anyItem.str.trim().length > 0) {
							pageText += ' ';
						}
					}
					pageText += anyItem.str;
					lastY = currentY;
				}
				fullText += `[Page ${i}]\n${pageText.trim()}\n\n`;
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
            const pageMatch = pageHeader.match(/\[Page (\d+)\]/)
            const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : 0;
            const paragraphs = pageText.split(/\n\s*\n/).filter(p => p.trim().length > 100);
            for (const para of paragraphs) {
                chunks.push({ text: para.trim(), page: pageNum });
            }
        }
        return chunks;
    }
	
	async preparePdf(file: TFile) {
		if (this.isProcessing) { return; }
		this.isProcessing = true;
		
		if (!this.settings.apiKey) {
			new Notice("API Key is not set.");
			this.isProcessing = false;
			return;
		}
		this.settings.lastProcessedFile = file.path;
		await this.saveSettings();
        
		this.onStateChange?.({ status: 'searching_cache' });
		await new Promise(resolve => setTimeout(resolve, 1000));

		const cacheFileName = `${file.path.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
		const cachePath = normalizePath(`${this.cacheDir}/${cacheFileName}`);

		if(await this.app.vault.adapter.exists(cachePath)) {
			this.onStateChange?.({ status: 'loading_cache' });
			try {
				const cacheData = await this.app.vault.adapter.read(cachePath);
				const cache: PdfCache = JSON.parse(cacheData);
				this.currentPdfChunks = cache.chunks;
				this.currentPdfText = this.currentPdfChunks.map(chunk => `[Page ${chunk.page}]\n${chunk.text}`).join('\n\n');
				new Notice(`Embeddings for ${file.basename} loaded from cache.`);
				this.onStateChange?.({ status: 'complete' });
				this.isProcessing = false;
				return;
			} catch (error) {
				console.error("Failed to load cache, reprocessing PDF...", error);
				new Notice("Cache is corrupted, reprocessing PDF...");
			}
		}

		this.onStateChange?.({ status: 'reading' });
		try {
			this.currentPdfText = await this.parsePdf(await this.app.vault.readBinary(file));
			this.currentPdfChunks = [];
			
			this.onStateChange?.({ status: 'chunking' });
			const chunksToEmbed = this.splitIntoChunks(this.currentPdfText);

			if (chunksToEmbed.length === 0) {
				new Notice("No text content found in the PDF to analyze.");
				this.onStateChange?.({ status: 'complete' });
				this.isProcessing = false;
				return;
			}
            new Notice(`Generating embeddings for ${chunksToEmbed.length} text chunks...`);

			const batchSize = this.settings.concurrency;
			let processedCount = 0;

			for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
				const batch = chunksToEmbed.slice(i, i + batchSize);
				
				this.onStateChange?.({ status: 'embedding', progress: processedCount, total: chunksToEmbed.length });
				const promises = batch.map(chunk => this.getEmbedding(chunk.text));
				const embeddings = await Promise.all(promises);

				batch.forEach((chunk, index) => {
					const embedding = embeddings[index];
					if (embedding) { this.currentPdfChunks.push({ ...chunk, embedding }); }
				});
				processedCount += batch.length;
			}
			this.onStateChange?.({ status: 'embedding', progress: chunksToEmbed.length, total: chunksToEmbed.length });

			if (this.currentPdfChunks.length > 0) { 
				new Notice(`Ready to chat about ${file.basename}.`);
				const chunksToCache = this.currentPdfChunks.map(chunk => ({
					...chunk,
					embedding: chunk.embedding.map(value => parseFloat(value.toFixed(4)))
				}));
				const cacheToSave: PdfCache = { chunks: chunksToCache };
				await this.app.vault.adapter.write(cachePath, JSON.stringify(cacheToSave, null, 2));
				new Notice(`Embeddings for ${file.basename} saved to cache.`);
			}
		} catch (error) {
			new Notice("Failed to prepare PDF. Check API key or developer console.", 7000);
			this.onStateChange?.({ status: 'error' });
		} finally {
            this.onStateChange?.({ status: 'complete' });
			this.isProcessing = false;
        }
	}

	async getEmbedding(text: string): Promise<number[] | null> {
		const model = this.settings.selectedEmbeddingModel;
        if (!model) { throw new Error("Embedding model not selected."); }
		const url = `https://generativelanguage.googleapis.com/v1beta/${model}:embedContent`;
		try {
			const response = await requestUrl({
				url: url, method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.settings.apiKey },
				body: JSON.stringify({ content: { parts: [{ text: text }] } })
			});
			return response.json?.embedding?.values || null;
		} catch (error) {
			console.error("Embedding API call failed:", error);
			new Notice("An embedding request failed. See console for details.");
			return null;
		}
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

	async activateView() {
		this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
		const rightLeaf = this.app.workspace.getRightLeaf(true);
		if (rightLeaf) {
			await rightLeaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
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
		
		containerEl.createEl('h3', { text: 'Advanced Settings' });
		new Setting(containerEl)
			.setName('Parallel Embedding Requests')
			.setDesc('Number of embedding requests to send at once. Higher values may be faster but can hit API rate limits.')
			.addText(text => text
				.setValue(String(this.plugin.settings.concurrency))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0 && num <= 50) {
						this.plugin.settings.concurrency = num;
						await this.plugin.saveSettings();
					}
				}));
	}
}