import { Editor, Plugin, Notice, requestUrl, MarkdownView } from "obsidian";
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

const YAHOO_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "application/json,text/plain,*/*",
	Referer: "https://finance.yahoo.com/",
};

const parseStooqCsvLine = (line: string) =>
	line
		.split(",")
		.map((cell) => cell.trim())
		.map((cell) => (cell === "N/A" ? "" : cell));

async function fetchStooqQuote(symbol: string): Promise<Quote | null> {
	const normalized = normalizeSymbol(symbol);
	const candidates = [
		normalized.toLowerCase(),
		`${normalized.toLowerCase()}.us`,
	];

	for (const candidate of candidates) {
		try {
			const url = `https://stooq.com/q/l/?s=${encodeURIComponent(
				candidate
			)}&f=sd2t2ohlcv&h&e=csv`;
			const response = await requestUrl({ url });
			const text = response.text;
			const lines = text.trim().split(/\r?\n/);
			if (lines.length < 2) continue;

			const header = parseStooqCsvLine(lines[0]);
			const values = parseStooqCsvLine(lines[1]);
			const record: Record<string, string> = {};
			header.forEach((key, index) => {
				record[key] = values[index] ?? "";
			});

			if (!record.symbol || !record.close) continue;

			const close = parseNumber(record.close);
			const low = parseNumber(record.low);
			const high = parseNumber(record.high);
			const volume = parseNumber(record.volume);
			const datePart = record.date;
			const timePart = record.time;
			let updated: number | undefined;
			if (datePart) {
				const iso = timePart
					? `${datePart}T${timePart}Z`
					: `${datePart}T00:00:00Z`;
				const parsed = Date.parse(iso);
				if (!Number.isNaN(parsed)) updated = Math.floor(parsed / 1000);
			}

			return {
				symbol: normalized,
				regularMarketPrice: close ?? undefined,
				regularMarketDayLow: low ?? undefined,
				regularMarketDayHigh: high ?? undefined,
				regularMarketVolume: volume ?? undefined,
				regularMarketTime: updated,
			};
		} catch {
			// Try the next candidate.
		}
	}

	return null;
}

async function fetchQuotesFromStooq(
	symbols: string[]
): Promise<Map<string, Quote>> {
	const quoteMap = new Map<string, Quote>();
	for (const symbol of symbols) {
		const quote = await fetchStooqQuote(symbol);
		if (quote) quoteMap.set(normalizeSymbol(symbol), quote);
	}
	return quoteMap;
}

async function fetchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
	const cleanedSymbols = symbols.map(normalizeSymbol).filter(Boolean);
	if (!cleanedSymbols.length) return new Map();

	const query = encodeURIComponent(cleanedSymbols.join(","));
	const urls = [
		`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${query}`,
		`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${query}`,
	];

	let lastError: unknown = null;
	for (const url of urls) {
		try {
			const response = await requestUrl({
				url,
				headers: YAHOO_HEADERS,
			});
			const data = response.json as {
				quoteResponse?: { result?: Quote[] };
			};

			if (!data?.quoteResponse?.result) {
				throw new Error("Unexpected response from Yahoo Finance");
			}

			const quoteMap = new Map<string, Quote>();
			for (const quote of data.quoteResponse.result) {
				if (quote?.symbol) quoteMap.set(quote.symbol.toUpperCase(), quote);
			}

			return quoteMap;
		} catch (e) {
			lastError = e;
		}
	}

	const stooqQuotes = await fetchQuotesFromStooq(cleanedSymbols);
	if (stooqQuotes.size > 0) return stooqQuotes;

	if (lastError instanceof Error) throw lastError;
	throw new Error("Failed to fetch quotes");
}
export default class StockInfoPlugin extends Plugin {
	async onload() {
		console.log("reloaded");

		// Add command to Obsidian quick tasks

		const updatePortfolioTable = async (editor: Editor | null) => {
			if (!editor) {
				new Notice("No active markdown editor", 5000);
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
				quotes = await fetchQuotes(symbols);
			} catch (e) {
				console.error("Error occurred:", e);
				new Notice(
					"Error: couldn't retrieve stock information",
					15000
				);
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
						const quotes = await fetchQuotes([ticker]);
						const quote = quotes.get(normalizeSymbol(ticker));
						if (!quote) {
							logError("Symbol not found");
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
						const quotes = await fetchQuotes([ticker]);
						const quote = quotes.get(normalizeSymbol(ticker));
						if (!quote) {
							logError("Symbol not found");
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
}
