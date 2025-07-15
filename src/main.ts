import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, FileView, requestUrl, Notice, TFile, normalizePath } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
import { ChatView, CHAT_VIEW_TYPE, ProcessingState } from './chat-view';

interface MyPluginSettings {
	apiKey: string;
	selectedModel: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	apiKey: '',
	selectedModel: 'models/gemini-1.5-pro-latest',
}



export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	currentPdfText: string = "";
	public onStateChange: ((state: ProcessingState) => void) | null = null;
	private isProcessing: boolean = false;

	async onload() {
		await this.loadSettings();

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
				await this.preparePdf(file);
			}
			return;
		}
		if (viewType === CHAT_VIEW_TYPE) { return; }
		if (this.currentPdfText !== "") {
			this.currentPdfText = "";
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
				const textContent = await page.getTextContent();
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

	
	
	async preparePdf(file: TFile) {
		if (this.isProcessing) { return; }
		this.isProcessing = true;
		
		if (!this.settings.apiKey) {
			new Notice("API Key is not set.");
			this.isProcessing = false;
			return;
		}

		this.onStateChange?.({ status: 'reading' });
		try {
			this.currentPdfText = await this.parsePdf(await this.app.vault.readBinary(file));
		} catch (error) {
			new Notice("Failed to prepare PDF. Check API key or developer console.", 7000);
			this.onStateChange?.({ status: 'error' });
		} finally {
			this.onStateChange?.({ status: 'complete' });
			this.isProcessing = false;
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
	}
}