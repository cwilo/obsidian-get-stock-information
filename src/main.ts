import {
	App,
	Editor,
	Plugin,
	Notice,
	requestUrl,
	MarkdownView,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { InsertLinkModal, SingleValueModal } from "./modal";

type Quote = {
	symbol: string;
	shortName?: string;
	longName?: string;
	currency?: string;
	bid?: number;
	ask?: number;
	regularMarketPrice?: number;
	regularMarketPreviousClose?: number;
	regularMarketDayLow?: number;
	regularMarketDayHigh?: number;
	fiftyTwoWeekLow?: number;
	fiftyTwoWeekHigh?: number;
	marketCap?: number;
	regularMarketVolume?: number;
	regularMarketTime?: number;
};

const normalizeSymbol = (symbol: string) => symbol.trim().toUpperCase();

const parseNumber = (value: string | null | undefined) => {
	if (!value) return null;
	const cleaned = value.replace(/[$,%\s]/g, "").replace(/,/g, "");
	const parsed = Number.parseFloat(cleaned);
	return Number.isFinite(parsed) ? parsed : null;
};

const formatNumber = (value: number, fractionDigits = 2) =>
	new Intl.NumberFormat("en-US", {
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
	}).format(value);

const formatLongNumber = (n: number) => {
	if (n < 1e9) return +(n / 1e6).toFixed(3) + "M";
	if (n >= 1e9 && n < 1e12) return +(n / 1e9).toFixed(3) + "B";
	if (n >= 1e12) return +(n / 1e12).toFixed(1) + "T";
};

type FinnhubQuoteResponse = {
	c: number; // current price
	h: number; // high price of the day
	l: number; // low price of the day
	o: number; // open price of the day
	pc: number; // previous close price
	t: number; // timestamp
};

type StockInfoSettings = {
	finnhubApiKey: string;
};

const DEFAULT_SETTINGS: StockInfoSettings = {
	finnhubApiKey: "",
};

async function fetchFinnhubQuote(
	symbol: string,
	apiKey: string
): Promise<Quote | null> {
	const normalized = normalizeSymbol(symbol);
	const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
		normalized
	)}&token=${encodeURIComponent(apiKey)}`;
	const response = await requestUrl({ url, throw: false });
	if (response.status !== 200) {
		return null;
	}
	const data = response.json as FinnhubQuoteResponse;
	if (!data || typeof data.c !== "number") {
		return null;
	}
	return {
		symbol: normalized,
		regularMarketPrice: data.c,
		regularMarketDayLow: data.l,
		regularMarketDayHigh: data.h,
		regularMarketPreviousClose: data.pc,
		regularMarketTime: data.t,
	};
}

async function fetchQuotes(
	symbols: string[],
	apiKey: string
): Promise<Map<string, Quote>> {
	const cleanedSymbols = symbols.map(normalizeSymbol).filter(Boolean);
	if (!cleanedSymbols.length) return new Map();

	const quoteMap = new Map<string, Quote>();
	for (const symbol of cleanedSymbols) {
		const quote = await fetchFinnhubQuote(symbol, apiKey);
		if (quote) quoteMap.set(symbol, quote);
	}
	return quoteMap;
}
class StockInfoSettingTab extends PluginSettingTab {
	plugin: StockInfoPlugin;

	constructor(app: App, plugin: StockInfoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Finnhub API key")
			.setDesc("Used to fetch quotes from Finnhub.")
			.addText((text) =>
				text
					.setPlaceholder("Enter your Finnhub API key")
					.setValue(this.plugin.settings.finnhubApiKey)
					.onChange(async (value) => {
						this.plugin.settings.finnhubApiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}

export default class StockInfoPlugin extends Plugin {
	settings: StockInfoSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new StockInfoSettingTab(this.app, this));

		console.log("reloaded");

		// Add command to Obsidian quick tasks

		const updatePortfolioTable = async (editor: Editor | null) => {
			if (!editor) {
				new Notice("No active markdown editor", 5000);
				return;
			}
			if (!this.settings.finnhubApiKey) {
				new Notice("Set your Finnhub API key in plugin settings", 7000);
				return;
			}

			const selection = editor.getSelection();
			const targetText = selection || editor.getValue();
			const lines = targetText.split("\n");

			const isTableSeparator = (line: string) =>
				/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
					line
				);
			const isTableRow = (line: string) =>
				line.includes("|") && !/^\s*$/.test(line);
			const splitRow = (line: string) => {
				let trimmed = line.trim();
				if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
				if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
				return trimmed.split("|").map((cell) => cell.trim());
			};

			let tableStart = -1;
			let tableEnd = -1;
			let header: string[] = [];

			for (let i = 0; i < lines.length - 1; i++) {
				if (isTableRow(lines[i]) && isTableSeparator(lines[i + 1])) {
					tableStart = i;
					header = splitRow(lines[i]);
					let j = i + 2;
					while (j < lines.length && isTableRow(lines[j])) j++;
					tableEnd = j - 1;
					break;
				}
			}

			if (tableStart === -1 || tableEnd === -1) {
				new Notice("No markdown table found", 5000);
				return;
			}

			const headerIndex = (names: string[]) =>
				header.findIndex((h) =>
					names.includes(h.trim().toLowerCase())
				);

			const tickerIndex = headerIndex([
				"fund",
				"ticker",
				"symbol",
				"fund/ticker",
			]);
			const sharesIndex = headerIndex([
				"shares",
				"qty",
				"quantity",
				"units",
			]);
			const priceIndex = headerIndex([
				"current price",
				"price",
				"last price",
			]);
			const valueIndex = headerIndex(["value", "market value"]);
			const allocationIndex = headerIndex([
				"allocation",
				"allocation %",
				"alloc %",
			]);

			if (tickerIndex === -1 || sharesIndex === -1) {
				new Notice(
					"Table must include a Ticker/Fund column and a Shares column",
					7000
				);
				return;
			}

			const dataRows = lines
				.slice(tableStart + 2, tableEnd + 1)
				.map(splitRow);
			const symbols = dataRows
				.map((row) => row[tickerIndex])
				.filter(Boolean)
				.map(normalizeSymbol);

			if (!symbols.length) {
				new Notice("No tickers found in the table", 5000);
				return;
			}

				let quotes: Map<string, Quote>;
				try {
					quotes = await fetchQuotes(
						symbols,
						this.settings.finnhubApiKey
					);
				} catch (e) {
					console.error("Error occurred:", e);
					new Notice(
						"Error: couldn't retrieve stock information",
						15000
					);
					return;
				}
				if (quotes.size === 0) {
					new Notice("No quotes returned for table", 7000);
					return;
				}

			const rowValues: number[] = [];
			const updatedRows = dataRows.map((row, rowIndex) => {
				while (row.length < header.length) row.push("");
				const symbol = normalizeSymbol(row[tickerIndex] || "");
				const quote = quotes.get(symbol);
				if (!quote) return row;

				const price =
					quote.regularMarketPrice ??
					quote.ask ??
					quote.bid ??
					quote.regularMarketPreviousClose ??
					null;
				const shares = parseNumber(row[sharesIndex]);
				const value =
					price !== null && shares !== null ? price * shares : null;

				if (priceIndex !== -1 && price !== null) {
					row[priceIndex] = formatNumber(price, 2);
				}
				if (valueIndex !== -1 && value !== null) {
					row[valueIndex] = formatNumber(value, 2);
				}
				rowValues[rowIndex] = value ?? 0;
				return row;
			});

			const totalValue = rowValues.reduce((sum, v) => sum + v, 0);
			if (allocationIndex !== -1 && totalValue > 0) {
				updatedRows.forEach((row, rowIndex) => {
					const value = rowValues[rowIndex] ?? 0;
					const allocation = (value / totalValue) * 100;
					row[allocationIndex] = formatNumber(allocation, 2);
				});
			}

			const updatedTableLines = [
				`| ${header.join(" | ")} |`,
				lines[tableStart + 1],
				...updatedRows.map((row) => `| ${row.join(" | ")} |`),
			];

			const before = lines.slice(0, tableStart);
			const after = lines.slice(tableEnd + 1);
			const updatedText = [...before, ...updatedTableLines, ...after].join(
				"\n"
			);

			if (selection) {
				editor.replaceSelection(updatedText);
			} else {
				editor.setValue(updatedText);
			}

			const missingColumns: string[] = [];
			if (priceIndex === -1) missingColumns.push("Current Price");
			if (allocationIndex === -1) missingColumns.push("Allocation");
			if (missingColumns.length) {
				new Notice(
					`Updated table. Add column(s): ${missingColumns.join(
						", "
					)} to populate them.`,
					8000
				);
			} else {
				new Notice("Updated portfolio table", 3000);
			}
		};

		this.addCommand({
			id: "insert-stock-info",
			name: "Insert stock info",
			editorCallback: (editor: Editor) => {
				// get selected text
				const selectedText = editor.getSelection();

				// onSubmit of the form
				const onSubmit = async (ticker: string) => {
					// helper function: log error
					const logError = (msg: string) => {
						console.error("Error occurred:", msg);
						new Notice(
							"Error: couldn't retrieve stock information",
							15000
						);
					};

					try {
						if (!this.settings.finnhubApiKey) {
							new Notice(
								"Set your Finnhub API key in plugin settings",
								7000
							);
							return;
						}
						const quotes = await fetchQuotes(
							[ticker],
							this.settings.finnhubApiKey
						);
						const quote = quotes.get(normalizeSymbol(ticker));
						if (!quote) {
							logError("No data returned for symbol");
							return;
						}

						const bid = quote.bid ?? null;
						const ask = quote.ask ?? null;
						const previousClose = quote.regularMarketPreviousClose ?? null;
						const price =
							quote.regularMarketPrice ??
							quote.ask ??
							quote.bid ??
							quote.regularMarketPreviousClose ??
							null;
						const name = quote.longName ?? quote.shortName ?? null;
						const currency = quote.currency ?? null;
						const volume = quote.regularMarketVolume ?? null;
						const marketCap = quote.marketCap ?? null;
						const dayRangeLow = quote.regularMarketDayLow ?? null;
						const dayRangeHigh = quote.regularMarketDayHigh ?? null;
						const fiftyTwoLow = quote.fiftyTwoWeekLow ?? null;
						const fiftyTwoHigh = quote.fiftyTwoWeekHigh ?? null;
						const updated = quote.regularMarketTime
							? new Date(quote.regularMarketTime * 1000)
							: null;

						let output = "> [!info]- " + normalizeSymbol(ticker) + " ";
						if (bid && ask) {
							output +=
								"(Bid: " +
								bid +
								", Ask: " +
								ask +
								", Spread: " +
								(((ask - bid) / ask) * 100).toFixed(3) +
								"%)";
						} else if (previousClose) {
							output += "(Previous close: " + previousClose + ")";
						} else if (price) {
							output += "(Price: " + price + ")";
						}

						if (name) output += "\n> **Name:** " + name;
						if (currency) output += "\n> **Currency:** " + currency;
						if (volume)
							output +=
								"\n> **Volume:** " +
								volume.toLocaleString("en-US");
						if (currency && marketCap)
							output +=
								"\n> **Market cap:** " +
								formatLongNumber(marketCap);
						if (previousClose)
							output +=
								"\n> **Previous close:** " + previousClose;
						if (dayRangeLow && dayRangeHigh)
							output +=
								"\n> **Day range:** " +
								dayRangeLow +
								" – " +
								dayRangeHigh;
						if (fiftyTwoLow && fiftyTwoHigh)
							output +=
								"\n> **52W range:** " +
								fiftyTwoLow +
								" – " +
								fiftyTwoHigh;
						if (updated)
							output += "\n>\n><small>*" + updated + "*</small>";

						editor.replaceSelection(`${output}` + "\n\n");
					} catch (e) {
						logError(e instanceof Error ? e.message : String(e));
					}
				};

				new InsertLinkModal(this.app, selectedText, onSubmit).open();
			},
		});

		// Add command to get a single stock value
		this.addCommand({
			id: "get-single-stock-value",
			name: "Get single stock value",
			editorCallback: (editor: Editor) => {
				const selectedText = editor.getSelection();

				const onSubmit = async (ticker: string, field: string) => {
					// helper function: log error
					const logError = (msg: string) => {
						console.error("Error occurred:", msg);
						new Notice(
							"Error: couldn't retrieve stock information",
							15000
						);
					};

					try {
						if (!this.settings.finnhubApiKey) {
							new Notice(
								"Set your Finnhub API key in plugin settings",
								7000
							);
							return;
						}
						const quotes = await fetchQuotes(
							[ticker],
							this.settings.finnhubApiKey
						);
						const quote = quotes.get(normalizeSymbol(ticker));
						if (!quote) {
							logError("No data returned for symbol");
							return;
						}

						const stockData: { [key: string]: number | string | null } = {
							name: quote.longName ?? quote.shortName ?? null,
							currency: quote.currency ?? null,
							bid: quote.bid ?? null,
							ask: quote.ask ?? null,
							marketCap: quote.marketCap ?? null,
							previousClose: quote.regularMarketPreviousClose ?? null,
							volume: quote.regularMarketVolume ?? null,
							fiftytwo_high: quote.fiftyTwoWeekHigh ?? null,
							fiftytwo_low: quote.fiftyTwoWeekLow ?? null,
							dayRange_high: quote.regularMarketDayHigh ?? null,
							dayRange_low: quote.regularMarketDayLow ?? null,
						};

						const value = stockData[field];
						if (value !== null && value !== undefined) {
							let output: string;
							if (field === "marketCap" && typeof value === "number") {
								output = formatLongNumber(value) ?? String(value);
							} else if (field === "volume" && typeof value === "number") {
								output = value.toLocaleString("en-US");
							} else {
								output = String(value);
							}
							editor.replaceSelection(output);
						} else {
							new Notice(`No data available for ${field}`, 5000);
						}
					} catch (e) {
						logError(e instanceof Error ? e.message : String(e));
					}
				};

				new SingleValueModal(this.app, selectedText, onSubmit).open();
			},
		});

		this.addCommand({
			id: "update-portfolio-table",
			name: "Update portfolio table",
			editorCallback: async (editor: Editor) => {
				await updatePortfolioTable(editor);
			},
		});

		this.addRibbonIcon("refresh-cw", "Update portfolio table", async () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			await updatePortfolioTable(view?.editor ?? null);
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
