/**
 * Storage Service - asset persistence and price history
 */
const StorageService = {
    KEY: 'portfolio_track_assets',
    HISTORY_KEY: 'portfolio_track_history',
    META_KEY: 'portfolio_track_history_meta',
    USER_KEY: 'portfolio_track_user',
    SCHEMA_VERSION: 2,

    DEFAULTS: [
        {
            id: 'gold_default',
            name: 'Altın (Gram)',
            symbol: 'XAU/TRY',
            type: 'emtia',
            removable: true,
            multiplier: 5
        },
        {
            id: 'silver_default',
            name: 'Gümüş',
            symbol: 'XAG/TRY',
            type: 'emtia',
            removable: true,
            multiplier: 100
        }
    ],

    getAssets() {
        try {
            const raw = localStorage.getItem(this.KEY);
            if (!raw) return this.DEFAULTS.map(d => ({ ...d }));
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed) || parsed.length === 0) {
                return this.DEFAULTS.map(d => ({ ...d }));
            }
            return this._migrateAssets(parsed);
        } catch (e) {
            console.error('Varlik verileri okunamadi:', e);
            this._notifyError('Kayıtlı varlıklar okunamadı, varsayılan veriler yüklendi.');
            return this.DEFAULTS.map(d => ({ ...d }));
        }
    },

    _migrateAssets(assets) {
        return assets.map(a => {
            const migrated = { ...a };
            if (!migrated.multiplier) migrated.multiplier = 1;
            if (migrated.removable === undefined) migrated.removable = true;
            // Remove legacy simulation fields from storage
            delete migrated.seed;
            delete migrated.drift;
            delete migrated.vol;
            delete migrated.startPrice;
            return migrated;
        });
    },

    saveAssets(assets) {
        try {
            const cleaned = assets.map(a => ({
                id: a.id,
                name: a.name,
                symbol: a.symbol,
                type: a.type,
                removable: a.removable,
                multiplier: a.multiplier || 1
            }));
            localStorage.setItem(this.KEY, JSON.stringify(cleaned));
            return { ok: true };
        } catch (e) {
            console.error('Varliklar kaydedilemedi:', e);
            this._notifyError('Varlıklar kaydedilemedi: ' + e.message);
            return { ok: false, reason: e.message };
        }
    },

    // --- Price History ---
    getHistory(assetId) {
        try {
            const all = JSON.parse(localStorage.getItem(this.HISTORY_KEY) || '{}');
            return all[assetId] || [];
        } catch { return []; }
    },

    getAllHistory() {
        try {
            return JSON.parse(localStorage.getItem(this.HISTORY_KEY) || '{}');
        } catch { return {}; }
    },

    addPriceSnapshot(assetId, price) {
        if (price == null || isNaN(price)) return;
        try {
            const all = JSON.parse(localStorage.getItem(this.HISTORY_KEY) || '{}');
            if (!all[assetId]) all[assetId] = [];

            const now = Date.now();
            const last = all[assetId][all[assetId].length - 1];
            if (last && now - last.ts < 3600000) return;

            all[assetId].push({ ts: now, price: Number(price) });

            if (all[assetId].length > 2000) {
                all[assetId] = all[assetId].slice(-2000);
            }
            localStorage.setItem(this.HISTORY_KEY, JSON.stringify(all));
        } catch (e) {
            console.error('Fiyat gecmisi kaydedilemedi:', e);
        }
    },

    setHistory(assetId, dataPoints, meta) {
        try {
            const all = JSON.parse(localStorage.getItem(this.HISTORY_KEY) || '{}');
            all[assetId] = dataPoints.slice(-2000);
            localStorage.setItem(this.HISTORY_KEY, JSON.stringify(all));

            if (meta) {
                const allMeta = JSON.parse(localStorage.getItem(this.META_KEY) || '{}');
                allMeta[assetId] = {
                    source: meta.source || 'unknown',
                    rangeDays: meta.rangeDays || 0,
                    lastSyncTs: Date.now(),
                    pointCount: all[assetId].length
                };
                localStorage.setItem(this.META_KEY, JSON.stringify(allMeta));
            }
        } catch (e) {
            console.error('Fiyat gecmisi kaydedilemedi:', e);
        }
    },

    getHistoryMeta(assetId) {
        try {
            const allMeta = JSON.parse(localStorage.getItem(this.META_KEY) || '{}');
            return allMeta[assetId] || null;
        } catch { return null; }
    },

    isHistoryFresh(assetId, minRangeDays) {
        const meta = this.getHistoryMeta(assetId);
        if (!meta) return false;
        if (Date.now() - meta.lastSyncTs > 86400000) return false;
        if (minRangeDays && meta.rangeDays < minRangeDays) return false;
        return true;
    },

    removeHistory(assetId) {
        try {
            const all = JSON.parse(localStorage.getItem(this.HISTORY_KEY) || '{}');
            delete all[assetId];
            localStorage.setItem(this.HISTORY_KEY, JSON.stringify(all));

            const allMeta = JSON.parse(localStorage.getItem(this.META_KEY) || '{}');
            delete allMeta[assetId];
            localStorage.setItem(this.META_KEY, JSON.stringify(allMeta));
        } catch (e) {
            console.error('Gecmis silinemedi:', e);
        }
    },

    reset() {
        localStorage.removeItem(this.KEY);
        localStorage.removeItem(this.HISTORY_KEY);
        localStorage.removeItem(this.META_KEY);
        localStorage.removeItem(this.USER_KEY);
        return this.DEFAULTS.map(d => ({ ...d }));
    },

    getUserName() {
        const val = localStorage.getItem(this.USER_KEY);
        return val && val.trim() ? val.trim() : 'Yatırımcı';
    },

    saveUserName(name) {
        const cleaned = String(name || '').trim().slice(0, 30);
        if (!cleaned) return { ok: false, reason: 'Ad boş olamaz' };
        localStorage.setItem(this.USER_KEY, cleaned);
        return { ok: true };
    },

    getStorageUsageKB() {
        let bytes = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i) || '';
            const val = localStorage.getItem(key) || '';
            bytes += key.length + val.length;
        }
        return (bytes / 1024).toFixed(2);
    },

    _errorListeners: [],
    onError(fn) { this._errorListeners.push(fn); },
    _notifyError(msg) {
        this._errorListeners.forEach(fn => {
            try { fn(msg); } catch {}
        });
    }
};
