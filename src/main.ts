import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, FileView, requestUrl, Notice } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';

// 設定項目のインターフェース
interface MyPluginSettings {
	apiKey: string;
	selectedModel: string;
}

// デフォルト設定
const DEFAULT_SETTINGS: MyPluginSettings = {
	apiKey: '',
	selectedModel: 'models/gemini-1.5-flash-latest'
}

// メインのプラグインクラス
export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	currentPdfText = "";

	async onload() {
		await this.loadSettings();

		const workerPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/pdf.worker.mjs`;
		pdfjsLib.GlobalWorkerOptions.workerSrc = this.app.vault.adapter.getResourcePath(workerPath);

		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new ChatView(leaf, this)
		);

		this.addRibbonIcon("messages-square", "Open PDF Chat", () => {
			this.activateView();
		});

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', async (leaf) => {
				if (!leaf) return;
				if (leaf.view.getViewType() === 'pdf') {
					const file = (leaf.view as FileView).file;
					if (file) {
						this.currentPdfText = await this.parsePdf(await this.app.vault.readBinary(file));
						console.log("PDFテキストを抽出しました。");
					}
				}
			})
		);

		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
	}

	async fetchAvailableModels(key: string): Promise<string[]> {
		if (!key) return [];
		try {
			const url = `https://generativelanguage.googleapis.com/v1beta/models`;
			const response = await requestUrl({
				url,
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					'x-goog-api-key': key
				}
			});

			return response.json.models
				.filter((model: any) => model.supportedGenerationMethods.includes("generateContent"))
				.map((model: any) => model.name);
		} catch (error) {
			console.error("Failed to fetch available models:", error);
			new Notice("Failed to fetch models. Check the console for details.");
			return [];
		}
	}

	async parsePdf(data: ArrayBuffer): Promise<string> {
		try {
			const pdf = await pdfjsLib.getDocument(data).promise;
			const numPages = pdf.numPages;
			let fullText = "";
	
			for (let i = 1; i <= numPages; i++) {
				const page = await pdf.getPage(i);
				const textContent = await page.getTextContent();
				const pageText = textContent.items.map(item => ('str' in item ? item.str : '')).join(' ');
				fullText += pageText + "\n\n";
			}
			return fullText;
		} catch (error) {
			console.error("PDFの解析中にエラーが発生しました:", error);
			return "";
		}
	}

	async activateView() {
		this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
		const rightLeaf = this.app.workspace.getRightLeaf(false);
		if (rightLeaf) {
			await rightLeaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
			});
			this.app.workspace.revealLeaf(rightLeaf);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// 設定タブのクラス
class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'PDF Chat Plugin Settings' });

		new Setting(containerEl)
			.setName('Google Gemini API Key')
			.setDesc('Your Google Gemini API key.')
			.addText(text => text
				.setPlaceholder('Enter your API key...')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Model Selection")
			.setDesc("Click 'Refresh List' after entering your API key. Then choose a model.")
			.addDropdown(dropdown => {
				if (this.plugin.settings.selectedModel) {
					dropdown.addOption(this.plugin.settings.selectedModel, this.plugin.settings.selectedModel);
				}
				dropdown.setValue(this.plugin.settings.selectedModel)
				.onChange(async (value) => {
					this.plugin.settings.selectedModel = value;
					await this.plugin.saveSettings();
					new Notice(`Model set to: ${value}`);
				});
			})
			.addButton(button => button
				.setButtonText("Refresh Model List")
				.onClick(async () => {
					const apiKey = this.plugin.settings.apiKey;
					if (!apiKey) {
						new Notice("Please enter an API key first.");
						return;
					}
					
					new Notice("Fetching available models...");
					const models = await this.plugin.fetchAvailableModels(apiKey);
					
					if (models.length > 0) {
						new Notice("Successfully fetched models!");
						const dropdownEl = this.containerEl.querySelector('select');
						if(dropdownEl) {
							dropdownEl.empty();
							models.forEach(modelName => {
								dropdownEl.add(new Option(modelName.replace("models/", ""), modelName));
							});
							this.plugin.settings.selectedModel = dropdownEl.value;
							this.plugin.saveSettings();
						}
					}
				}));
	}
}