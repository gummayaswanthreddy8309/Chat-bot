import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Static frontend
app.use(express.static(__dirname));

// Health
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Diagnostics (no secrets exposed)
app.get('/api/diag', (_, res) => {
	res.json({
		ok: true,
		port,
		gemini: {
			hasKey: Boolean(process.env.GEMINI_API_KEY),
			modelPref: process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest'
		},
		alphaVantage: { hasKey: Boolean(process.env.ALPHAVANTAGE_API_KEY) }
	});
});

// Gemini Chat endpoint
app.post('/api/chat', async (req, res) => {
	try {
		const { message, context } = req.body || {};
		if (!process.env.GEMINI_API_KEY) {
			return res.status(500).json({ error: 'Missing GEMINI_API_KEY' });
		}
		if (!message || typeof message !== 'string') {
			return res.status(400).json({ error: 'message is required' });
		}

		const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
		// Try requested model first (via GEMINI_MODEL), then sensible fallbacks across 2.x and 1.x
		const preferred = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
		const fallbacks = [
			preferred,
			'gemini-2.5-flash',
			'gemini-2.0-flash',
			'gemini-2.0-pro',
			'gemini-1.5-flash-latest',
			'gemini-1.5-pro-latest',
			'gemini-pro'
		];

		const systemInstruction = 'You are a helpful finance assistant for general information. Provide clear, concise answers with numbers when possible. Do not provide personalized investment advice; include brief, neutral disclaimers when appropriate.';
		const userPrompt = [
			context ? `Context: ${context}` : '',
			`User: ${message}`
		].filter(Boolean).join('\n');

		// Relax safety thresholds to minimize over-blocking while keeping basic protection
		const safetySettings = [
			{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
			{ category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
			{ category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
			{ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
		];

		const generationConfig = {
			temperature: 0.5,
			topP: 0.9,
			topK: 40,
			maxOutputTokens: 2048
		};

		let lastErr;
		const tried = [];
		for (const modelName of fallbacks) {
			try {
				const model = genAI.getGenerativeModel({ model: modelName, safetySettings, generationConfig });
				const result = await model.generateContent(`${systemInstruction}\n${userPrompt}`);
				const text = result?.response?.text?.() || 'Sorry, I could not generate a response.';
				return res.json({ text, model: modelName });
			} catch (e) {
				lastErr = e;
				tried.push({ model: modelName, detail: String(e?.message || e) });
			}
		}
		const detail = String(lastErr?.message || lastErr || 'unknown');
		if ((lastErr && (lastErr.status === 401 || /401|unauthorized/i.test(detail)))) {
			return res.status(401).json({ error: 'Unauthorized', detail, tried });
		}
		return res.status(502).json({ error: 'chat_failed', detail, tried });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'chat_failed', detail: String(err?.message || err || 'unknown') });
	}
});

// Symbol search endpoint (company name -> ticker)
async function searchYahooSymbol(query) {
	const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`;
	const r = await fetch(url);
	if (!r.ok) throw new Error('search http');
	const data = await r.json();
	const quotes = data?.quotes || [];
	const equity = quotes.find(q => (q.quoteType === 'EQUITY' || q.quoteType === 'ETF') && q.symbol);
	if (!equity) throw new Error('symbol not found');
	return {
		symbol: equity.symbol,
		name: equity.shortname || equity.longname || equity.symbol,
		exchange: equity.exchDisp || equity.exchange || ''
	};
}

app.get('/api/symbol', async (req, res) => {
	try {
		const q = String(req.query.q || '').trim();
		if (!q) return res.status(400).json({ error: 'query required' });
		const result = await searchYahooSymbol(q);
		res.json({ ok: true, result });
	} catch (err) {
		res.status(404).json({ error: 'symbol_not_found', detail: String(err?.message || err) });
	}
});

// Quote proxy endpoint with Yahoo -> Stooq fallback
async function fetchYahoo(ticker) {
	const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker.toUpperCase())}`;
	const r = await fetch(url, {
		headers: {
			// Some environments get partial data unless a UA is present
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
		}
	});
	if (!r.ok) throw new Error('yahoo http');
	const data = await r.json();
	const q = data?.quoteResponse?.result?.[0];
	if (!q) throw new Error('yahoo empty');
	const result = {
		symbol: q.symbol,
		name: q.shortName || q.longName || q.symbol,
		price: q.regularMarketPrice,
		open: q.regularMarketOpen,
		high: q.regularMarketDayHigh,
		low: q.regularMarketDayLow,
		volume: q.regularMarketVolume
	};
	// If Yahoo returns a quote but without usable price fields, trigger fallback
	if (result.price == null || Number.isNaN(Number(result.price))) {
		throw new Error('yahoo missing price');
	}
	return result;
}

// Alpha Vantage quote fetcher (GLOBAL_QUOTE endpoint)
async function fetchAlphaVantage(ticker) {
	const apikey = process.env.ALPHAVANTAGE_API_KEY;
	if (!apikey) throw new Error('av missing key');
	const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apikey)}`;
	const r = await fetch(url);
	if (!r.ok) throw new Error('av http');
	const data = await r.json();
	const q = data?.['Global Quote'] || data?.GlobalQuote || null;
	if (!q || Object.keys(q).length === 0) throw new Error('av empty');
	const price = Number(q['05. price'] ?? q['05.price'] ?? q.price ?? q['price']);
	const open = Number(q['02. open'] ?? q.open);
	const high = Number(q['03. high'] ?? q.high);
	const low = Number(q['04. low'] ?? q.low);
	const volume = Number(q['06. volume'] ?? q.volume);
	if (!price || Number.isNaN(price)) throw new Error('av missing price');
	return {
		symbol: (q['01. symbol'] ?? ticker).toUpperCase(),
		name: (q['01. symbol'] ?? ticker).toUpperCase(),
		price,
		open,
		high,
		low,
		volume
	};
}

async function fetchStooq(ticker) {
	const url = `https://stooq.com/q/l/?s=${encodeURIComponent(ticker.toLowerCase())}&f=sd2t2ohlcv&h&e=json`;
	const r = await fetch(url);
	if (!r.ok) throw new Error('stooq http');
	const data = await r.json();
	const s = data?.symbols?.[0];
	if (!s || s.close === 'N/D') throw new Error('stooq nd');
	return {
		symbol: (s.symbol || ticker).toUpperCase(),
		name: s.name || s.symbol || ticker,
		price: Number(s.close),
		open: Number(s.open),
		high: Number(s.high),
		low: Number(s.low),
		volume: Number(s.volume)
	};
}

