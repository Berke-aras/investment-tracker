/**
 * Multi-provider Price Service
 * Supports: Truncgil (emtia/doviz), CoinGecko (kripto), Binance (kripto fallback)
 */
const PriceService = {

    // --- Result constructors ---
    _ok(price, source, meta = {}) {
        return { ok: true, price: Number(price), source, ts: Date.now(), ...meta };
    },
    _fail(reason) {
        return { ok: false, reason, ts: Date.now() };
    },

    // --- Network layer with timeout + retry ---
    async _fetchJSON(url, timeoutMs = 10000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return await res.json();
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') throw new Error('Zaman asimi (' + timeoutMs + 'ms)');
            throw e;
        }
    },

    async _retry(fn, attempts = 3, baseDelay = 800) {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try { return await fn(); }
            catch (e) {
                lastErr = e;
                if (e?.status >= 400 && e?.status < 500) {
                    throw e;
                }
                if (i < attempts - 1) {
                    await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
                }
            }
        }
        throw lastErr;
    },

    // --- Cache layer ---
    _cache: new Map(),
    _negCache: new Map(),
    NEG_TTL: 30000,

    TTL: { emtia: 60000, kripto: 30000, hisse: 120000, fon: 300000, doviz: 60000 },

    _getCached(key, ttlMs) {
        const e = this._cache.get(key);
        return (e && Date.now() - e.ts < ttlMs) ? e.data : null;
    },
    _setCache(key, data) {
        this._cache.set(key, { data, ts: Date.now() });
    },
    _isNegCached(key) {
        const t = this._negCache.get(key);
        return t && Date.now() - t < this.NEG_TTL;
    },
    _setNeg(key) { this._negCache.set(key, Date.now()); },

    // --- Symbol mapping tables ---
    TRUNCGIL_MAP: {
        'XAU/TRY': 'gram-altin',
        'ALTIN': 'gram-altin',
        'XAG/TRY': 'gumus',
        'GUMUS': 'gumus',
        'USD/TRY': 'USD',
        'EUR/TRY': 'EUR',
        'GBP/TRY': 'GBP',
        'CHF/TRY': 'CHF',
        'JPY/TRY': 'JPY',
        'AUD/TRY': 'AUD',
        'CAD/TRY': 'CAD',
        'SAR/TRY': 'SAR',
        'CEYREK': 'ceyrek-altin',
        'YARIM': 'yarim-altin',
        'TAM': 'tam-altin',
        'CUMHURIYET': 'cumhuriyet-altini',
    },

    COINGECKO_MAP: {
        'BTC': 'bitcoin',
        'ETH': 'ethereum',
        'BNB': 'binancecoin',
        'SOL': 'solana',
        'ADA': 'cardano',
        'XRP': 'ripple',
        'DOGE': 'dogecoin',
        'DOT': 'polkadot',
        'AVAX': 'avalanche-2',
        'MATIC': 'matic-network',
        'ATOM': 'cosmos',
        'LINK': 'chainlink',
        'UNI': 'uniswap',
        'LTC': 'litecoin',
        'SHIB': 'shiba-inu',
        'TRX': 'tron',
        'NEAR': 'near',
        'APT': 'aptos',
        'ARB': 'arbitrum',
        'OP': 'optimism',
    },

    BINANCE_PAIRS: {
        'BTC': 'BTCUSDT',
        'ETH': 'ETHUSDT',
        'BNB': 'BNBUSDT',
        'SOL': 'SOLUSDT',
        'ADA': 'ADAUSDT',
        'XRP': 'XRPUSDT',
        'DOGE': 'DOGEUSDT',
        'DOT': 'DOTUSDT',
        'AVAX': 'AVAXUSDT',
        'MATIC': 'MATICUSDT',
        'ATOM': 'ATOMUSDT',
        'LINK': 'LINKUSDT',
        'UNI': 'UNIUSDT',
        'LTC': 'LTCUSDT',
        'SHIB': 'SHIBUSDT',
    },

    PROVIDER_ORDER: {
        emtia:  ['truncgil', 'metalsLive'],
        kripto: ['coingecko', 'binance'],
        hisse:  ['stooq', 'truncgil'],
        fon:    ['tefasProxy', 'stooq', 'truncgil'],
        doviz:  ['truncgil', 'openExchange'],
    },

    // --- Provider: Stooq (hisse/fon current quote) ---
    async _fetchText(url, timeoutMs = 10000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return await res.text();
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') throw new Error('Zaman asimi (' + timeoutMs + 'ms)');
            throw e;
        }
    },

    _normalizeStooqSymbol(rawSymbol) {
        const sym = (rawSymbol || '').trim().toLowerCase();
        if (!sym) return '';
        if (sym.includes('.')) return sym;
        // Varsayilan pazar: ABD (ornek: SPY.US, VOO.US)
        return sym + '.us';
    },

    _extractCSVBody(text) {
        if (!text || typeof text !== 'string') return '';
        // r.jina.ai proxy sometimes wraps source with metadata lines.
        // Keep only actual CSV block starting with "Symbol,".
        const idx = text.indexOf('Symbol,');
        return idx >= 0 ? text.slice(idx).trim() : text.trim();
    },

    _parseStooqCSVRow(csv) {
        if (!csv || typeof csv !== 'string') return null;
        const body = this._extractCSVBody(csv);
        const lines = body.split('\n');
        if (lines.length < 2) return null;
        const values = lines[1].split(',');
        if (values.length < 7) return null;
        const close = parseFloat(values[6]);
        if (!isFinite(close) || close <= 0) return null;
        return { close };
    },

    async _stooqQuoteCSV(symbol) {
        const rawUrl = 'https://stooq.com/q/l/?s=' + encodeURIComponent(symbol) + '&f=sd2t2ohlcvn&h&e=csv';
        // 1) Try direct endpoint (fast path)
        try {
            const direct = await this._fetchText(rawUrl, 9000);
            if (this._parseStooqCSVRow(direct)) return direct;
        } catch {}

        // 2) CORS-friendly proxy fallback for browser contexts
        const proxyUrl = 'https://r.jina.ai/http://stooq.com/q/l/?s=' + encodeURIComponent(symbol) + '&f=sd2t2ohlcvn&h&e=csv';
        return await this._fetchText(proxyUrl, 12000);
    },

    async _priceStooq(asset) {
        const symbolRaw = asset.symbol || asset.name;
        const symbol = this._normalizeStooqSymbol(symbolRaw);
        if (!symbol) return this._fail('Stooq: sembol bos');

        const ck = 'stooq_quote_' + symbol;
        let csv = this._getCached(ck, this.TTL[asset.type || 'hisse'] || 120000);
        if (!csv) {
            csv = await this._retry(() =>
                this._stooqQuoteCSV(symbol)
            );
            this._setCache(ck, csv);
        }
        const parsed = this._parseStooqCSVRow(csv);
        if (!parsed) return this._fail('Stooq: fiyat bulunamadi (' + symbol + ')');
        const usdTry = await this._usdTryRate();
        if (!usdTry) return this._fail('Stooq: USD/TRY kuru alinamadi');
        return this._ok(parsed.close * usdTry, 'Stooq');
    },

    // --- Provider: Turkish funds via TEFAS mirror API ---
    _normalizeFundCode(asset) {
        return (asset.symbol || asset.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    },

    async _tefasHistoryData(code, period = '1y', limit = 400) {
        const cacheKey = 'tefas_hist_' + code + '_' + period + '_' + limit;
        let data = this._getCached(cacheKey, this.TTL.fon);
        if (data) return data;

        const url = 'https://r.jina.ai/http://fonhareketleri.com/api/funds/' +
            encodeURIComponent(code) + '/history/?period=' + encodeURIComponent(period) +
            '&limit=' + encodeURIComponent(String(limit));
        const text = await this._retry(() => this._fetchText(url, 15000), 2, 1000);
        const jsonStart = text.indexOf('{');
        if (jsonStart < 0) throw new Error('TEFAS mirror gecersiz yanit');
        data = JSON.parse(text.slice(jsonStart));
        this._setCache(cacheKey, data);
        return data;
    },

    async _priceTefasProxy(asset) {
        const code = this._normalizeFundCode(asset);
        if (!code || code.length < 3) return this._fail('TEFAS: gecersiz fon kodu');
        try {
            const data = await this._tefasHistoryData(code, '1y', 30);
            const rows = Array.isArray(data?.results) ? data.results : [];
            if (!rows.length) return this._fail('TEFAS: fon bulunamadi (' + code + ')');
            const last = rows[rows.length - 1];
            const price = Number(last?.last_price);
            const change24h = Number(last?.daily_return);
            if (!isFinite(price) || price <= 0) return this._fail('TEFAS: fiyat okunamadi (' + code + ')');
            return this._ok(price, 'TEFAS (Fon)', { change24h: isFinite(change24h) ? change24h : null });
        } catch (e) {
            return this._fail('TEFAS proxy hatasi: ' + e.message);
        }
    },

    // --- Provider: Truncgil Finans ---
    async _truncgilData() {
        const cached = this._getCached('_trunc', this.TTL.emtia);
        if (cached) return cached;
        let data;
        try {
            data = await this._retry(() =>
                this._fetchJSON('https://finans.truncgil.com/today.json')
            );
        } catch {
            // Some browser/network combinations intermittently fail direct fetch.
            // Keep a text-proxy fallback for GitHub Pages compatibility.
            const txt = await this._retry(() =>
                this._fetchText('https://r.jina.ai/http://finans.truncgil.com/today.json', 15000), 2, 1000
            );
            const jsonStart = txt.indexOf('{');
            if (jsonStart < 0) throw new Error('Truncgil proxy gecersiz yanit');
            data = JSON.parse(txt.slice(jsonStart));
        }
        this._setCache('_trunc', data);
        return data;
    },

    async _priceTruncgil(asset) {
        const data = await this._truncgilData();
        const sym = this._normalizeTruncgilSymbol(asset);
        const key = this.TRUNCGIL_MAP[sym];

        if (key && data[key]) {
            const sellPrice = data[key]['Satış'] || data[key]['Satis'];
            if (sellPrice) {
                const p = this._parseTR(sellPrice);
                const change24h = this._parsePercentTR(data[key]['Değişim'] || data[key]['Degisim']);
                if (p !== null) return this._ok(p, 'Truncgil Finans', { change24h });
            }
        }

        const directKeys = [sym, sym.toLowerCase(), asset.name, (asset.name || '').toLowerCase()];
        for (const dk of directKeys) {
            if (data[dk]) {
                const sellPrice = data[dk]['Satış'] || data[dk]['Satis'];
                if (sellPrice) {
                    const p = this._parseTR(sellPrice);
                    const change24h = this._parsePercentTR(data[dk]['Değişim'] || data[dk]['Degisim']);
                    if (p !== null) return this._ok(p, 'Truncgil Finans', { change24h });
                }
            }
        }

        return this._fail('Truncgil: sembol bulunamadi (' + sym + ')');
    },

    // --- Provider: MetalsLive (XAU/XAG in USD, CORS-friendly fallback) ---
    async _metalsLiveData() {
        const cached = this._getCached('_metals_live', this.TTL.emtia);
        if (cached) return cached;

        let data = null;
        try {
            data = await this._retry(() =>
                this._fetchJSON('https://api.metals.live/v1/spot', 3000), 1
            );
        } catch {
            // Some environments fail TLS/CORS on direct endpoint; use text proxy fallback.
            const proxyText = await this._retry(() =>
                this._fetchText('https://r.jina.ai/http://api.metals.live/v1/spot', 15000), 2, 1000
            );
            const jsonStart = proxyText.indexOf('[');
            if (jsonStart < 0) throw new Error('MetalsLive proxy gecersiz yanit');
            data = JSON.parse(proxyText.slice(jsonStart));
        }

        this._setCache('_metals_live', data);
        return data;
    },

    _extractMetalsLivePrice(data, key) {
        if (!Array.isArray(data)) return null;
        for (const row of data) {
            if (row && typeof row === 'object' && row[key] != null) {
                const parsed = Number(row[key]);
                if (!isNaN(parsed) && parsed > 0) return parsed;
            }
        }
        return null;
    },

    async _priceMetalsLive(asset) {
        const sym = (asset.symbol || asset.name || '').toUpperCase();
        const isGold = sym === 'XAU/TRY' || sym === 'ALTIN';
        const isSilver = sym === 'XAG/TRY' || sym === 'GUMUS';
        if (!isGold && !isSilver) {
            return this._fail('MetalsLive: sembol desteklenmiyor (' + sym + ')');
        }

        const data = await this._metalsLiveData();
        const usdPrice = this._extractMetalsLivePrice(data, isGold ? 'gold' : 'silver');
        if (!usdPrice) return this._fail('MetalsLive: USD fiyat bulunamadi');

        const usdTry = await this._usdTryRate();
        if (!usdTry) return this._fail('MetalsLive: USD/TRY bulunamadi');

        // MetalsLive prices are per ounce; keep as fallback approximation for TRY display.
        return this._ok(usdPrice * usdTry, 'MetalsLive');
    },

    // --- Provider: Open Exchange Rates mirror (free, CORS-friendly) ---
    async _openExchangeData() {
        const cached = this._getCached('_open_exchange', this.TTL.doviz);
        if (cached) return cached;
        const data = await this._retry(() =>
            this._fetchJSON('https://open.er-api.com/v6/latest/TRY')
        );
        this._setCache('_open_exchange', data);
        return data;
    },

    async _priceOpenExchange(asset) {
        const sym = (asset.symbol || asset.name || '').toUpperCase().trim();
        const map = {
            'USD/TRY': 'USD',
            'EUR/TRY': 'EUR',
            'GBP/TRY': 'GBP',
            'CHF/TRY': 'CHF',
            'JPY/TRY': 'JPY',
            'AUD/TRY': 'AUD',
            'CAD/TRY': 'CAD',
            'SAR/TRY': 'SAR',
        };
        const code = map[sym];
        if (!code) return this._fail('OpenExchange: sembol desteklenmiyor (' + sym + ')');

        const data = await this._openExchangeData();
        const ratePerTry = data?.rates?.[code];
        if (!ratePerTry || ratePerTry <= 0) {
            return this._fail('OpenExchange: kur bulunamadi (' + code + ')');
        }
        const tryPerUnit = 1 / ratePerTry;
        return this._ok(tryPerUnit, 'OpenExchange');
    },

    // --- Provider: CoinGecko ---
    async _priceCoinGecko(asset) {
        const sym = this._cryptoSymbol(asset);
        const coinId = this.COINGECKO_MAP[sym];
        if (!coinId) return this._fail('CoinGecko: desteklenmiyor (' + sym + ')');

        const ck = 'cg_' + coinId;
        let data = this._getCached(ck, this.TTL.kripto);
        if (!data) {
            data = await this._retry(() =>
                this._fetchJSON(
                    'https://api.coingecko.com/api/v3/simple/price?ids=' + coinId + '&vs_currencies=try&include_24hr_change=true'
                )
            );
            this._setCache(ck, data);
        }
        const price = data[coinId]?.try;
        const change24h = Number(data[coinId]?.try_24h_change);
        return price ? this._ok(price, 'CoinGecko', { change24h: isNaN(change24h) ? null : change24h }) : this._fail('CoinGecko: fiyat bulunamadi');
    },

    async warmCryptoCache(assets) {
        const cryptoAssets = (assets || []).filter(a => (a?.type || 'emtia') === 'kripto');
        if (!cryptoAssets.length) return;

        const ids = [];
        for (const asset of cryptoAssets) {
            const sym = this._cryptoSymbol(asset);
            const coinId = this.COINGECKO_MAP[sym];
            if (!coinId) continue;
            const ck = 'cg_' + coinId;
            if (!this._getCached(ck, this.TTL.kripto)) {
                ids.push(coinId);
            }
        }

        const uniqueIds = [...new Set(ids)];
        if (!uniqueIds.length) return;

        try {
            const data = await this._retry(() =>
                this._fetchJSON(
                    'https://api.coingecko.com/api/v3/simple/price?ids=' +
                    encodeURIComponent(uniqueIds.join(',')) +
                    '&vs_currencies=try&include_24hr_change=true'
                )
            );

            for (const coinId of uniqueIds) {
                if (data && data[coinId]) {
                    this._setCache('cg_' + coinId, { [coinId]: data[coinId] });
                }
            }
        } catch (e) {
            console.warn('CoinGecko toplu onbellek hatasi:', e.message);
        }
    },

    // ── Historical data: universal router ─────────────────
    async getHistoricalPrices(asset, days = 1095) {
        const type = asset.type || 'emtia';
        const sym = (asset.symbol || asset.name || '').toUpperCase();

        switch (type) {
            case 'kripto': return this._histCrypto(asset, days);
            case 'doviz':  return this._histFX(sym, days);
            case 'emtia':  return this._histEmtia(sym, days);
            case 'fon':    return this._histFundTR(asset, days);
            default:       return null;
        }
    },

    async _histFundTR(asset, days) {
        const code = this._normalizeFundCode(asset);
        if (!code || code.length < 3) return null;
        try {
            const period = days >= 365 ? '1y' : '3m';
            const limit = Math.max(30, Math.min(500, Math.ceil(days * 1.2)));
            const data = await this._tefasHistoryData(code, period, limit);
            const rows = Array.isArray(data?.results) ? data.results : [];
            if (!rows.length) return null;
            return rows
                .map(r => ({
                    ts: Date.parse((r.last_price_date || '').toString().slice(0, 10) + 'T00:00:00Z'),
                    price: Number(r.last_price)
                }))
                .filter(p => isFinite(p.ts) && isFinite(p.price) && p.price > 0)
                .sort((a, b) => a.ts - b.ts);
        } catch (e) {
            console.warn('TEFAS hist hatasi (' + code + '):', e.message);
            return null;
        }
    },

    CG_FREE_MAX_DAYS: 365,

    async _histCrypto(asset, days) {
        const sym = this._cryptoSymbol(asset);
        const coinId = this.COINGECKO_MAP[sym];
        if (!coinId) return null;
        return this._fetchCGHistory(coinId, Math.min(days, this.CG_FREE_MAX_DAYS));
    },

    FRANKFURTER_MAP: {
        'USD/TRY': 'USD', 'EUR/TRY': 'EUR', 'GBP/TRY': 'GBP',
        'CHF/TRY': 'CHF', 'JPY/TRY': 'JPY', 'AUD/TRY': 'AUD',
        'CAD/TRY': 'CAD',
    },

    async _histFX(sym, days) {
        const base = this.FRANKFURTER_MAP[sym];
        if (!base) return null;
        return this._fetchFrankfurterHistory(base, days);
    },

    GRAMS_PER_TROY_OZ: 31.1035,

    async _histEmtia(sym, days) {
        if (sym === 'XAU/TRY' || sym === 'ALTIN') {
            const cgDays = Math.min(days, this.CG_FREE_MAX_DAYS);
            const hist = await this._fetchCGHistory('pax-gold', cgDays);
            if (!hist) return null;
            return hist.map(p => ({ ts: p.ts, price: p.price / this.GRAMS_PER_TROY_OZ }));
        }
        return null;
    },

    // ── CoinGecko historical helper ────────────────────────
    async _fetchCGHistory(coinId, days) {
        const ck = 'cg_hist_' + coinId + '_' + days;
        let data = this._getCached(ck, 3600000);
        if (!data) {
            try {
                data = await this._retry(() =>
                    this._fetchJSON(
                        'https://api.coingecko.com/api/v3/coins/' + coinId +
                        '/market_chart?vs_currency=try&days=' + days,
                        20000
                    ), 2
                );
                if (data?.error || data?.status?.error_code) {
                    console.warn('CoinGecko hist API hatasi (' + coinId + '):', data?.error || data?.status);
                    return null;
                }
                this._setCache(ck, data);
            } catch (e) {
                console.warn('CoinGecko hist hatasi (' + coinId + '):', e.message);
                return null;
            }
        }
        if (!data?.prices?.length) return null;
        return data.prices.map(([ts, price]) => ({ ts, price }));
    },

    // ── Frankfurter historical helper (FX) ─────────────────
    async _fetchFrankfurterHistory(base, days) {
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - days * 86400000);
        const fmt = d => d.toISOString().split('T')[0];
        const url = 'https://api.frankfurter.app/' + fmt(startDate) + '..' + fmt(endDate) +
            '?from=' + base + '&to=TRY';

        const ck = 'frank_' + base + '_' + days;
        let data = this._getCached(ck, 3600000);
        if (!data) {
            try {
                data = await this._retry(() => this._fetchJSON(url, 15000), 2);
                if (!data?.rates) {
                    console.warn('Frankfurter: gecersiz yanit (' + base + ')');
                    return null;
                }
                this._setCache(ck, data);
            } catch (e) {
                console.warn('Frankfurter hist hatasi (' + base + '):', e.message);
                return null;
            }
        }
        if (!data?.rates) return null;
        const sorted = Object.entries(data.rates)
            .map(([date, rates]) => ({ ts: new Date(date + 'T00:00:00Z').getTime(), price: rates.TRY }))
            .filter(p => p.price > 0)
            .sort((a, b) => a.ts - b.ts);
        return sorted.length > 10 ? sorted : null;
    },

    // ── History quality validation ─────────────────────────
    validateHistory(data, minDays = 365) {
        if (!data || data.length < 10) return false;
        const range = data[data.length - 1].ts - data[0].ts;
        if (range < minDays * 86400000) return false;
        for (let i = 0; i < data.length; i++) {
            if (typeof data[i].price !== 'number' || isNaN(data[i].price) || data[i].price <= 0) return false;
            if (i > 0 && data[i].ts < data[i - 1].ts) return false;
        }
        return true;
    },

    // --- Provider: Binance (kripto fallback, USDT->TRY conversion) ---
    async _priceBinance(asset) {
        const sym = this._cryptoSymbol(asset);
        const pair = this.BINANCE_PAIRS[sym];
        if (!pair) return this._fail('Binance: desteklenmiyor (' + sym + ')');

        const ck = 'bn_' + pair;
        let data = this._getCached(ck, 15000);
        if (!data) {
            data = await this._retry(() =>
                this._fetchJSON('https://api.binance.com/api/v3/ticker/price?symbol=' + pair)
            );
            this._setCache(ck, data);
        }
        const usdtPrice = parseFloat(data?.price);
        if (!usdtPrice) return this._fail('Binance: fiyat bulunamadi');

        const rate = await this._usdTryRate();
        if (!rate) return this._fail('USD/TRY kuru alinamadi');
        return this._ok(usdtPrice * rate, 'Binance');
    },

    async _usdTryRate() {
        try {
            const data = await this._truncgilData();
            const truncgil = this._parseTR(data['USD']?.['Satış']);
            if (truncgil) return truncgil;
        } catch {}

        try {
            const openData = await this._openExchangeData();
            const perTry = openData?.rates?.USD;
            if (perTry && perTry > 0) return 1 / perTry;
        } catch {}

        return null;
    },

    // --- Helpers ---
    _cryptoSymbol(asset) {
        return (asset.symbol || asset.name || '')
            .toUpperCase()
            .replace(/\/TRY$/i, '')
            .replace(/USDT$/i, '')
            .trim();
    },

    _parseTR(val) {
        if (typeof val === 'number') return isFinite(val) ? val : null;
        if (!val || typeof val !== 'string') return null;
        const num = parseFloat(val.replace(/\./g, '').replace(',', '.'));
        return isNaN(num) ? null : num;
    },

    _parsePercentTR(val) {
        if (typeof val === 'number') return isFinite(val) ? val : null;
        if (!val || typeof val !== 'string') return null;
        const cleaned = val.replace('%', '').replace(/\./g, '').replace(',', '.');
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
    },

    _normalizeTruncgilSymbol(asset) {
        const raw = (asset.symbol || asset.name || '').toUpperCase().trim();
        if (raw) return raw;
        const name = (asset.name || '').toLowerCase();
        if (name.includes('alt')) return 'XAU/TRY';
        if (name.includes('gum') || name.includes('güm')) return 'XAG/TRY';
        return '';
    },

    // --- Main entry: get price with failover ---
    async getPrice(asset) {
        const type = asset.type || 'emtia';
        const providers = this.PROVIDER_ORDER[type] || ['truncgil'];
        const negKey = type + ':' + (asset.symbol || asset.name);
        const reasons = [];

        if (this._isNegCached(negKey)) {
            return this._fail('Son deneme basarisiz, bekleniyor...');
        }

        for (const name of providers) {
            try {
                let result;
                switch (name) {
                    case 'truncgil':  result = await this._priceTruncgil(asset); break;
                    case 'metalsLive': result = await this._priceMetalsLive(asset); break;
                    case 'coingecko': result = await this._priceCoinGecko(asset); break;
                    case 'binance':   result = await this._priceBinance(asset); break;
                    case 'openExchange': result = await this._priceOpenExchange(asset); break;
                    case 'tefasProxy': result = await this._priceTefasProxy(asset); break;
                    case 'stooq': result = await this._priceStooq(asset); break;
                    default: continue;
                }
                if (result.ok) return result;
                if (result && result.reason) reasons.push('[' + name + '] ' + result.reason);
            } catch (e) {
                console.warn('[' + name + '] ' + (asset.symbol || asset.name) + ': ' + e.message);
                reasons.push('[' + name + '] ' + e.message);
            }
        }

        this._setNeg(negKey);
        return this._fail(reasons.length ? reasons.join(' | ') : 'Tum saglayicilar basarisiz');
    },

    // --- Health check for settings page ---
    async checkHealth() {
        const withTimeout = async (runner, timeoutMs = 8000) => {
            let timer;
            try {
                await Promise.race([
                    runner(),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
                    })
                ]);
                return true;
            } catch (e) {
                if (e && e.message === 'timeout') return null;
                return false;
            } finally {
                clearTimeout(timer);
            }
        };

        const checks = {
            truncgil: () => this._truncgilData(),
            metalsLive: () => this._metalsLiveData(),
            coingecko: () => this._fetchJSON('https://api.coingecko.com/api/v3/ping', 5000),
            binance: () => this._fetchJSON('https://api.binance.com/api/v3/ping', 5000),
            openExchange: () => this._openExchangeData(),
            stooq: () => this._stooqQuoteCSV('spy.us'),
            tefasProxy: () => this._tefasHistoryData('PHE', '3m', 30),
        };

        const keys = Object.keys(checks);
        const results = await Promise.all(
            keys.map(key => withTimeout(checks[key]))
        );

        const health = {};
        keys.forEach((key, i) => {
            health[key] = results[i];
        });
        return health;
    },

    // --- Supported symbols per type ---
    getSupportedInfo() {
        return {
            emtia: {
                providers: ['Truncgil Finans', 'MetalsLive (Yedek)'],
                symbols: ['XAU/TRY', 'XAG/TRY', 'CEYREK', 'YARIM', 'TAM', 'CUMHURIYET']
            },
            kripto: {
                providers: ['CoinGecko', 'Binance'],
                symbols: Object.keys(this.COINGECKO_MAP)
            },
            doviz: {
                providers: ['Truncgil Finans', 'OpenExchange (Yedek)'],
                symbols: ['USD/TRY', 'EUR/TRY', 'GBP/TRY', 'CHF/TRY', 'JPY/TRY']
            },
            hisse: {
                providers: ['Stooq', 'Truncgil Finans (Yedek)'],
                symbols: [],
                note: 'Sembol girerken borsa uzantisi kullanin (ornek: AAPL.US, THYAO.TR).'
            },
            fon: {
                providers: ['TEFAS (Fon)', 'Stooq', 'Truncgil Finans (Yedek)'],
                symbols: [],
                note: 'Turk fon kodu girin (ornek: PHE, TB2, HZR).'
            }
        };
    },

    isSymbolSupported(symbol, type) {
        const sym = (symbol || '').toUpperCase().trim();
        if (type === 'kripto') {
            return !!this.COINGECKO_MAP[sym.replace(/\/TRY$/i, '').replace(/USDT$/i, '')];
        }
        if (type === 'emtia' || type === 'doviz') {
            return !!this.TRUNCGIL_MAP[sym];
        }
        // hisse/fon: can't fully validate ahead of time
        return true;
    }
};
