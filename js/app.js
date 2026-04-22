/**
 * Main Application - Real data driven portfolio tracker
 */
const PortfolioApp = {
    state: {
        assets: [],
        assetData: {},
        activeAssetId: null,
        activeRange: '1Y',
        activeFilter: 'all',
        searchTerm: '',
        sortKey: null,
        sortDir: 'desc',
        activeView: 'dashboard',
        chartInstance: null,
        distributionChartInstance: null,
        isLoading: false,
        editingAssetId: null,
        confirmAction: null,
        userName: 'Yatırımcı',
        nextRefreshAt: 0,
        dataStatus: { total: 0, real: 0, stale: 0, unavailable: 0 }
    },

    ranges: {
        '1A': 30, '3A': 90, '6A': 180, '1Y': 365, '3Y': 1095, '5Y': 1825
    },

    // ── Bootstrap ──────────────────────────────────────────
    async init() {
        StorageService.onError(msg => this.showBanner(msg, 'error'));
        this.setupEventListeners();

        FirebaseService.init();
        FirebaseService.onSyncStateChange(s => this._renderSyncBadge(s));
        FirebaseService.onAuthChange(user => this._onAuthStateChanged(user));

        if (FirebaseService.isConfigured()) {
            this._renderSyncBadge('loading');
            await FirebaseService.signInAnonymously();
        } else {
            this._loadLocalAndStart();
        }
    },

    _loadLocalAndStart() {
        this.state.assets = StorageService.getAssets();
        this.state.activeAssetId = this.state.assets[0]?.id || null;
        this.state.userName = StorageService.getUserName();
        this.state.nextRefreshAt = Date.now() + 300000;
        this._applyUserName();
        this._updateAuthUI();
        this.renderStatusBanner('loading');
        this.syncRealPrices().then(() => this.updateUI());
        this.startClock();
        this._startRefreshTimer();
    },

    _startRefreshTimer() {
        clearInterval(this._refreshTimer);
        this._refreshTimer = setInterval(() => {
            this.state.nextRefreshAt = Date.now() + 300000;
            this.syncRealPrices().then(() => this.updateUI());
        }, 300000);
    },

    async _onAuthStateChanged(user) {
        if (!user) {
            this._loadLocalAndStart();
            return;
        }

        this.showBanner('Veriler yükleniyor...', 'loading');
        try {
            const merged = await FirebaseService.mergeCloudToLocal();
            if (!merged) {
                await FirebaseService.migrateLocalToCloud();
            }
        } catch (e) {
            console.warn('Bulut senkron basarisiz:', e.message);
        }

        this._loadLocalAndStart();
    },

    // ── Data Sync ──────────────────────────────────────────
    async syncRealPrices() {
        this.state.isLoading = true;
        const status = { total: this.state.assets.length, real: 0, stale: 0, unavailable: 0 };

        for (const asset of this.state.assets) {
            const result = await PriceService.getPrice(asset);

            if (result.ok) {
                asset.currentPrice = result.price;
                StorageService.addPriceSnapshot(asset.id, result.price);
                this.state.assetData[asset.id] = {
                    price: result.price, status: 'real',
                    source: result.source, lastUpdate: Date.now(),
                    change24h: result.change24h ?? null
                };
                status.real++;

                await this._backfillHistory(asset);
            } else {
                const history = StorageService.getHistory(asset.id);
                const last = history.length ? history[history.length - 1] : null;

                if (last && Date.now() - last.ts < 259200000) {
                    asset.currentPrice = last.price;
                    this.state.assetData[asset.id] = {
                        price: last.price, status: 'stale',
                        source: 'Onbellek', lastUpdate: last.ts,
                        change24h: null
                    };
                    status.stale++;
                } else {
                    asset.currentPrice = null;
                    this.state.assetData[asset.id] = {
                        price: null, status: 'unavailable',
                        source: null, lastUpdate: null, reason: result.reason
                    };
                    status.unavailable++;
                }
            }
        }

        this.state.dataStatus = status;
        this.state.isLoading = false;
        StorageService.saveAssets(this.state.assets);
        this._triggerCloudSync();
        this.renderStatusBanner();
    },

    _triggerCloudSync() {
        FirebaseService.scheduleCloudSave();
    },

    async _backfillHistory(asset) {
        const TARGET_DAYS = 1095;

        if (StorageService.isHistoryFresh(asset.id, 365)) return;

        try {
            const hist = await PriceService.getHistoricalPrices(asset, TARGET_DAYS);
            if (hist && hist.length > 0) {
                const isValid = PriceService.validateHistory(hist, 30);
                const rangeDays = hist.length > 1
                    ? Math.round((hist[hist.length - 1].ts - hist[0].ts) / 86400000)
                    : 0;
                StorageService.setHistory(asset.id, hist, {
                    source: 'api',
                    rangeDays: rangeDays
                });

                if (!isValid) {
                    this.state.assetData[asset.id].histStatus = 'partial';
                }
            }
        } catch (e) {
            console.warn('Gecmis verisi alinamadi (' + (asset.symbol || asset.name) + '):', e.message);
        }
    },

    // ── Status Banner ──────────────────────────────────────
    renderStatusBanner(overrideState) {
        const el = document.getElementById('data-status-banner');
        if (!el) return;
        const s = this.state.dataStatus;

        if (overrideState === 'loading') {
            el.className = 'status-banner status-loading';
            el.innerHTML = '<span class="status-icon">' + Utils.icons.refresh + '</span>' +
                '<span>Veriler yükleniyor...</span>';
            return;
        }

        if (s.total === 0) {
            el.className = 'status-banner status-neutral';
            el.innerHTML = '<span class="status-icon">' + Utils.icons.alertTriangle + '</span>' +
                '<span>Henüz varlık eklenmedi.</span>';
            return;
        }

        if (s.unavailable === s.total) {
            el.className = 'status-banner status-error';
            el.innerHTML = '<span class="status-icon">' + Utils.icons.xCircle + '</span>' +
                '<span>Veri alınamadı. Bağlantınızı kontrol edin.</span>' +
                '<button class="status-retry-btn" onclick="PortfolioApp.retrySyncUI()">Tekrar Dene</button>';
            return;
        }

        if (s.unavailable > 0 || s.stale > 0) {
            el.className = 'status-banner status-warning';
            const parts = [];
            if (s.real > 0) parts.push(s.real + ' gerçek');
            if (s.stale > 0) parts.push(s.stale + ' önbellek');
            if (s.unavailable > 0) parts.push(s.unavailable + ' alınamadı');
            el.innerHTML = '<span class="status-icon">' + Utils.icons.alertTriangle + '</span>' +
                '<span>Kısmi veri: ' + parts.join(', ') + '</span>' +
                '<button class="status-retry-btn" onclick="PortfolioApp.retrySyncUI()">Tekrar Dene</button>';
            return;
        }

        el.className = 'status-banner status-ok';
        el.innerHTML = '<span class="status-icon">' + Utils.icons.checkCircle + '</span>' +
            '<span>Tüm veriler güncel (' + s.real + ' varlık)</span>';
        setTimeout(() => { if (el.classList.contains('status-ok')) el.classList.add('status-fade'); }, 5000);
    },

    showBanner(msg, type) {
        const el = document.getElementById('data-status-banner');
        if (!el) return;
        el.className = 'status-banner status-' + (type || 'error');
        el.innerHTML = '<span class="status-icon">' +
            (type === 'error' ? Utils.icons.xCircle : Utils.icons.alertTriangle) +
            '</span><span>' + msg + '</span>';
    },

    async retrySyncUI() {
        this.renderStatusBanner('loading');
        PriceService._negCache.clear();
        this.state.nextRefreshAt = Date.now() + 300000;
        await this.syncRealPrices();
        this.updateUI();
    },

    // ── Event Listeners ────────────────────────────────────
    setupEventListeners() {
        document.getElementById('range-selector').addEventListener('click', (e) => {
            if (e.target.dataset.range) {
                this.state.activeRange = e.target.dataset.range;
                this.updateRangeButtons();
                this.renderChart().catch(err => console.warn('Chart render hatasi:', err));
            }
        });

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const view = e.currentTarget.id.replace('nav-', '');
                this.switchView(view);
                document.querySelectorAll('.nav-item').forEach(v => v.classList.remove('active'));
                e.currentTarget.classList.add('active');
            });
        });

        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.state.activeFilter = e.target.dataset.filter;
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.renderTable();
            });
        });
        document.getElementById('asset-search-input').addEventListener('input', (e) => {
            this.state.searchTerm = e.target.value.trim().toLowerCase();
            this.renderTable();
        });
        document.querySelectorAll('.sort-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.sort;
                if (this.state.sortKey === key) {
                    this.state.sortDir = this.state.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    this.state.sortKey = key;
                    this.state.sortDir = 'desc';
                }
                this._updateSortButtons();
                this.renderTable();
            });
        });

        const modal = document.getElementById('add-asset-modal');
        document.getElementById('add-asset-btn').addEventListener('click', () => modal.classList.add('open'));
        document.querySelectorAll('.close-modal').forEach(btn => {
            btn.addEventListener('click', () => modal.classList.remove('open'));
        });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

        document.getElementById('add-asset-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAddAsset();
        });
        document.getElementById('refresh-now-btn').addEventListener('click', () => this.retrySyncUI());
        document.getElementById('reset-data-btn').addEventListener('click', () => {
            this.openConfirm('Veriler sıfırlansın mı?', 'Tüm varlıklar ve geçmiş veriler silinecek.', () => this.resetApp());
        });
        document.getElementById('save-user-name-btn').addEventListener('click', () => this.saveUserName());
        document.getElementById('edit-asset-form').addEventListener('submit', (e) => this.submitEditAsset(e));
        document.querySelectorAll('[data-close-confirm]').forEach(btn => btn.addEventListener('click', () => this.closeConfirm()));
        document.querySelectorAll('[data-close-edit]').forEach(btn => btn.addEventListener('click', () => this.closeEditModal()));
        document.getElementById('confirm-modal-ok-btn').addEventListener('click', () => {
            if (typeof this.state.confirmAction === 'function') this.state.confirmAction();
            this.closeConfirm();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.getElementById('add-asset-modal').classList.remove('open');
                this.closeConfirm();
                this.closeEditModal();
            }
        });

        document.getElementById('btn-google-login').addEventListener('click', () => this._handleGoogleLogin());
        document.getElementById('btn-sign-out').addEventListener('click', () => this._handleSignOut());
        document.getElementById('settings-btn-google').addEventListener('click', () => this._handleGoogleLogin());
        document.getElementById('settings-btn-signout').addEventListener('click', () => this._handleSignOut());
    },

    updateRangeButtons() {
        document.querySelectorAll('.range-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.range === this.state.activeRange);
        });
    },

    _updateSortButtons() {
        document.querySelectorAll('.sort-btn').forEach(btn => {
            const active = btn.dataset.sort === this.state.sortKey;
            btn.classList.toggle('active', active);
            btn.textContent = btn.textContent.replace(/ [↑↓]$/, '');
            if (active) btn.textContent += this.state.sortDir === 'asc' ? ' ↑' : ' ↓';
        });
    },

    _applyUserName() {
        const displayName = FirebaseService.getUserDisplayName();
        const name = displayName || this.state.userName;
        const el = document.getElementById('user-name');
        if (el) el.textContent = name;
        const input = document.getElementById('settings-user-name');
        if (input) input.value = this.state.userName;
    },

    // ── Auth UI ─────────────────────────────────────────
    async _handleGoogleLogin() {
        try {
            await FirebaseService.signInWithGoogle();
        } catch (e) {
            this.showBanner('Google girişi başarısız: ' + e.message, 'error');
        }
    },

    async _handleSignOut() {
        await FirebaseService.signOut();
    },

    _updateAuthUI() {
        const isAnon = FirebaseService.isAnonymous();
        const configured = FirebaseService.isConfigured();
        const user = FirebaseService.getUser();

        const googleBtn = document.getElementById('btn-google-login');
        const signOutBtn = document.getElementById('btn-sign-out');
        const guestBadge = document.getElementById('auth-guest-badge');
        const userInfo = document.getElementById('auth-user-info');
        const avatar = document.getElementById('auth-avatar');
        const displayName = document.getElementById('auth-display-name');

        const settingsGoogleBtn = document.getElementById('settings-btn-google');
        const settingsSignOutBtn = document.getElementById('settings-btn-signout');
        const settingsAuthStatus = document.getElementById('settings-auth-status');

        if (!configured) {
            googleBtn.style.display = 'none';
            signOutBtn.style.display = 'none';
            guestBadge.style.display = 'none';
            userInfo.style.display = 'none';
            settingsGoogleBtn.style.display = 'none';
            settingsSignOutBtn.style.display = 'none';
            if (settingsAuthStatus) settingsAuthStatus.textContent = 'Firebase yapılandırılmamış.';
            return;
        }

        if (!user || isAnon) {
            googleBtn.style.display = 'inline-flex';
            signOutBtn.style.display = 'none';
            guestBadge.style.display = 'inline-block';
            userInfo.style.display = 'none';
            settingsGoogleBtn.style.display = 'inline-flex';
            settingsSignOutBtn.style.display = 'none';
            if (settingsAuthStatus) settingsAuthStatus.textContent = 'Misafir olarak kullanıyorsunuz. Google ile giriş yaparak verilerinizi bulutta saklayabilirsiniz.';
        } else {
            googleBtn.style.display = 'none';
            signOutBtn.style.display = 'inline-flex';
            guestBadge.style.display = 'none';

            const photo = FirebaseService.getUserPhotoURL();
            const name = FirebaseService.getUserDisplayName();
            if (photo) {
                avatar.src = photo;
                userInfo.style.display = 'flex';
            } else {
                userInfo.style.display = 'none';
            }
            displayName.textContent = name || '';

            settingsGoogleBtn.style.display = 'none';
            settingsSignOutBtn.style.display = 'inline-flex';
            if (settingsAuthStatus) settingsAuthStatus.textContent = (name || user.email || 'Google hesabı') + ' ile giriş yapıldı.';
        }
    },

    _renderSyncBadge(state) {
        const dot = document.getElementById('sync-dot');
        const label = document.getElementById('sync-label');
        if (!dot || !label) return;

        dot.className = 'sync-dot ' + state;
        const labels = {
            idle: 'Yerel',
            loading: 'Yükleniyor...',
            saving: 'Kaydediliyor...',
            synced: 'Bulut senkron',
            error: 'Senkron hatası',
            disabled: 'Sadece yerel'
        };
        label.textContent = labels[state] || state;
    },

    _updateStorageUsage() {
        const el = document.getElementById('storage-usage-text');
        if (el) el.textContent = 'Kullanım: ' + StorageService.getStorageUsageKB() + ' KB';
    },

    openConfirm(title, message, action) {
        document.getElementById('confirm-modal-title').textContent = title;
        document.getElementById('confirm-modal-message').textContent = message;
        this.state.confirmAction = action;
        document.getElementById('confirm-modal').classList.add('open');
    },
    closeConfirm() {
        document.getElementById('confirm-modal').classList.remove('open');
        this.state.confirmAction = null;
    },
    openEditModal(asset) {
        this.state.editingAssetId = asset.id;
        document.getElementById('edit-asset-quantity').value = String(asset.multiplier || 1);
        document.getElementById('edit-asset-modal').classList.add('open');
    },
    closeEditModal() {
        document.getElementById('edit-asset-modal').classList.remove('open');
        this.state.editingAssetId = null;
    },

    submitEditAsset(e) {
        e.preventDefault();
        const id = this.state.editingAssetId;
        const asset = this.state.assets.find(a => a.id === id);
        if (!asset) return this.closeEditModal();
        const parsed = parseFloat(document.getElementById('edit-asset-quantity').value);
        if (!isFinite(parsed) || parsed <= 0) {
            this.showBanner('Geçersiz miktar. 0 dan büyük sayı girin.', 'warning');
            return;
        }
        asset.multiplier = parsed;
        StorageService.saveAssets(this.state.assets);
        this._triggerCloudSync();
        this.closeEditModal();
        this.showBanner(asset.name + ' miktarı güncellendi.', 'ok');
        this.updateUI();
    },

    // ── Add / Remove Asset ─────────────────────────────────
    async handleAddAsset() {
        const nameInput = document.getElementById('asset-name');
        const typeInput = document.getElementById('asset-type');
        const qtyInput = document.getElementById('asset-quantity');

        const symbol = nameInput.value.trim().toUpperCase();
        const type = typeInput.value;

        if (!symbol) return;

        const newAsset = {
            id: 'asset_' + Date.now(),
            name: symbol,
            symbol: symbol,
            type: type,
            removable: true,
            multiplier: parseFloat(qtyInput.value) || 1,
            currentPrice: null
        };

        this.state.assets.push(newAsset);
        const submitBtn = document.getElementById('submit-add-asset-btn');
        submitBtn.disabled = true;
        submitBtn.classList.add('loading');

        const result = await PriceService.getPrice(newAsset);
        if (result.ok) {
            newAsset.currentPrice = result.price;
            StorageService.addPriceSnapshot(newAsset.id, result.price);
            this.state.assetData[newAsset.id] = {
                price: result.price, status: 'real',
                source: result.source, lastUpdate: Date.now(),
                change24h: result.change24h ?? null
            };
            await this._backfillHistory(newAsset);
        } else {
            this.state.assetData[newAsset.id] = {
                price: null, status: 'unavailable',
                source: null, lastUpdate: null, reason: result.reason
            };
            this.showBanner(symbol + ' için fiyat alınamadı: ' + result.reason, 'warning');
        }

        StorageService.saveAssets(this.state.assets);
        this._triggerCloudSync();
        document.getElementById('add-asset-modal').classList.remove('open');
        document.getElementById('add-asset-form').reset();
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');

        this.state.dataStatus.total = this.state.assets.length;
        this.renderStatusBanner();
        this.updateUI();
    },

    removeAsset(id) {
        const asset = this.state.assets.find(a => a.id === id);
        if (!asset) return;
        this.openConfirm('Varlık silinsin mi?', asset.name + ' portföyden kaldırılacak.', () => {
            this.state.assets = this.state.assets.filter(a => a.id !== id);
            delete this.state.assetData[id];
            StorageService.removeHistory(id);
            if (this.state.activeAssetId === id) {
                this.state.activeAssetId = this.state.assets[0]?.id || null;
            }
            StorageService.saveAssets(this.state.assets);
            this._triggerCloudSync();
            this.state.dataStatus.total = this.state.assets.length;
            this.updateUI();
        });
    },

    editAsset(id) {
        const asset = this.state.assets.find(a => a.id === id);
        if (!asset) return;
        this.openEditModal(asset);
    },

    setActive(id) {
        this.state.activeAssetId = id;
        this.renderChart().catch(e => console.warn('Chart render hatasi:', e));
    },

    // ── UI Rendering ───────────────────────────────────────
    updateUI() {
        this.renderSummary();
        this.renderDistributionChart();
        this.renderTable();
        this.renderChart().catch(e => console.warn('Chart render hatasi:', e));
        this.updateRangeButtons();
        this.updateTabCounts();
        this._updateRefreshCountdown();
        this._updateStorageUsage();
    },

    renderSummary() {
        let totalVal = 0;
        let dayChangeTotal = 0;
        let totalPrevVal = 0;
        let bestPct = -Infinity;
        let bestName = '';
        let hasAnyData = false;

        this.state.assets.forEach(asset => {
            const info = this.state.assetData[asset.id];
            if (!info || info.price == null) return;
            hasAnyData = true;

            const mult = asset.multiplier || 1;
            const current = info.price;
            totalVal += current * mult;

            const history = StorageService.getHistory(asset.id);
            const dayChange = Utils.getChangeFromHistory(history, 1) ?? info.change24h ?? null;
            if (dayChange !== null) {
                const prevPrice = current / (1 + dayChange / 100);
                dayChangeTotal += (current - prevPrice) * mult;
                totalPrevVal += prevPrice * mult;

                if (dayChange > bestPct) {
                    bestPct = dayChange;
                    bestName = asset.name;
                }
            } else {
                totalPrevVal += current * mult;
            }
        });

        const totalChangePct = totalPrevVal > 0 ? (dayChangeTotal / totalPrevVal) * 100 : 0;

        const totalCard = document.getElementById('card-total-value');
        totalCard.querySelector('.card-value').textContent = hasAnyData ? Utils.formatCurrency(totalVal, 0) : '\u2014';
        const totalTrend = totalCard.querySelector('.card-trend');
        if (hasAnyData && totalPrevVal > 0 && dayChangeTotal !== 0) {
            totalTrend.textContent = (totalChangePct >= 0 ? '\u25B2' : '\u25BC') + ' ' + Utils.formatPercent(totalChangePct);
            totalTrend.className = 'card-trend ' + (totalChangePct >= 0 ? 'up' : 'down');
        } else {
            totalTrend.textContent = hasAnyData ? 'Degisim verisi birikmekte' : 'Veri bekleniyor...';
            totalTrend.className = 'card-trend neutral';
        }

        const changeCard = document.getElementById('card-daily-change');
        changeCard.querySelector('.card-value').textContent =
            dayChangeTotal !== 0 ? Utils.formatCurrency(dayChangeTotal, 0) : '\u2014';
        const dailyTrend = document.getElementById('daily-trend-pct');
        if (dayChangeTotal !== 0) {
            dailyTrend.textContent = Utils.formatPercent(totalChangePct);
            dailyTrend.className = 'card-trend ' + (totalChangePct >= 0 ? 'up' : 'down');
        } else {
            dailyTrend.textContent = '--';
            dailyTrend.className = 'card-trend neutral';
        }

        const bestCard = document.getElementById('card-best-performer');
        bestCard.querySelector('.card-value').textContent = bestName || '\u2014';
        const bestTrend = document.getElementById('best-asset-pct');
        bestTrend.textContent = bestName ? Utils.formatPercent(bestPct) : '--';
        bestTrend.className = 'card-trend ' + (bestPct > 0 ? 'up' : 'neutral');

        document.getElementById('card-total-assets').querySelector('.card-value').textContent =
            this.state.assets.length;
        this._renderSummarySparkline('card-total-value');
        this._renderSummarySparkline('card-daily-change');
        this._renderSummarySparkline('card-best-performer');
        this._renderSummarySparkline('card-total-assets');
    },

    renderTable() {
        const tbody = document.getElementById('assets-table-body');
        tbody.innerHTML = '';
        const rows = this.state.assets
            .filter(a => this.state.activeFilter === 'all' || a.type === this.state.activeFilter)
            .filter(a => {
                if (!this.state.searchTerm) return true;
                return a.name.toLowerCase().includes(this.state.searchTerm) ||
                    a.symbol.toLowerCase().includes(this.state.searchTerm);
            })
            .map(asset => {
                const info = this.state.assetData[asset.id];
                const history = this._getRenderableHistory(asset.id, info);
                const p1 = Utils.getChangeFromHistory(history, 1) ?? info?.change24h ?? null;
                const p30 = Utils.getChangeFromHistory(history, 30);
                const p365 = Utils.getChangeFromHistory(history, 365);
                return { asset, info, history, price: info?.price, p1, p30, p365 };
            });
        const sorted = this._sortRows(rows);

        if (sorted.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><h4>Varlık bulunamadı</h4><p>İlk varlığınızı ekleyerek başlayın veya aramayı temizleyin.</p></div></td></tr>';
            return;
        }

        sorted.forEach(row => {
            const { asset, info, history, price, p1, p30, p365 } = row;
            const statusBadge = this._statusBadge(info);

            const tr = document.createElement('tr');
            if (asset.id === this.state.activeAssetId) tr.classList.add('row-active');
            tr.innerHTML =
                '<td>' +
                    '<div class="asset-cell">' +
                        '<div class="asset-icon">' + Utils.getAssetIcon(asset.type) + '</div>' +
                        '<div class="asset-info">' +
                            '<span class="asset-name" style="font-weight:600">' + asset.name + '</span>' +
                            '<span class="asset-symbol">' + asset.symbol + ' x' + (asset.multiplier || 1) + ' ' + statusBadge + '</span>' +
                        '</div>' +
                    '</div>' +
                '</td>' +
                '<td class="price-cell">' + (price != null ? Utils.formatCurrency(price) : '<span class="no-data">Veri yok</span>') + '</td>' +
                '<td class="' + (p1 != null ? (p1 >= 0 ? 'up' : 'down') : '') + '">' + (p1 != null ? Utils.formatPercent(p1) : '<span class="no-data">--</span>') + '</td>' +
                '<td class="' + (p30 != null ? (p30 >= 0 ? 'up' : 'down') : '') + '">' + (p30 != null ? Utils.formatPercent(p30) : '<span class="no-data">--</span>') + '</td>' +
                '<td class="' + (p365 != null ? (p365 >= 0 ? 'up' : 'down') : '') + '">' + (p365 != null ? Utils.formatPercent(p365) : '<span class="no-data">--</span>') + '</td>' +
                '<td><div style="width:60px;height:20px"><canvas class="mini-chart"></canvas></div></td>' +
                '<td class="action-cell">' +
                    '<button class="btn-icon" title="Grafik" onclick="PortfolioApp.setActive(\'' + asset.id + '\')">' + Utils.icons.hisse + '</button>' +
                    '<button class="btn-icon" title="Miktar Düzenle" onclick="PortfolioApp.editAsset(\'' + asset.id + '\')">' + Utils.icons.edit + '</button>' +
                    (asset.removable ? '<button class="btn-icon btn-icon-danger" title="Sil" onclick="PortfolioApp.removeAsset(\'' + asset.id + '\')">' + Utils.icons.trash + '</button>' : '') +
                '</td>';

            tr.style.cursor = 'pointer';
            tr.onclick = (e) => {
                if (e.target.closest('.btn-icon')) return;
                this.setActive(asset.id);
            };

            tbody.appendChild(tr);

            this._renderMiniChart(tr.querySelector('.mini-chart'), history);
        });
    },

    _sortRows(rows) {
        const key = this.state.sortKey;
        if (!key) return rows;
        const dir = this.state.sortDir === 'asc' ? 1 : -1;
        return rows.slice().sort((a, b) => {
            const av = a[key];
            const bv = b[key];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return (av - bv) * dir;
        });
    },

    _statusBadge(info) {
        if (!info) return '<span class="data-badge badge-unavailable">Bilinmiyor</span>';
        if (info.status === 'real') {
            const histLabel = info.histStatus === 'partial' ? ' (Gecmis Kismi)' : '';
            return '<span class="data-badge badge-real" title="' + info.source + histLabel + '">' + Utils.icons.checkCircle + '</span>';
        }
        if (info.status === 'stale')
            return '<span class="data-badge badge-stale" title="' + Utils.timeAgo(info.lastUpdate) + '">' + Utils.icons.alertTriangle + '</span>';
        return '<span class="data-badge badge-unavailable" title="' + (info.reason || '') + '">' + Utils.icons.xCircle + '</span>';
    },

    _renderMiniChart(canvas, history) {
        if (!canvas || !history || history.length < 2) return;
        const ctx = canvas.getContext('2d');
        const recent = history.slice(-30);
        const prices = recent.map(p => p.price);
        const w = canvas.width = canvas.parentElement.offsetWidth || 60;
        const h = canvas.height = 20;
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const range = max - min || 1;
        const isUp = prices[prices.length - 1] >= prices[0];

        ctx.strokeStyle = isUp ? '#10b981' : '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        prices.forEach((p, i) => {
            const x = (i / (prices.length - 1)) * w;
            const y = h - ((p - min) / range) * (h - 4) - 2;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
    },

    _renderSummarySparkline(cardId) {
        const card = document.getElementById(cardId);
        if (!card) return;
        let canvas = card.querySelector('.card-sparkline');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.className = 'card-sparkline';
            card.appendChild(canvas);
        }
        const points = this.state.assets
            .map(a => StorageService.getHistory(a.id))
            .filter(h => h.length > 1)
            .flatMap(h => h.slice(-12).map(p => p.price));
        if (points.length < 2) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width = card.clientWidth - 32;
        const h = canvas.height = 26;
        const min = Math.min(...points);
        const range = (Math.max(...points) - min) || 1;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#c9a84c';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        points.forEach((p, i) => {
            const x = (i / (points.length - 1)) * w;
            const y = h - ((p - min) / range) * (h - 4) - 2;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
    },

    renderDistributionChart() {
        const canvas = document.getElementById('distribution-chart');
        if (!canvas) return;
        const rows = this.state.assets
            .map(a => {
                const p = this.state.assetData[a.id]?.price;
                const v = p != null ? p * (a.multiplier || 1) : 0;
                return { label: a.name, value: v };
            })
            .filter(r => r.value > 0);
        if (this.state.distributionChartInstance) this.state.distributionChartInstance.destroy();
        if (!rows.length) return;
        this.state.distributionChartInstance = new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: rows.map(r => r.label),
                datasets: [{ data: rows.map(r => r.value) }]
            },
            options: {
                plugins: { legend: { labels: { color: '#94a3b8' } } },
                maintainAspectRatio: false
            }
        });
    },

    updateTabCounts() {
        const counts = this.state.assets.reduce((acc, a) => {
            acc[a.type] = (acc[a.type] || 0) + 1;
            return acc;
        }, {});
        document.querySelectorAll('#asset-type-tabs .tab-btn').forEach(btn => {
            const key = btn.dataset.filter;
            const count = key === 'all' ? this.state.assets.length : (counts[key] || 0);
            const base = btn.textContent.split('(')[0].trim();
            btn.innerHTML = base + '<span class="tab-count">' + count + '</span>';
        });
    },

    _updateRefreshCountdown() {
        const el = document.getElementById('refresh-info');
        if (!el) return;
        const left = Math.max(0, Math.floor((this.state.nextRefreshAt - Date.now()) / 1000));
        const m = String(Math.floor(left / 60)).padStart(2, '0');
        const s = String(left % 60).padStart(2, '0');
        el.textContent = 'Sonraki yenileme: ' + m + ':' + s;
    },

    saveUserName() {
        const input = document.getElementById('settings-user-name');
        const result = StorageService.saveUserName(input.value);
        if (!result.ok) return this.showBanner(result.reason, 'warning');
        this.state.userName = StorageService.getUserName();
        this._applyUserName();
        this._triggerCloudSync();
        this.showBanner('Kullanıcı adı güncellendi.', 'ok');
    },

    // ── Chart ──────────────────────────────────────────────
    async renderChart() {
        const asset = this.state.assets.find(a => a.id === this.state.activeAssetId);
        if (!asset) {
            this._showChartEmpty('Varlık seçilmedi');
            return;
        }

        const info = this.state.assetData[asset.id];
        const rangeDays = this.ranges[this.state.activeRange];
        let history = this._getRenderableHistory(asset.id, info);
        history = Utils.filterHistoryByRange(history, rangeDays);
        history = Utils.downsample(history, 200);

        document.getElementById('chart-asset-name').textContent = asset.name;
        document.getElementById('chart-asset-price').textContent =
            info?.price != null ? Utils.formatCurrency(info.price) : '\u2014';

        if (history.length < 2) {
            const changeEl = document.getElementById('chart-asset-change');
            changeEl.textContent = '';
            changeEl.className = 'price-change neutral';
            document.getElementById('stat-open').textContent = '\u2014';
            document.getElementById('stat-high').textContent = '\u2014';
            document.getElementById('stat-low').textContent = '\u2014';
            document.getElementById('stat-avg').textContent = '\u2014';
            const realHist = StorageService.getHistory(asset.id);
            const msg = realHist.length === 0
                ? 'Bu varlik icin gecmis veri bulunamadi.'
                : 'Bu zaman araligi icin yeterli gecmis verisi yok.';
            this._showChartEmpty(msg);
            return;
        }

        const labels = history.map(p => {
            const d = new Date(p.ts);
            if (rangeDays <= 90) return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
            return d.toLocaleDateString('tr-TR', { month: 'short', year: '2-digit' });
        });
        const prices = history.map(p => p.price);

        const first = prices[0];
        const last = prices[prices.length - 1];
        const changePct = ((last - first) / first) * 100;

        const changeEl = document.getElementById('chart-asset-change');
        changeEl.textContent = (changePct >= 0 ? '\u25B2' : '\u25BC') + ' ' +
            Utils.formatPercent(changePct) + ' (Dönemlik)';
        changeEl.className = 'price-change ' + (changePct >= 0 ? 'up' : 'down');

        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        document.getElementById('stat-open').textContent = Utils.formatCurrency(first);
        document.getElementById('stat-high').textContent = Utils.formatCurrency(Math.max(...prices));
        document.getElementById('stat-low').textContent = Utils.formatCurrency(Math.min(...prices));
        document.getElementById('stat-avg').textContent = Utils.formatCurrency(avg);

        this._drawChart(labels, prices, asset.name, changePct >= 0);
    },

    _getRenderableHistory(assetId, info) {
        const history = StorageService.getHistory(assetId);
        // Sentetik seri üretme: yalnızca gerçek geçmiş göster.
        return history;
    },

    _drawChart(labels, prices, label, isUp) {
        const canvas = document.getElementById('main-chart');
        const overlay = canvas.parentElement.querySelector('.chart-empty-overlay');
        if (overlay) overlay.remove();

        const ctx = canvas.getContext('2d');

        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, isUp ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');

        if (this.state.chartInstance) this.state.chartInstance.destroy();

        this.state.chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label,
                    data: prices,
                    borderColor: isUp ? '#10b981' : '#ef4444',
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: isUp ? '#10b981' : '#ef4444',
                    pointHoverBorderColor: 'white',
                    pointHoverBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index', intersect: false,
                        backgroundColor: 'rgba(17,20,27,0.9)',
                        titleColor: '#94a3b8', bodyColor: '#f1f5f9',
                        borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
                        padding: 12, cornerRadius: 8,
                        titleFont: { family: 'Outfit', size: 12 },
                        bodyFont: { family: 'JetBrains Mono', size: 14 },
                        callbacks: { label: (c) => ' ' + Utils.formatCurrency(c.parsed.y) }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' }, maxTicksLimit: 8, maxRotation: 0 }
                    },
                    y: {
                        position: 'right',
                        grid: { color: 'rgba(255,255,255,0.03)' },
                        ticks: {
                            color: '#64748b', font: { size: 10, family: 'JetBrains Mono' },
                            callback: (v) => Utils.formatCurrency(v, 0).replace('\u20BA', '')
                        }
                    }
                },
                interaction: { mode: 'index', intersect: false }
            }
        });
    },

    _showChartEmpty(msg) {
        if (this.state.chartInstance) { this.state.chartInstance.destroy(); this.state.chartInstance = null; }
        const canvas = document.getElementById('main-chart');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const container = canvas.parentElement;
        let overlay = container.querySelector('.chart-empty-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'chart-empty-overlay';
            container.style.position = 'relative';
            container.appendChild(overlay);
        }
        overlay.innerHTML = '<div class="chart-empty-content">' +
            Utils.icons.noData +
            '<p>' + msg + '</p></div>';
    },

    // ── Clock ──────────────────────────────────────────────
    startClock() {
        const el = document.getElementById('current-date');
        const update = () => {
            el.textContent = new Date().toLocaleDateString('tr-TR', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            this._updateRefreshCountdown();
        };
        update();
        setInterval(update, 1000);
    },

    // ── View Switching ─────────────────────────────────────
    switchView(view) {
        this.state.activeView = view;
        document.querySelectorAll('.view-panel').forEach(panel => panel.classList.remove('active'));
        const dashboardPanel = document.getElementById('view-dashboard');
        const settingsPanel = document.getElementById('view-settings');
        if (view === 'settings') settingsPanel.classList.add('active');
        else dashboardPanel.classList.add('active');

        const title = document.querySelector('.top-bar h2');
        const subtitle = document.querySelector('.top-bar p');
        const addBtn = document.getElementById('add-asset-btn');
        const summary = document.querySelector('.summary-grid');
        const chart = document.querySelector('.chart-section');
        const assets = document.querySelector('.assets-section');
        const distribution = document.querySelector('.portfolio-distribution');
        if (view === 'dashboard') {
            title.innerHTML = 'Hoş Geldiniz, <span id="user-name"></span>';
            subtitle.style.display = 'block';
            addBtn.style.display = 'flex';
            summary.style.display = 'grid';
            chart.style.display = 'block';
            distribution.style.display = 'block';
            assets.style.display = 'block';
            this._applyUserName();
        } else if (view === 'assets') {
            title.textContent = 'Varlıklarım';
            subtitle.style.display = 'none';
            addBtn.style.display = 'flex';
            summary.style.display = 'none';
            chart.style.display = 'none';
            distribution.style.display = 'none';
            assets.style.display = 'block';
        } else {
            title.textContent = 'Ayarlar';
            subtitle.style.display = 'none';
            addBtn.style.display = 'none';
            summary.style.display = 'none';
            chart.style.display = 'none';
            distribution.style.display = 'none';
            assets.style.display = 'none';
            this._populateSupportedSymbols();
            this._applyUserName();
            this._updateAuthUI();
            this._updateStorageUsage();
            PriceService.checkHealth().then(h => this._renderHealthResults(h));
        }
    },

    _renderHealthResults(health) {
        const grid = document.getElementById('provider-health');
        if (!grid) return;
        const providers = [
            { key: 'truncgil', name: 'Truncgil Finans', desc: 'Emtia, Döviz' },
            { key: 'metalsLive', name: 'MetalsLive', desc: 'Emtia (Yedek)' },
            { key: 'coingecko', name: 'CoinGecko', desc: 'Kripto' },
            { key: 'binance', name: 'Binance', desc: 'Kripto (Yedek)' },
            { key: 'openExchange', name: 'OpenExchange', desc: 'Döviz (Yedek)' },
            { key: 'stooq', name: 'Stooq', desc: 'Hisse/Fon (Yedek)' },
            { key: 'tefasProxy', name: 'TEFAS Fon', desc: 'Türk Fon Kodları' }
        ];
        grid.innerHTML = providers.map(p => {
            const status = health[p.key];
            const isUnknown = status == null;
            const ok = status === true;
            const cls = isUnknown ? 'provider-unknown' : (ok ? 'provider-ok' : 'provider-down');
            const icon = isUnknown ? Utils.icons.alertTriangle : (ok ? Utils.icons.checkCircle : Utils.icons.xCircle);
            const badge = isUnknown ? 'Zaman Asimi' : (ok ? 'Aktif' : 'Erisilemez');
            return '<div class="provider-card ' + cls + '">' +
                '<div class="provider-status-icon">' + icon + '</div>' +
                '<strong>' + p.name + '</strong><br><small>' + p.desc + '</small>' +
                '<div class="provider-badge">' + badge + '</div></div>';
        }).join('');
    },

    _populateSupportedSymbols() {
        const el = document.getElementById('supported-symbols');
        if (!el) return;
        const info = PriceService.getSupportedInfo();
        const typeNames = { emtia: 'Emtia', kripto: 'Kripto', doviz: 'Döviz', hisse: 'Hisse', fon: 'Fon' };
        el.innerHTML = Object.entries(info).map(([type, data]) => {
            const symbols = data.symbols.length > 0
                ? data.symbols.join(', ')
                : (data.note || 'Otomatik eşleme ile desteklenir');
            return '<div class="symbol-group">' +
                '<strong>' + (typeNames[type] || type) + '</strong>' +
                '<span class="symbol-providers">' + data.providers.join(', ') + '</span>' +
                '<span class="symbol-list">' + symbols + '</span></div>';
        }).join('');
    },

    resetApp() {
        this.state.assets = StorageService.reset();
        this.state.assetData = {};
        this.state.userName = StorageService.getUserName();
        this.state.activeAssetId = this.state.assets[0]?.id || null;
        this.state.dataStatus = { total: 0, real: 0, stale: 0, unavailable: 0 };
        this._triggerCloudSync();
        this.syncRealPrices().then(() => this.updateUI());
        this.switchView('dashboard');
        document.getElementById('nav-dashboard').click();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    PortfolioApp.init();
});
