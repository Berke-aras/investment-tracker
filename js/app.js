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
        activeView: 'dashboard',
        chartInstance: null,
        isLoading: false,
        dataStatus: { total: 0, real: 0, stale: 0, unavailable: 0 }
    },

    ranges: {
        '1A': 30, '3A': 90, '6A': 180, '1Y': 365, '3Y': 1095, '5Y': 1825
    },

    // ── Bootstrap ──────────────────────────────────────────
    async init() {
        this.state.assets = StorageService.getAssets();
        this.state.activeAssetId = this.state.assets[0]?.id || null;

        StorageService.onError(msg => this.showBanner(msg, 'error'));

        this.setupEventListeners();
        this.renderStatusBanner('loading');
        await this.syncRealPrices();
        this.updateUI();
        this.startClock();
        this._refreshTimer = setInterval(() => this.syncRealPrices().then(() => this.updateUI()), 300000);
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
        this.renderStatusBanner();
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
    },

    updateRangeButtons() {
        document.querySelectorAll('.range-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.range === this.state.activeRange);
        });
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
        document.getElementById('add-asset-modal').classList.remove('open');
        document.getElementById('add-asset-form').reset();

        this.state.dataStatus.total = this.state.assets.length;
        this.renderStatusBanner();
        this.updateUI();
    },

    removeAsset(id) {
        this.state.assets = this.state.assets.filter(a => a.id !== id);
        delete this.state.assetData[id];
        StorageService.removeHistory(id);
        if (this.state.activeAssetId === id) {
            this.state.activeAssetId = this.state.assets[0]?.id || null;
        }
        StorageService.saveAssets(this.state.assets);
        this.state.dataStatus.total = this.state.assets.length;
        this.updateUI();
    },

    editAsset(id) {
        const asset = this.state.assets.find(a => a.id === id);
        if (!asset) return;

        const current = asset.multiplier || 1;
        const input = prompt(asset.name + ' icin yeni miktar/carpan degeri girin:', String(current));
        if (input === null) return;

        const parsed = parseFloat(String(input).replace(',', '.'));
        if (!isFinite(parsed) || parsed <= 0) {
            this.showBanner('Gecersiz miktar. 0 dan buyuk sayi girin.', 'warning');
            return;
        }

        asset.multiplier = parsed;
        StorageService.saveAssets(this.state.assets);
        this.showBanner(asset.name + ' miktari guncellendi.', 'ok');
        this.updateUI();
    },

    setActive(id) {
        this.state.activeAssetId = id;
        this.renderChart().catch(e => console.warn('Chart render hatasi:', e));
    },

    // ── UI Rendering ───────────────────────────────────────
    updateUI() {
        this.renderSummary();
        this.renderTable();
        this.renderChart().catch(e => console.warn('Chart render hatasi:', e));
        this.updateRangeButtons();
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
    },

    renderTable() {
        const tbody = document.getElementById('assets-table-body');
        tbody.innerHTML = '';

        const filtered = this.state.assets.filter(a =>
            this.state.activeFilter === 'all' || a.type === this.state.activeFilter
        );

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:3rem;color:var(--text-muted)">' +
                'Henüz varlık eklenmedi.</td></tr>';
            return;
        }

        filtered.forEach(asset => {
            const info = this.state.assetData[asset.id];
            const price = info?.price;
            const history = this._getRenderableHistory(asset.id, info);
            const p1 = Utils.getChangeFromHistory(history, 1) ?? info?.change24h ?? null;
            const p30 = Utils.getChangeFromHistory(history, 30);
            const p365 = Utils.getChangeFromHistory(history, 365);

            const statusBadge = this._statusBadge(info);

            const tr = document.createElement('tr');
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
        };
        update();
        setInterval(update, 1000);
    },

    // ── View Switching ─────────────────────────────────────
    switchView(view) {
        this.state.activeView = view;
        const main = document.querySelector('.main-content');
        const injected = document.getElementById('injected-view');
        if (injected) injected.remove();

        const overlay = document.querySelector('.chart-empty-overlay');
        if (overlay) overlay.remove();

        if (view === 'dashboard') {
            main.querySelector('.summary-grid').style.display = 'grid';
            main.querySelector('.chart-section').style.display = 'block';
            main.querySelector('.assets-section').style.display = 'block';
            main.querySelector('.top-bar h2').innerHTML = 'Hos Geldiniz, <span id="user-name">Yatırımcı</span>';
            main.querySelector('.top-bar p').style.display = 'block';
            document.getElementById('add-asset-btn').style.display = 'flex';
            this.updateUI();
        } else if (view === 'assets') {
            main.querySelector('.summary-grid').style.display = 'none';
            main.querySelector('.chart-section').style.display = 'none';
            main.querySelector('.assets-section').style.display = 'block';
            main.querySelector('.top-bar h2').textContent = 'Varlıklarım';
            main.querySelector('.top-bar p').style.display = 'none';
            document.getElementById('add-asset-btn').style.display = 'flex';
        } else if (view === 'settings') {
            main.querySelector('.summary-grid').style.display = 'none';
            main.querySelector('.chart-section').style.display = 'none';
            main.querySelector('.assets-section').style.display = 'none';
            main.querySelector('.top-bar h2').textContent = 'Ayarlar';
            main.querySelector('.top-bar p').style.display = 'none';
            document.getElementById('add-asset-btn').style.display = 'none';
            this._renderSettings(main);
        }
    },

    async _renderSettings(container) {
        const div = document.createElement('div');
        div.id = 'injected-view';
        div.className = 'glass-card';
        div.style.padding = '2.5rem';

        div.innerHTML =
            '<div class="settings-container">' +
                '<section style="margin-bottom:2rem">' +
                    '<h3 style="margin-bottom:1rem;color:var(--accent-primary)">Veri Sağlayıcı Durumu</h3>' +
                    '<div id="provider-health" class="provider-health-grid">' +
                        '<div class="provider-card loading">Truncgil Finans<br><small>Kontrol ediliyor...</small></div>' +
                        '<div class="provider-card loading">CoinGecko<br><small>Kontrol ediliyor...</small></div>' +
                        '<div class="provider-card loading">Binance<br><small>Kontrol ediliyor...</small></div>' +
                    '</div>' +
                '</section>' +
                '<hr style="border:0;border-top:1px solid var(--glass-border);margin-bottom:2rem">' +
                '<section style="margin-bottom:2rem">' +
                    '<h3 style="margin-bottom:1rem;color:var(--accent-primary)">Desteklenen Semboller</h3>' +
                    '<div id="supported-symbols" class="symbols-info"></div>' +
                '</section>' +
                '<hr style="border:0;border-top:1px solid var(--glass-border);margin-bottom:2rem">' +
                '<section style="margin-bottom:2rem">' +
                    '<h3 style="margin-bottom:1rem;color:var(--accent-primary)">Veri Yönetimi</h3>' +
                    '<p style="color:var(--text-secondary);margin-bottom:1.5rem">Uygulama verileri tarayıcınızın <code>localStorage</code> alanında saklanmaktadır.</p>' +
                    '<button class="btn btn-secondary" onclick="PortfolioApp.resetApp()" style="color:var(--down-color);border-color:var(--down-color)">Tüm Verileri Sıfırla</button>' +
                '</section>' +
                '<hr style="border:0;border-top:1px solid var(--glass-border);margin-bottom:2rem">' +
                '<section>' +
                    '<h3 style="margin-bottom:1rem">Uygulama Hakkında</h3>' +
                    '<p style="color:var(--text-secondary)">PortfolioTrack v2.0.0<br>Çoklu sağlayıcı ile gerçek veri entegrasyonu.</p>' +
                '</section>' +
            '</div>';

        container.appendChild(div);

        this._populateSupportedSymbols();
        const health = await PriceService.checkHealth();
        this._renderHealthResults(health);
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
        if (confirm('Tüm verileriniz silinecek ve varsayılana dönülecek. Onaylıyor musunuz?')) {
            this.state.assets = StorageService.reset();
            this.state.assetData = {};
            this.state.activeAssetId = this.state.assets[0]?.id || null;
            this.state.dataStatus = { total: 0, real: 0, stale: 0, unavailable: 0 };
            this.syncRealPrices().then(() => this.updateUI());
            this.switchView('dashboard');
            document.getElementById('nav-dashboard').click();
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    PortfolioApp.init();
});
