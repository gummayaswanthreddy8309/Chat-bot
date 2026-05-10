# Stock Chatbot (Full Stack)

A minimal, fast chat interface that answers simple stock questions, returns quick quotes, and handles FAQs. A Node/Express backend powers Gemini responses and proxies live quotes.

## Features
- Simple intent recognition for price queries, market status, greetings/help/farewell
- Live quotes via backend proxy (Alpha Vantage primary, Yahoo with Stooq fallback)
- General questions answered via Gemini API
- Responsive, accessible UI

## Quick Start
1. Install Node 18+.
2. Copy environment file and set your keys:
   - Create `.env` next to `server.js` with:
```
PORT=3000
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash
ALPHAVANTAGE_API_KEY=your_alpha_vantage_key_here
```
3. Install deps and run server:
```
npm install
npm run dev
```
4. Open `http://localhost:3000` in your browser.

## Usage
- Ask: `price AAPL` or `is the market open?`
- Ask general finance questions; answers come from Gemini.

## Notes
- Quote data may be delayed. Provided for informational purposes only.
- Market status uses U.S. market hours (9:30–16:00 ET, weekdays) and does not account for holidays.

## Project Structure
- `index.html` — page structure and chat container
- `styles.css` — responsive styles
- `script.js` — chatbot UI + calls to backend
- `server.js` — Express server with `/api/chat` and `/api/quote`
- `package.json` — dependencies and scripts

No build step required; static files are served directly by Express.
