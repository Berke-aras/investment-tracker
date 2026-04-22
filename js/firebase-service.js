/**
 * Firebase Service - Auth (Google + Anonymous) & Cloud Firestore sync
 */
const FirebaseService = {
    _app: null,
    _auth: null,
    _db: null,
    _user: null,
    _authListeners: [],
    _syncListeners: [],
    _syncState: 'idle',
    _debounceTimer: null,
    _initialAuthResolved: false,
    _initialAuthResolve: null,
    _initialAuthPromise: null,
    DEBOUNCE_MS: 2000,
    HISTORY_CAP_CLOUD: 500,

    init() {
        if (FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
            console.warn('Firebase yapilandirilmadi. js/firebase-config.js dosyasini duzenleyin.');
            this._setSyncState('disabled');
            return;
        }
        this._app = firebase.initializeApp(FIREBASE_CONFIG);
        this._auth = firebase.auth();
        this._db = firebase.firestore();
        this._db.settings({
            experimentalAutoDetectLongPolling: true,
            useFetchStreams: false
        });
        this._db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
        this._initialAuthPromise = new Promise(resolve => { this._initialAuthResolve = resolve; });
        this._auth.onAuthStateChanged(user => this._handleAuthChange(user));
    },

    isConfigured() {
        return FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';
    },

    // ── Auth ─────────────────────────────────────────────
    async signInAnonymously() {
        if (!this._auth) return;
        try {
            await this._auth.signInAnonymously();
        } catch (e) {
            console.error('Anonim giris hatasi:', e);
        }
    },

    async signInWithGoogle() {
        if (!this._auth) return;
        const provider = new firebase.auth.GoogleAuthProvider();
        try {
            if (this._user && this._user.isAnonymous) {
                await this._user.linkWithPopup(provider);
            } else {
                await this._auth.signInWithPopup(provider);
            }
        } catch (e) {
            if (e.code === 'auth/credential-already-in-use') {
                const cred = e.credential;
                await this._auth.signInWithCredential(cred);
            } else if (e.code === 'auth/popup-blocked') {
                try {
                    if (this._user && this._user.isAnonymous) {
                        await this._user.linkWithRedirect(provider);
                    } else {
                        await this._auth.signInWithRedirect(provider);
                    }
                } catch (redirectErr) {
                    console.error('Redirect giris hatasi:', redirectErr);
                }
            } else {
                console.error('Google giris hatasi:', e);
                throw e;
            }
        }
    },

    async signOut() {
        if (!this._auth) return;
        await this._auth.signOut();
        await this.signInAnonymously();
    },

    getUser() { return this._user; },

    isAnonymous() { return !this._user || this._user.isAnonymous; },

    getUserDisplayName() {
        if (!this._user) return null;
        if (this._user.isAnonymous) return null;
        return this._user.displayName || this._user.email || null;
    },

    getUserPhotoURL() {
        if (!this._user || this._user.isAnonymous) return null;
        return this._user.photoURL || null;
    },

    onAuthChange(fn) { this._authListeners.push(fn); },

    async waitForInitialAuthState(timeoutMs = 6000) {
        if (this._initialAuthResolved) return this._user;
        if (!this._initialAuthPromise) return this._user;
        try {
            await Promise.race([
                this._initialAuthPromise,
                new Promise(resolve => setTimeout(resolve, timeoutMs))
            ]);
        } catch {}
        return this._user;
    },

    _handleAuthChange(user) {
        this._user = user;
        if (!this._initialAuthResolved) {
            this._initialAuthResolved = true;
            if (this._initialAuthResolve) this._initialAuthResolve(user);
        }
        this._authListeners.forEach(fn => { try { fn(user); } catch {} });
    },

    // ── Sync State ───────────────────────────────────────
    onSyncStateChange(fn) { this._syncListeners.push(fn); },

    getSyncState() { return this._syncState; },

    _setSyncState(state) {
        this._syncState = state;
        this._syncListeners.forEach(fn => { try { fn(state); } catch {} });
    },

    // ── Firestore: User doc path ─────────────────────────
    _docRef() {
        if (!this._db || !this._user) return null;
        return this._db.collection('users').doc(this._user.uid)
            .collection('portfolio').doc('state');
    },

    // ── Cloud Read ───────────────────────────────────────
    async loadFromCloud() {
        const ref = this._docRef();
        if (!ref) return null;
        this._setSyncState('loading');
        try {
            const snap = await ref.get();
            this._setSyncState('synced');
            if (!snap.exists) return null;
            return snap.data();
        } catch (e) {
            console.warn('Bulut veri okunamadi:', e.message);
            this._setSyncState('error');
            return null;
        }
    },

    // ── Cloud Write (debounced) ──────────────────────────
    scheduleCloudSave() {
        if (!this._db || !this._user) return;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._saveToCloud(), this.DEBOUNCE_MS);
    },

    async _saveToCloud() {
        const ref = this._docRef();
        if (!ref) return;
        this._setSyncState('saving');
        try {
            const assets = StorageService.getAssets().map(a => ({
                id: a.id, name: a.name, symbol: a.symbol,
                type: a.type, removable: a.removable, multiplier: a.multiplier || 1
            }));
            const allHistory = StorageService.getAllHistory();
            const trimmed = {};
            for (const [key, arr] of Object.entries(allHistory)) {
                trimmed[key] = (arr || []).slice(-this.HISTORY_CAP_CLOUD);
            }
            const allMeta = {};
            try {
                const raw = JSON.parse(localStorage.getItem(StorageService.META_KEY) || '{}');
                Object.assign(allMeta, raw);
            } catch {}

            await ref.set({
                assets,
                history: trimmed,
                historyMeta: allMeta,
                userName: StorageService.getUserName(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                schemaVersion: StorageService.SCHEMA_VERSION
            });
            this._setSyncState('synced');
        } catch (e) {
            console.error('Bulut kayit hatasi:', e);
            this._setSyncState('error');
        }
    },

    // ── Merge cloud data into local ──────────────────────
    async mergeCloudToLocal() {
        const cloud = await this.loadFromCloud();
        if (!cloud) return false;

        const localUpdated = this._getLocalTimestamp();
        const cloudUpdated = cloud.updatedAt?.toMillis?.() || 0;

        if (cloudUpdated > localUpdated) {
            if (Array.isArray(cloud.assets) && cloud.assets.length > 0) {
                localStorage.setItem(StorageService.KEY, JSON.stringify(cloud.assets));
            }
            if (cloud.history && typeof cloud.history === 'object') {
                const existing = StorageService.getAllHistory();
                const merged = { ...existing };
                for (const [assetId, cloudArr] of Object.entries(cloud.history)) {
                    const localArr = existing[assetId] || [];
                    if (!localArr.length || cloudArr.length > localArr.length) {
                        merged[assetId] = cloudArr;
                    }
                }
                localStorage.setItem(StorageService.HISTORY_KEY, JSON.stringify(merged));
            }
            if (cloud.historyMeta && typeof cloud.historyMeta === 'object') {
                localStorage.setItem(StorageService.META_KEY, JSON.stringify(cloud.historyMeta));
            }
            if (cloud.userName) {
                localStorage.setItem(StorageService.USER_KEY, cloud.userName);
            }
            this._setLocalTimestamp(cloudUpdated);
            return true;
        }
        return false;
    },

    _getLocalTimestamp() {
        return parseInt(localStorage.getItem('portfolio_track_last_sync') || '0', 10);
    },

    _setLocalTimestamp(ts) {
        localStorage.setItem('portfolio_track_last_sync', String(ts || Date.now()));
    },

    // ── Migration: push local data to cloud on first login ──
    async migrateLocalToCloud() {
        const migKey = 'portfolio_track_migrated_' + (this._user?.uid || '');
        if (localStorage.getItem(migKey)) return false;

        const assets = StorageService.getAssets();
        if (!assets.length || (assets.length === 2 && assets[0].id === 'gold_default')) {
            localStorage.setItem(migKey, '1');
            return false;
        }

        await this._saveToCloud();
        this._setLocalTimestamp(Date.now());
        localStorage.setItem(migKey, '1');
        return true;
    }
};
