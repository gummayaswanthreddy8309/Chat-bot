(() => {
	const chatSection = document.getElementById('chat');
	const form = document.getElementById('chat-form');
	const input = document.getElementById('user-input');

	function appendMessage(role, text) {
		const wrapper = document.createElement('div');
		wrapper.className = `message ${role}`;

		const avatar = document.createElement('div');
		avatar.className = 'avatar';
		avatar.textContent = role === 'bot' ? '📈' : '🧑';

		const bubble = document.createElement('div');
		bubble.className = 'bubble';
		bubble.textContent = text;

		wrapper.appendChild(avatar);
		wrapper.appendChild(bubble);
		chatSection.appendChild(wrapper);
		chatSection.scrollTop = chatSection.scrollHeight;
	}

	function normalize(text) {
		return text.trim().toLowerCase();
	}

	const tickerBlacklist = new Set([
		'PRICE','QUOTE','TODAY','NOW','HELP','OPEN','CLOSE','HIGH','LOW','BEST','IS','ARE','THE','FOR','OF','AND','WITH','ON','IN','AT','TO','FROM','STOCK','STOCKS','MARKET','STATUS','HOURS'
	]);

	function sanitizeTicker(t) {
		if (!t) return null;
		const up = t.toUpperCase();
		if (tickerBlacklist.has(up)) return null;
		return up;
	}

	function extractTickerFromDollarPrefixed(text) {
		const match = text.match(/\$([A-Za-z][A-Za-z0-9.-]{0,9})\b/);
		return sanitizeTicker(match ? match[1] : null);
	}

	function extractTickerAfterKeyword(text) {
		const m = text.match(/(?:price|quote|for|of)\s+([A-Za-z][A-Za-z0-9.-]{0,9})\b/i);
		return sanitizeTicker(m ? m[1] : null);
	}

	function maybeCompanyName(text) {
		// If there is a potential ticker-like token (allow . and -), don't treat as name
		const tokens = (text.toUpperCase().match(/[A-Z][A-Z0-9.-]{0,9}/g) || []).map(sanitizeTicker).filter(Boolean);
		const hasTickerToken = tokens.length > 0;
		const hasDollar = /\$[A-Za-z][A-Za-z0-9.-]{0,9}\b/.test(text);
		if (hasTickerToken || hasDollar) return null;
		const m = text.match(/(?:price|quote|for|of)\s+(.+)/i);
		return m ? m[1].trim() : null;
	}

	function detectIntent(text) {
		const t = normalize(text);
		if (!t) return { name: 'fallback' };

		// Date/time
		if (/(today'?s? date|current date|what("|')?s the date|what is the date)/.test(t)) {
			return { name: 'date' };
		}
		if (/(current time|time now|what("|')?s the time|what is the time)/.test(t)) {
			return { name: 'time' };
		}
		// Today/yesterday close intents
		if (/\b(today|yesterday)\b.*\b(price|close|closing)\b/.test(t)) {
			return { name: 'daily_close' };
		}

		// Greetings
		if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/.test(t)) {
			return { name: 'greet' };
		}
		// Farewell
		if (/(bye|goodbye|see you|ttyl|cya)\b/.test(t)) {
			return { name: 'farewell' };
		}
		// Help
		if (/(help|how (to|do) (you|this)|what can you do)/.test(t)) {
			return { name: 'help' };
		}
		// FAQs
		if (/what is (the )?s&p ?500|what is sp500|what is spx/.test(t)) {
			return { name: 'faq_sp500' };
		}
		if (/source|where .*data|accuracy|delay|latency/.test(t)) {
			return { name: 'faq_source' };
		}
		if (/market (open|status|hours)/.test(t)) {
			return { name: 'market_status' };
		}
		// Price queries
		const hasPriceKeyword = /(\bprice\b|\bquote\b|\bticker\b)/.test(t);
		const dollarTicker = extractTickerFromDollarPrefixed(text);
		const keywordTicker = extractTickerAfterKeyword(text);
		const nameCandidate = maybeCompanyName(text);
		if (dollarTicker || keywordTicker || (hasPriceKeyword && nameCandidate)) {
			return { name: 'price', ticker: (dollarTicker || keywordTicker) || null, companyName: nameCandidate || null };
		}

		return { name: 'fallback' };
	}

	function formatUsd(value) {
		if (value == null || Number.isNaN(Number(value))) return 'N/A';
		return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
	}

	async function fetchBackendQuote(ticker) {
		const res = await fetch(`/api/quote?t=${encodeURIComponent(ticker)}`);
		if (!res.ok) throw new Error('quote http');
		const data = await res.json();
		if (!data?.ok) throw new Error('quote bad');
		return data.quote;
	}

	async function fetchHistory(ticker, range = '5d') {
		const res = await fetch(`/api/history?t=${encodeURIComponent(ticker)}&range=${encodeURIComponent(range)}`);
		if (!res.ok) throw new Error('history http');
		const data = await res.json();
		if (!data?.ok) throw new Error('history bad');
		return data.candles;
	}

	async function resolveCompanyToSymbol(name) {
		const res = await fetch(`/api/symbol?q=${encodeURIComponent(name)}`);
		if (!res.ok) throw new Error('symbol search failed');
		const data = await res.json();
		return data?.result?.symbol;
	}

	async function askGemini(message) {
		const res = await fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message })
		});
		const text = await res.text();
		let payload;
		try { payload = JSON.parse(text); } catch { payload = null; }
		if (!res.ok) {
			const code = payload?.error || res.statusText || 'chat_failed';
			const detail = payload?.detail ? `: ${payload.detail}` : '';
			throw new Error(`${code}${detail}`);
		}
		return payload?.text || 'Sorry, I could not generate a response.';
	}

	function getUsMarketOpenStatus(now = new Date()) {
		try {
			const nyNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
			const day = nyNow.getDay(); // 0 Sun ... 6 Sat
			if (day === 0 || day === 6) return { open: false, reason: 'Weekend' };
			const minutes = nyNow.getHours() * 60 + nyNow.getMinutes();
			const openMin = 9 * 60 + 30; // 9:30
			const closeMin = 16 * 60;    // 16:00
			const open = minutes >= openMin && minutes < closeMin;
			return { open, reason: open ? 'Regular trading hours' : 'Outside regular hours (holidays not considered)' };
		} catch (_) {
			return { open: false, reason: 'Time check unavailable' };
		}
	}

	function formatDateTime() {
		const now = new Date();
		const localDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
		const localTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		const nyTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
		return { localDate, localTime, nyTime };
	}

	async function handleIntent(intent, rawText) {
		switch (intent.name) {
			case 'date': {
				const { localDate } = formatDateTime();
				appendMessage('bot', `Today is ${localDate}.`);
				break;
			}
			case 'time': {
				const { localTime, nyTime } = formatDateTime();
				appendMessage('bot', `Time now: ${localTime} (your time). New York: ${nyTime}.`);
				break;
			}
			case 'daily_close': {
				// Try to find a ticker in the message
				let ticker = extractTickerFromDollarPrefixed(rawText) || extractTickerAfterKeyword(rawText);
				if (!ticker) {
					const maybeName = maybeCompanyName(rawText);
					if (maybeName) {
						appendMessage('bot', `Searching symbol for ${maybeName}...`);
						try { ticker = await resolveCompanyToSymbol(maybeName); } catch (_) {}
					}
				}
				if (!ticker) {
					appendMessage('bot', 'Please include a ticker, e.g., "today price AAPL" or "yesterday close ZOTA.NS".');
					break;
				}
				appendMessage('bot', `Fetching recent prices for ${ticker}...`);
				try {
					const candles = await fetchHistory(ticker, '7d');
					if (!candles?.length) throw new Error('no candles');
					const todayIdx = candles.length - 1;
					const yestIdx = candles.length - 2 >= 0 ? candles.length - 2 : null;
					const today = candles[todayIdx];
					const yest = yestIdx != null ? candles[yestIdx] : null;
					const lines = [
						`Latest available close for ${ticker}: ${formatUsd(today?.close)}`,
						yest ? `Previous close: ${formatUsd(yest.close)}` : null
					].filter(Boolean);
					appendMessage('bot', lines.join('\n'));
				} catch (_) {
					appendMessage('bot', `Sorry, I couldn't fetch recent daily data for ${ticker}.`);
				}
				break;
			}
			case 'greet':
				appendMessage('bot', 'Hello! Ask me about stock prices, market status, or type "help".');
				break;
			case 'farewell':
				appendMessage('bot', 'Goodbye!');
				break;
			case 'help':
				appendMessage('bot', 'Try: "price AAPL", "$TSLA", "price ZOTA.NS", "today price AAPL", or company names like "price of Zota Health Care".');
				break;
			case 'faq_sp500':
				appendMessage('bot', 'The S&P 500 is a market-cap weighted index of 500 large U.S. companies, often used as a benchmark for U.S. equities.');
				break;
			case 'faq_source':
				appendMessage('bot', 'Quotes come from the server via Yahoo Finance with a Stooq fallback. Data may be delayed and is for information only.');
				break;
			case 'market_status': {
				const status = getUsMarketOpenStatus();
				appendMessage('bot', `US market is ${status.open ? 'OPEN' : 'CLOSED'} — ${status.reason}.`);
				break;
			}
			case 'price': {
				let ticker = intent.ticker;
				if (!ticker && intent.companyName) {
					appendMessage('bot', `Searching symbol for ${intent.companyName}...`);
					try {
						ticker = await resolveCompanyToSymbol(intent.companyName);
					} catch (_) {}
				}
				if (!ticker) {
					appendMessage('bot', 'Please specify a ticker (e.g., AAPL, ZOTA.NS) or use "price of Company Name".');
					break;
				}
				appendMessage('bot', `Looking up ${ticker}...`);
				try {
					const q = await fetchBackendQuote(ticker);
					const parts = [
						`${q.symbol} — ${q.name}`,
						`Price: ${formatUsd(q.price)}`,
						`Open: ${formatUsd(q.open)}  High: ${formatUsd(q.high)}  Low: ${formatUsd(q.low)}`,
						`Volume: ${q.volume?.toLocaleString?.('en-US') ?? 'N/A'}`
					];
					appendMessage('bot', parts.join('\n'));
				} catch (_) {
					appendMessage('bot', `Sorry, I couldn't retrieve a quote for ${ticker}. Check the symbol and try again.`);
				}
				break;
			}
			default: {
				appendMessage('bot', 'Thinking...');
				try {
					const reply = await askGemini(rawText);
					appendMessage('bot', reply);
				} catch (e) {
					const reason = e?.message || 'Unknown error';
					appendMessage('bot', `Sorry, I could not process that right now (${reason}).`);
				}
			}
		}
	}

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const text = input.value;
		if (!text.trim()) return;
		appendMessage('user', text);
		input.value = '';
		const intent = detectIntent(text);
		handleIntent(intent, text);
	});
})();
