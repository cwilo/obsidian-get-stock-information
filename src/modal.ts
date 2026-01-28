import { App, Modal, Setting } from "obsidian";

export class InsertLinkModal extends Modal {
	ticker: string;

	onSubmit: (ticker: string) => void;

	constructor(
		app: App,
		defaultTicker: string,
		onSubmit: (ticker: string) => void
	) {
		super(app);
		this.ticker = defaultTicker;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h1", { text: "Insert stock information" });

		new Setting(contentEl).setName("Stock ticker").addText((text) =>
			text.setValue(this.ticker).onChange((value) => {
				this.ticker = value;
			})
		);

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Get stock information")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.ticker);
				})
		);
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}
}

export const STOCK_FIELDS: Record<string, string> = {
	bid: "Bid Price",
	ask: "Ask Price",
	previousClose: "Previous Close",
	marketCap: "Market Cap",
	volume: "Volume",
	fiftytwo_high: "52 Week High",
	fiftytwo_low: "52 Week Low",
	dayRange_high: "Day High",
	dayRange_low: "Day Low",
	name: "Company Name",
	currency: "Currency",
};

export class SingleValueModal extends Modal {
	ticker: string;
	field: string;

	onSubmit: (ticker: string, field: string) => void;

	constructor(
		app: App,
		defaultTicker: string,
		onSubmit: (ticker: string, field: string) => void
	) {
		super(app);
		this.ticker = defaultTicker;
		this.field = "previousClose";
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h1", { text: "Get single stock value" });

		new Setting(contentEl).setName("Stock ticker").addText((text) =>
			text.setValue(this.ticker).onChange((value) => {
				this.ticker = value;
			})
		);

		new Setting(contentEl)
			.setName("Field")
			.setDesc("Select the value to retrieve")
			.addDropdown((dropdown) => {
				for (const [key, label] of Object.entries(STOCK_FIELDS)) {
					dropdown.addOption(key, label);
				}
				dropdown.setValue(this.field);
				dropdown.onChange((value) => {
					this.field = value;
				});
			});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Get value")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.ticker, this.field);
				})
		);
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}
}