app.get('/api/quote', async (req, res) => {
	try {
		const ticker = String(req.query.t || req.query.ticker || '').toUpperCase();
		if (!ticker) return res.status(400).json({ error: 'ticker required' });
		let quote;
		// 1) Alpha Vantage primary (if key present)
		try {
			if (process.env.ALPHAVANTAGE_API_KEY) {
				quote = await fetchAlphaVantage(ticker);
			}
		} catch (_) {}
		// 2) Yahoo fallback (throws if missing price; see fetchYahoo)
		if (!quote) {
			try { quote = await fetchYahoo(ticker); } catch (_) {}
		}
		// 3) Stooq final fallback
		if (!quote) {
			quote = await fetchStooq(ticker);
		}
		res.json({ ok: true, quote });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'quote_failed' });
	}
});

// Daily history endpoint (Yahoo chart API)
app.get('/api/history', async (req, res) => {
    try {
        const raw = String(req.query.t || '').toUpperCase();
        const range = String(req.query.range || '5d');
        if (!raw) return res.status(400).json({ error: 'ticker required' });

        const candidates = [raw];
        const hasSuffix = /\.[A-Z]{1,4}$/.test(raw);
        if (!hasSuffix) {
            // Try common India exchange suffixes if none provided
            candidates.push(`${raw}.NS`, `${raw}.BO`);
        }

        let candles = null;
        let lastErr;
        for (const t of candidates) {
            try {
                const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=${encodeURIComponent(range)}&interval=1d`;
                const r = await fetch(url);
                if (!r.ok) throw new Error('chart http');
                const data = await r.json();
                const result = data?.chart?.result?.[0];
                const timestamps = result?.timestamp || [];
                const ohlc = result?.indicators?.quote?.[0] || {};
                if (!timestamps.length) throw new Error('chart empty');
                candles = timestamps.map((ts, i) => ({
                    date: new Date(ts * 1000).toISOString().substring(0, 10),
                    open: ohlc.open?.[i] ?? null,
                    high: ohlc.high?.[i] ?? null,
                    low: ohlc.low?.[i] ?? null,
                    close: ohlc.close?.[i] ?? null,
                    volume: ohlc.volume?.[i] ?? null
                }));
                break;
            } catch (e) {
                lastErr = e;
            }
        }

        if (!candles) throw lastErr || new Error('history unavailable');
        res.json({ ok: true, candles });
    } catch (err) {
        res.status(500).json({ error: 'history_failed', detail: String(err?.message || err) });
    }
});

app.listen(port, () => {
	console.log(`Server running on http://localhost:${port}`);
});
