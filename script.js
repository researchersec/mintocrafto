class CraftingProPlatform {
    constructor() {
        this.auctionData = {};
        this.recipes = [];
        this.filteredRecipes = [];
        this.currentTab = 'overview';
        this.currentPage = 1;
        this.itemsPerPage = 50;
        this.sortBy = 'profit';
        this.sortOrder = 'desc';
        this.portfolio = JSON.parse(localStorage.getItem('craftingPortfolio') || '[]');
        this.alerts = JSON.parse(localStorage.getItem('priceAlerts') || '[]');
        this.customMaterialCosts = JSON.parse(localStorage.getItem('customMaterialCosts') || '{}');
        this.charts = {};
        
        this.init();
    }

    async init() {
        try {
            this.showLoading();
            await this.loadData();
            this.setupEventListeners();
            this.processData();
            this.updateUI();
            this.initializeCharts();
            this.hideLoading();
        } catch (error) {
            console.error('Failed to initialize platform:', error);
            this.showError('Failed to load data. Please refresh the page.');
            this.hideLoading();
        }
    }

    showLoading() {
        document.body.style.cursor = 'wait';
    }

    hideLoading() {
        document.body.style.cursor = 'default';
    }

    async loadData() {
        try {
            const [auctionResponse, recipesResponse] = await Promise.all([
                fetch('auctionprices.json'),
                fetch('recipes.json')
            ]);

            if (!auctionResponse.ok || !recipesResponse.ok) {
                throw new Error('Failed to fetch data');
            }

            const auctionData = await auctionResponse.json();
            const recipesData = await recipesResponse.json();

            // Create lookup map for auction data
            this.auctionData = {};
            auctionData.pricing_data.forEach(item => {
                this.auctionData[item.itemId] = item;
            });

            this.recipes = recipesData.recipes;
        } catch (error) {
            throw new Error('Failed to load data files');
        }
    }

    processData() {
        // First pass: calculate basic recipe data
        this.filteredRecipes = this.recipes.map(recipe => {
            const processedRecipe = { ...recipe };
            processedRecipe.materialDetails = recipe.materials.map(material => {
                const auctionInfo = this.auctionData[material.itemId];
                const marketCost = auctionInfo ? 
                    (auctionInfo.minBuyout > 0 ? auctionInfo.minBuyout : auctionInfo.marketValue) : 0;
                
                return {
                    ...material,
                    name: auctionInfo?.itemName || `Item ${material.itemId}`,
                    marketCost: marketCost,
                    craftingCost: null, // Will be calculated in second pass
                    unitCost: marketCost,
                    totalCost: marketCost * material.quantity,
                    available: auctionInfo?.quantity || 0
                };
            });
            
            return processedRecipe;
        });

        // Second pass: calculate crafting costs and optimize
        this.calculateOptimalCosts();
        
        this.sortRecipes();
    }

    calculateOptimalCosts() {
        // Create a map of item ID to recipe for quick lookup
        const itemToRecipe = new Map();
        this.filteredRecipes.forEach(recipe => {
            itemToRecipe.set(recipe.result_item_id, recipe);
        });

        // Calculate crafting costs for each recipe
        this.filteredRecipes.forEach(recipe => {
            let materialsCost = 0;
            let allMaterialsAvailable = true;

            recipe.materialDetails = recipe.materialDetails.map(material => {
                const craftingRecipe = itemToRecipe.get(material.itemId);
                let craftingCost = null;
                
                if (craftingRecipe) {
                    // Calculate the cost to craft this material
                    craftingCost = this.calculateRecipeCost(craftingRecipe, itemToRecipe, new Set([recipe.recipe_id]));
                }

                // Use the cheaper option: market price or crafting cost
                let optimalCost = material.marketCost;
                let costSource = 'market';
                
                if (craftingCost !== null && (craftingCost < material.marketCost || material.marketCost === 0)) {
                    optimalCost = craftingCost;
                    costSource = 'crafting';
                }

                // Check for custom cost override
                const customCostKey = `${material.itemId}`;
                if (this.customMaterialCosts[customCostKey] !== undefined) {
                    optimalCost = this.customMaterialCosts[customCostKey];
                    costSource = 'custom';
                }

                const totalCost = optimalCost * material.quantity;
                materialsCost += totalCost;
                
                if (!this.auctionData[material.itemId] || (material.marketCost === 0 && craftingCost === null)) {
                    allMaterialsAvailable = false;
                }
                
                return {
                    ...material,
                    unitCost: optimalCost,
                    craftingCost: craftingCost,
                    totalCost: totalCost,
                    costSource: costSource,
                    isCustomCost: costSource === 'custom',
                    savings: craftingCost !== null && costSource === 'crafting' ? 
                        (material.marketCost - craftingCost) * material.quantity : 0
                };
            });
            
            // Calculate result value and profit
            const resultInfo = this.auctionData[recipe.result_item_id];
            const resultValue = resultInfo ? 
                (resultInfo.minBuyout > 0 ? resultInfo.minBuyout : resultInfo.marketValue) : 0;
            const totalResultValue = resultValue * recipe.result_quantity;
            
            const profit = totalResultValue - materialsCost;
            const margin = materialsCost > 0 ? ((profit / materialsCost) * 100) : 0;
            const roi = materialsCost > 0 ? ((profit / materialsCost) * 100) : 0;
            
            recipe.materialsCost = materialsCost;
            recipe.resultValue = totalResultValue;
            recipe.profit = profit;
            recipe.margin = margin;
            recipe.roi = roi;
            recipe.allMaterialsAvailable = allMaterialsAvailable;
            recipe.resultName = resultInfo?.itemName || `Item ${recipe.result_item_id}`;
            recipe.trend = this.simulateTrend();
            recipe.volume = Math.floor(Math.random() * 100) + 1;
            recipe.totalSavings = recipe.materialDetails.reduce((sum, mat) => sum + mat.savings, 0);
        });
    }

    calculateRecipeCost(recipe, itemToRecipe, visitedRecipes = new Set()) {
        // Prevent infinite recursion
        if (visitedRecipes.has(recipe.recipe_id)) {
            return null;
        }
        
        visitedRecipes.add(recipe.recipe_id);
        let totalCost = 0;
        
        for (const material of recipe.materials) {
            const auctionInfo = this.auctionData[material.itemId];
            const marketCost = auctionInfo ? 
                (auctionInfo.minBuyout > 0 ? auctionInfo.minBuyout : auctionInfo.marketValue) : 0;
            
            // Check if this material can also be crafted
            const materialRecipe = itemToRecipe.get(material.itemId);
            let materialCost = marketCost;
            
            if (materialRecipe && !visitedRecipes.has(materialRecipe.recipe_id)) {
                const craftingCost = this.calculateRecipeCost(materialRecipe, itemToRecipe, new Set(visitedRecipes));
                if (craftingCost !== null && (craftingCost < marketCost || marketCost === 0)) {
                    materialCost = craftingCost;
                }
            }
            
            // Check for custom cost override
            const customCostKey = `${material.itemId}`;
            if (this.customMaterialCosts[customCostKey] !== undefined) {
                materialCost = this.customMaterialCosts[customCostKey];
            }
            
            if (materialCost === 0) {
                return null; // Can't calculate cost if material has no price
            }
            
            totalCost += materialCost * material.quantity;
        }
        
        // Return cost per unit of the result
        return totalCost / recipe.result_quantity;
    }

    simulateTrend() {
        const trends = ['up', 'down', 'stable'];
        const trend = trends[Math.floor(Math.random() * trends.length)];
        const change = (Math.random() * 20 - 10).toFixed(1); // -10% to +10%
        return { direction: trend, change: parseFloat(change) };
    }

    setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const tab = e.currentTarget.dataset.tab;
                if (tab) this.switchTab(tab);
            });
        });

        // Global search
        const globalSearch = document.getElementById('globalSearch');
        if (globalSearch) {
            globalSearch.addEventListener('input', (e) => this.handleGlobalSearch(e.target.value));
            globalSearch.addEventListener('focus', (e) => {
                if (e.target.value.length >= 2) {
                    this.handleGlobalSearch(e.target.value);
                }
            });
        }

        // Close search suggestions when clicking outside
        document.addEventListener('click', (e) => {
            const searchContainer = document.querySelector('.search-container');
            const suggestions = document.getElementById('searchSuggestions');
            if (searchContainer && !searchContainer.contains(e.target)) {
                suggestions.style.display = 'none';
            }
        });

        // Filters
        const professionFilter = document.getElementById('professionFilter');
        const minProfitFilter = document.getElementById('minProfitFilter');
        const sortBy = document.getElementById('sortBy');
        const resetFilters = document.getElementById('resetFilters');

        if (professionFilter) professionFilter.addEventListener('change', () => this.applyFilters());
        if (minProfitFilter) minProfitFilter.addEventListener('input', () => this.applyFilters());
        if (sortBy) sortBy.addEventListener('change', (e) => {
            this.sortBy = e.target.value;
            this.sortRecipes();
            this.updateTabContent();
        });
        if (resetFilters) resetFilters.addEventListener('click', () => this.resetFilters());

        // Table sorting
        document.querySelectorAll('.sortable').forEach(header => {
            header.addEventListener('click', (e) => {
                const sortField = e.currentTarget.dataset.sort;
                this.handleSort(sortField);
            });
        });

        // Pagination
        const prevPage = document.getElementById('prevPage');
        const nextPage = document.getElementById('nextPage');
        if (prevPage) prevPage.addEventListener('click', () => this.changePage(-1));
        if (nextPage) nextPage.addEventListener('click', () => this.changePage(1));

        // Calculator
        const calculateBtn = document.getElementById('calculateBtn');
        if (calculateBtn) calculateBtn.addEventListener('click', () => this.calculateProfit());

        // Modals
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal) this.closeModal(modal.id);
            });
        });

        // Portfolio
        const addToPortfolio = document.getElementById('addToPortfolio');
        if (addToPortfolio) addToPortfolio.addEventListener('click', () => this.showAddToPortfolioModal());

        // Alerts
        const createAlert = document.getElementById('createAlert');
        if (createAlert) createAlert.addEventListener('click', () => this.showCreateAlertModal());

        // Theme toggle
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) themeToggle.addEventListener('click', () => this.toggleTheme());

        // Window resize for responsive charts
        window.addEventListener('resize', () => this.resizeCharts());
    }

    handleGlobalSearch(query) {
        if (query.length < 2) {
            document.getElementById('searchSuggestions').style.display = 'none';
            return;
        }

        const suggestions = this.recipes
            .filter(recipe => recipe.name.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 5)
            .map(recipe => ({
                type: 'recipe',
                name: recipe.name,
                profession: recipe.profession,
                id: recipe.recipe_id
            }));

        // Add material suggestions
        const materials = Object.values(this.auctionData)
            .filter(item => item.itemName.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 3)
            .map(item => ({
                type: 'material',
                name: item.itemName,
                id: item.itemId
            }));

        this.showSearchSuggestions([...suggestions, ...materials]);
    }

    showSearchSuggestions(suggestions) {
        const container = document.getElementById('searchSuggestions');
        if (suggestions.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.innerHTML = suggestions.map(item => `
            <div class="suggestion-item" data-type="${item.type}" data-id="${item.id}">
                <div class="suggestion-name">${item.name}</div>
                <div class="suggestion-type">${item.type === 'recipe' ? item.profession : 'Material'}</div>
            </div>
        `).join('');
        
        // Add click event listeners to suggestion items
        container.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const type = item.dataset.type;
                const id = parseInt(item.dataset.id);
                console.log('Suggestion clicked:', type, id); // Debug log
                this.selectSuggestion(type, id);
            });
        });
        
        container.style.display = 'block';
    }

    selectSuggestion(type, id) {
        console.log('selectSuggestion called with:', type, id); // Debug log
        
        const suggestions = document.getElementById('searchSuggestions');
        suggestions.style.display = 'none';
        document.getElementById('globalSearch').value = '';
        
        if (type === 'recipe') {
            console.log('Switching to recipes tab'); // Debug log
            this.switchTab('recipes');
            // Wait for tab to load, then highlight the recipe
            setTimeout(() => {
                // First, make sure we process the data to have the recipe available
                this.processData();
                this.updateRecipesTable();
                
                // Find and highlight the recipe row
                const row = document.querySelector(`[data-recipe-id="${id}"]`);
                if (row) {
                    console.log('Found recipe row, highlighting'); // Debug log
                    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    row.style.background = 'rgba(59, 130, 246, 0.2)';
                    setTimeout(() => {
                        row.style.background = '';
                    }, 2000);
                } else {
                    console.log('Recipe row not found, showing modal'); // Debug log
                    // If not found in current page, try to find it in all recipes
                    const recipe = this.recipes.find(r => r.recipe_id === id);
                    if (recipe) {
                        // Show recipe details modal instead
                        this.showRecipeDetails(id);
                    }
                }
            }, 200);
        } else if (type === 'material') {
            console.log('Switching to materials tab'); // Debug log
            this.switchTab('materials');
            setTimeout(() => {
                this.updateMaterialsTable();
                // Could add highlighting for materials too if needed
            }, 200);
        }
    }

    switchTab(tabName) {
        // Update active nav item
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');

        // Update active tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(tabName)?.classList.add('active');

        this.currentTab = tabName;
        this.currentPage = 1; // Reset pagination
        this.updateTabContent();
    }

    updateTabContent() {
        switch (this.currentTab) {
            case 'overview':
                this.updateOverview();
                break;
            case 'recipes':
                this.updateRecipesTable();
                break;
            case 'materials':
                this.updateMaterialsTable();
                break;
            case 'trends':
                this.updateTrends();
                break;
            case 'calculator':
                this.updateCalculator();
                break;
            case 'portfolio':
                this.updatePortfolio();
                break;
            case 'alerts':
                this.updateAlerts();
                break;
        }
    }

    updateUI() {
        this.populateFilters();
        this.updateSidebarStats();
        this.updateTabContent();
    }

    populateFilters() {
        const professions = [...new Set(this.recipes.map(r => r.profession))].sort();
        const professionFilter = document.getElementById('professionFilter');
        const trendProfession = document.getElementById('trendProfession');
        
        [professionFilter, trendProfession].forEach(select => {
            if (select) {
                select.innerHTML = '<option value="">All Professions</option>';
                professions.forEach(profession => {
                    const option = document.createElement('option');
                    option.value = profession;
                    option.textContent = profession;
                    select.appendChild(option);
                });
            }
        });

        // Populate calculator recipe dropdown
        this.updateCalculatorRecipes();
    }

    updateSidebarStats() {
        const profitable = this.filteredRecipes.filter(r => r.profit > 0);
        const avgProfit = profitable.length > 0 ? 
            profitable.reduce((sum, r) => sum + r.profit, 0) / profitable.length : 0;
        const topMargin = this.filteredRecipes.length > 0 ? 
            Math.max(...this.filteredRecipes.map(r => r.margin)) : 0;

        const elements = {
            sidebarActiveRecipes: this.filteredRecipes.length,
            sidebarAvgProfit: this.formatCurrency(avgProfit),
            sidebarTopMargin: topMargin.toFixed(1) + '%'
        };

        Object.entries(elements).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.innerHTML = value;
        });
    }

    updateOverview() {
        const profitable = this.filteredRecipes.filter(r => r.profit > 0);
        const totalMarketValue = this.filteredRecipes.reduce((sum, r) => sum + r.resultValue, 0);
        const bestROI = this.filteredRecipes.length > 0 ? 
            Math.max(...this.filteredRecipes.map(r => r.roi)) : 0;

        // Update metric cards
        const metrics = {
            totalMarketValue: this.formatCurrency(totalMarketValue),
            profitableCount: profitable.length,
            bestROI: bestROI.toFixed(1) + '%'
        };

        Object.entries(metrics).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.innerHTML = value;
        });

        this.updateTopMovers();
        this.updateCharts();
    }

    updateTopMovers() {
        const topGainers = this.filteredRecipes
            .filter(r => r.trend.direction === 'up')
            .sort((a, b) => b.trend.change - a.trend.change)
            .slice(0, 5);

        const topLosers = this.filteredRecipes
            .filter(r => r.trend.direction === 'down')
            .sort((a, b) => a.trend.change - b.trend.change)
            .slice(0, 5);

        const mostActive = this.filteredRecipes
            .sort((a, b) => b.volume - a.volume)
            .slice(0, 5);

        this.renderMoversList('topGainers', topGainers, 'positive');
        this.renderMoversList('topLosers', topLosers, 'negative');
        this.renderMoversList('mostActive', mostActive, 'neutral');
    }

    renderMoversList(containerId, items, changeClass) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = items.map(item => `
            <div class="mover-item">
                <div class="mover-info">
                    <div class="mover-name">${item.name}</div>
                    <div class="mover-profession">
                        <span class="profession-badge" data-profession="${item.profession}">${item.profession}</span>
                    </div>
                </div>
                <div class="mover-change ${changeClass}">
                    ${changeClass === 'neutral' ? item.volume + ' vol' : 
                      (item.trend.change > 0 ? '+' : '') + item.trend.change + '%'}
                </div>
            </div>
        `).join('');
    }

    initializeCharts() {
        // Simple, fast HTML/CSS charts - no external dependencies
        this.createSimpleProfitChart();
        this.createSimpleTrendChart();
    }

    createSimpleProfitChart() {
        const container = document.getElementById('profitChart');
        if (!container) return;

        const professionData = this.getProfessionProfitData();
        const total = professionData.data.reduce((sum, val) => sum + val, 0);
        
        if (total === 0) {
            container.innerHTML = '<div class="no-chart-data">No profit data available</div>';
            return;
        }

        const colors = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];
        
        container.innerHTML = `
            <div class="profession-bars">
                ${professionData.labels.map((label, index) => {
                    const percentage = ((professionData.data[index] / total) * 100).toFixed(1);
                    return `
                        <div class="profession-bar">
                            <div class="bar-info">
                                <span class="profession-name">${label}</span>
                                <span class="profession-value">${this.formatCurrency(professionData.data[index])}</span>
                            </div>
                            <div class="bar-container">
                                <div class="bar-fill" style="width: ${percentage}%; background: ${colors[index % colors.length]}"></div>
                            </div>
                            <span class="bar-percentage">${percentage}%</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    createSimpleTrendChart() {
        const container = document.getElementById('trendsChart');
        if (!container) return;

        const trendData = this.getTrendData();
        const max = Math.max(...trendData.data);
        const min = Math.min(...trendData.data);
        const range = max - min || 1;

        container.innerHTML = `
            <div class="trend-chart">
                ${trendData.labels.map((label, index) => {
                    const value = trendData.data[index];
                    const height = ((value - min) / range) * 80 + 10; // 10-90% height
                    const isUp = index > 0 && value > trendData.data[index - 1];
                    const isDown = index > 0 && value < trendData.data[index - 1];
                    
                    return `
                        <div class="trend-bar">
                            <div class="trend-value" style="height: ${height}%; background: ${isUp ? '#10b981' : isDown ? '#ef4444' : '#6b7280'}"></div>
                            <div class="trend-label">${label}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    updateCharts() {
        // Update simple charts
        this.createSimpleProfitChart();
    }

    resizeCharts() {
        // No resize needed for CSS charts
    }

    getProfessionProfitData() {
        const professionProfits = {};
        this.filteredRecipes.forEach(recipe => {
            if (recipe.profit > 0) {
                professionProfits[recipe.profession] = 
                    (professionProfits[recipe.profession] || 0) + recipe.profit;
            }
        });

        return {
            labels: Object.keys(professionProfits),
            data: Object.values(professionProfits)
        };
    }

    getTrendData() {
        // Simulate 7 days of trend data
        const labels = [];
        const data = [];
        const baseValue = 1000000;
        
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            labels.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
            
            const variation = (Math.random() - 0.5) * 0.1; // ±5% variation
            data.push(baseValue * (1 + variation * i * 0.1));
        }
        
        return { labels, data };
    }

    updateRecipesTable() {
        const tbody = document.querySelector('#recipesTable tbody');
        if (!tbody) return;

        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = startIndex + this.itemsPerPage;
        const pageRecipes = this.filteredRecipes.slice(startIndex, endIndex);

        if (pageRecipes.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="no-data">No recipes found</td></tr>';
            return;
        }

        tbody.innerHTML = pageRecipes.map(recipe => `
            <tr data-recipe-id="${recipe.recipe_id}">
                <td>
                    <div class="recipe-name">${recipe.name}</div>
                    <div style="font-size: 12px; color: var(--text-muted);">${recipe.resultName}</div>
                </td>
                <td><span class="profession-badge" data-profession="${recipe.profession}">${recipe.profession}</span></td>
                <td><span class="skill-level">${recipe.skill_level}</span></td>
                <td>${this.formatCurrency(recipe.materialsCost)}</td>
                <td>${this.formatCurrency(recipe.resultValue)}</td>
                <td class="${this.getProfitClass(recipe.profit)}">${this.formatCurrency(recipe.profit)}</td>
                <td class="${this.getProfitClass(recipe.roi)}">${recipe.roi.toFixed(1)}%</td>
                <td>
                    <button class="btn btn-outline btn-sm" onclick="platform.showRecipeDetails(${recipe.recipe_id})">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="btn btn-outline btn-sm" onclick="platform.addToPortfolio(${recipe.recipe_id})">
                        <i class="fas fa-plus"></i>
                    </button>
                </td>
            </tr>
        `).join('');

        this.updatePagination();
        this.updateTableInfo();
    }

    updatePagination() {
        const totalPages = Math.ceil(this.filteredRecipes.length / this.itemsPerPage);
        
        const elements = {
            currentPage: this.currentPage,
            totalPages: totalPages,
            paginationStart: (this.currentPage - 1) * this.itemsPerPage + 1,
            paginationEnd: Math.min(this.currentPage * this.itemsPerPage, this.filteredRecipes.length),
            paginationTotal: this.filteredRecipes.length
        };

        Object.entries(elements).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        });

        // Update button states
        const prevBtn = document.getElementById('prevPage');
        const nextBtn = document.getElementById('nextPage');
        
        if (prevBtn) prevBtn.disabled = this.currentPage === 1;
        if (nextBtn) nextBtn.disabled = this.currentPage === totalPages;
    }

    updateTableInfo() {
        const tableRowCount = document.getElementById('tableRowCount');
        if (tableRowCount) {
            tableRowCount.textContent = `${this.filteredRecipes.length} recipes`;
        }
    }

    changePage(direction) {
        const totalPages = Math.ceil(this.filteredRecipes.length / this.itemsPerPage);
        const newPage = this.currentPage + direction;
        
        if (newPage >= 1 && newPage <= totalPages) {
            this.currentPage = newPage;
            this.updateRecipesTable();
        }
    }

    handleSort(field) {
        if (this.sortBy === field) {
            this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortBy = field;
            this.sortOrder = 'desc';
        }
        
        this.sortRecipes();
        this.updateTabContent();
        this.updateSortIndicators();
    }

    sortRecipes() {
        this.filteredRecipes.sort((a, b) => {
            let aVal = a[this.sortBy];
            let bVal = b[this.sortBy];
            
            if (typeof aVal === 'string') {
                aVal = aVal.toLowerCase();
                bVal = bVal.toLowerCase();
            }
            
            if (this.sortOrder === 'asc') {
                return aVal > bVal ? 1 : -1;
            } else {
                return aVal < bVal ? 1 : -1;
            }
        });
    }

    updateSortIndicators() {
        document.querySelectorAll('.sortable i').forEach(icon => {
            icon.className = 'fas fa-sort';
        });
        
        const activeHeader = document.querySelector(`[data-sort="${this.sortBy}"] i`);
        if (activeHeader) {
            activeHeader.className = this.sortOrder === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
        }
    }

    applyFilters() {
        const profession = document.getElementById('professionFilter')?.value || '';
        const minProfit = parseFloat(document.getElementById('minProfitFilter')?.value) || 0;

        this.processData(); // Reprocess to get fresh data
        
        this.filteredRecipes = this.filteredRecipes.filter(recipe => {
            if (profession && recipe.profession !== profession) return false;
            if (recipe.profit < minProfit) return false;
            return true;
        });

        this.sortRecipes();
        this.currentPage = 1; // Reset to first page
        this.updateTabContent();
        this.updateSidebarStats();
    }

    resetFilters() {
        const professionFilter = document.getElementById('professionFilter');
        const minProfitFilter = document.getElementById('minProfitFilter');
        const sortBy = document.getElementById('sortBy');
        
        if (professionFilter) professionFilter.value = '';
        if (minProfitFilter) minProfitFilter.value = '';
        if (sortBy) sortBy.value = 'profit';
        
        this.sortBy = 'profit';
        this.sortOrder = 'desc';
        this.currentPage = 1;
        
        this.processData();
        this.updateTabContent();
        this.updateSidebarStats();
    }

    updateMaterialsTable() {
        const materials = new Map();
        
        // Collect all materials and their usage
        this.recipes.forEach(recipe => {
            recipe.materials.forEach(material => {
                const auctionInfo = this.auctionData[material.itemId];
                const key = material.itemId;
                
                if (!materials.has(key)) {
                    materials.set(key, {
                        itemId: material.itemId,
                        name: auctionInfo?.itemName || `Item ${material.itemId}`,
                        marketValue: auctionInfo?.marketValue || 0,
                        minBuyout: auctionInfo?.minBuyout || 0,
                        quantity: auctionInfo?.quantity || 0,
                        usedInRecipes: [],
                        demand: 0,
                        trend: this.simulateTrend()
                    });
                }
                
                const materialData = materials.get(key);
                materialData.usedInRecipes.push(recipe.name);
                materialData.demand += material.quantity;
            });
        });

        const tbody = document.querySelector('#materialsTable tbody');
        if (!tbody) return;

        const sortedMaterials = Array.from(materials.values()).sort((a, b) => b.marketValue - a.marketValue);
        
        // Update summary stats
        const totalMaterials = document.getElementById('totalMaterials');
        if (totalMaterials) totalMaterials.textContent = sortedMaterials.length;

        tbody.innerHTML = sortedMaterials.map(material => `
            <tr>
                <td>
                    <div class="recipe-name">${material.name}</div>
                    <div style="font-size: 12px; color: var(--text-muted);">ID: ${material.itemId}</div>
                </td>
                <td>${this.formatCurrency(material.marketValue)}</td>
                <td>${this.formatCurrency(material.minBuyout)}</td>
                <td><span class="quantity-badge">${material.quantity}</span></td>
                <td>
                    <div>${material.demand} needed</div>
                    <div style="font-size: 12px; color: var(--text-muted);">${material.usedInRecipes.length} recipes</div>
                </td>
                <td class="${material.trend.direction === 'up' ? 'positive' : material.trend.direction === 'down' ? 'negative' : 'neutral'}">
                    <i class="fas fa-arrow-${material.trend.direction === 'up' ? 'up' : material.trend.direction === 'down' ? 'down' : 'right'}"></i>
                    ${material.trend.change > 0 ? '+' : ''}${material.trend.change}%
                </td>
                <td>
                    <button class="btn btn-outline btn-sm" onclick="platform.createMaterialAlert(${material.itemId})">
                        <i class="fas fa-bell"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    updateTrends() {
        const trendingUp = this.filteredRecipes
            .filter(r => r.trend.direction === 'up')
            .sort((a, b) => b.trend.change - a.trend.change)
            .slice(0, 10);

        const trendingDown = this.filteredRecipes
            .filter(r => r.trend.direction === 'down')
            .sort((a, b) => a.trend.change - b.trend.change)
            .slice(0, 10);

        const stableMarkets = this.filteredRecipes
            .filter(r => r.trend.direction === 'stable')
            .sort((a, b) => b.profit - a.profit)
            .slice(0, 10);

        this.renderTrendList('trendingUp', trendingUp);
        this.renderTrendList('trendingDown', trendingDown);
        this.renderTrendList('stableMarkets', stableMarkets);
    }

    renderTrendList(containerId, items) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = items.map(item => `
            <div class="trend-item">
                <div class="trend-info">
                    <div class="trend-name">${item.name}</div>
                    <div class="trend-profession">${item.profession}</div>
                </div>
                <div class="trend-value">
                    ${this.formatCurrency(item.profit)}
                </div>
            </div>
        `).join('');
    }

    updateCalculator() {
        this.updateCalculatorRecipes();
    }

    updateCalculatorRecipes() {
        const select = document.getElementById('calcRecipe');
        if (!select) return;

        select.innerHTML = '<option value="">Select a recipe...</option>';
        
        this.filteredRecipes
            .filter(r => r.profit > 0)
            //.slice(0, 100) // Limit for performance
            .forEach(recipe => {
                const option = document.createElement('option');
                option.value = recipe.recipe_id;
                option.textContent = `${recipe.name}`;
                select.appendChild(option);
            });
    }

    calculateProfit() {
        const recipeId = parseInt(document.getElementById('calcRecipe')?.value);
        const quantity = parseInt(document.getElementById('calcQuantity')?.value) || 1;
        const batchSize = parseInt(document.getElementById('batchSize')?.value) || 1;
        const ahCut = parseFloat(document.getElementById('ahCut')?.value) || 5;
        
        if (!recipeId) {
            this.showError('Please select a recipe');
            return;
        }

        const recipe = this.filteredRecipes.find(r => r.recipe_id === recipeId);
        if (!recipe) {
            this.showError('Recipe not found');
            return;
        }

        const totalQuantity = quantity * batchSize;
        const totalMaterialsCost = recipe.materialsCost * totalQuantity;
        const grossResultValue = recipe.resultValue * totalQuantity;
        const ahFee = grossResultValue * (ahCut / 100);
        const netResultValue = grossResultValue - ahFee;
        const totalProfit = netResultValue - totalMaterialsCost;
        const roi = totalMaterialsCost > 0 ? ((totalProfit / totalMaterialsCost) * 100) : 0;

        const resultsDiv = document.getElementById('calcResults');
        if (!resultsDiv) return;

        resultsDiv.innerHTML = `
            <div class="calc-results-header">
                <h3><i class="fas fa-calculator"></i> Calculation Results</h3>
                <div class="recipe-info">
                    <strong>${recipe.name}</strong> - ${recipe.profession}
                </div>
            </div>
            
            <div class="calc-summary">
                <div class="summary-row">
                    <span>Total Quantity:</span>
                    <span>${totalQuantity} items (${quantity} × ${batchSize})</span>
                </div>
                <div class="summary-row">
                    <span>Materials Cost:</span>
                    <span>${this.formatCurrency(totalMaterialsCost)}</span>
                </div>
                <div class="summary-row">
                    <span>Gross Value:</span>
                    <span>${this.formatCurrency(grossResultValue)}</span>
                </div>
                <div class="summary-row">
                    <span>AH Fee (${ahCut}%):</span>
                    <span class="negative">-${this.formatCurrency(ahFee)}</span>
                </div>
                <div class="summary-row">
                    <span>Net Value:</span>
                    <span>${this.formatCurrency(netResultValue)}</span>
                </div>
                <div class="summary-row total ${this.getProfitClass(totalProfit)}">
                    <span><strong>Total Profit:</strong></span>
                    <span><strong>${this.formatCurrency(totalProfit)}</strong></span>
                </div>
                <div class="summary-row">
                    <span>ROI:</span>
                    <span class="${this.getProfitClass(roi)}">${roi.toFixed(1)}%</span>
                </div>
            </div>
            
            <div class="material-breakdown">
                <h4>Material Breakdown (per ${totalQuantity} items):</h4>
                <div class="materials-list">
                    ${recipe.materialDetails.map(material => `
                        <div class="material-row">
                            <span>${material.name}</span>
                            <span>${material.quantity * totalQuantity}x</span>
                            <span>${this.formatCurrency(material.totalCost * totalQuantity)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
            
            <div class="calc-actions">
                <button class="btn btn-outline" onclick="platform.addCalculationToPortfolio(${recipeId}, ${totalQuantity})">
                    <i class="fas fa-plus"></i> Add to Portfolio
                </button>
                <button class="btn btn-primary" onclick="platform.createProfitAlert(${recipeId}, ${totalProfit})">
                    <i class="fas fa-bell"></i> Create Alert
                </button>
            </div>
        `;
        
        resultsDiv.classList.add('show');
    }

    addCalculationToPortfolio(recipeId, quantity) {
        const recipe = this.filteredRecipes.find(r => r.recipe_id === recipeId);
        if (!recipe) return;

        const portfolioItem = {
            id: Date.now(),
            recipeId: recipeId,
            recipeName: recipe.name,
            profession: recipe.profession,
            quantity: quantity,
            investment: recipe.materialsCost * quantity,
            expectedProfit: recipe.profit * quantity,
            roi: recipe.roi,
            dateAdded: new Date().toISOString()
        };

        this.portfolio.push(portfolioItem);
        this.savePortfolio();
        this.showSuccess('Recipe added to portfolio!');
    }

    updatePortfolio() {
        const totalInvestment = this.portfolio.reduce((sum, item) => sum + item.investment, 0);
        const expectedReturn = this.portfolio.reduce((sum, item) => sum + item.expectedProfit, 0);
        const portfolioROI = totalInvestment > 0 ? ((expectedReturn / totalInvestment) * 100) : 0;

        // Update summary stats
        const elements = {
            totalInvestment: this.formatCurrency(totalInvestment),
            expectedReturn: this.formatCurrency(expectedReturn),
            portfolioROI: portfolioROI.toFixed(1) + '%'
        };

        Object.entries(elements).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.innerHTML = value;
        });

        // Update portfolio table
        const tbody = document.querySelector('#portfolioTable tbody');
        if (!tbody) return;

        if (this.portfolio.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="no-data">No items in portfolio</td></tr>';
            return;
        }

        tbody.innerHTML = this.portfolio.map(item => `
            <tr>
                <td>
                    <div class="recipe-name">${item.recipeName}</div>
                    <div style="font-size: 12px; color: var(--text-muted);">
                        <span class="profession-badge" data-profession="${item.profession}">${item.profession}</span>
                    </div>
                </td>
                <td>${item.quantity}</td>
                <td>${this.formatCurrency(item.investment)}</td>
                <td class="${this.getProfitClass(item.expectedProfit)}">${this.formatCurrency(item.expectedProfit)}</td>
                <td class="${this.getProfitClass(item.roi)}">${item.roi.toFixed(1)}%</td>
                <td>
                    <button class="btn btn-outline btn-sm" onclick="platform.removeFromPortfolio(${item.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    removeFromPortfolio(itemId) {
        this.portfolio = this.portfolio.filter(item => item.id !== itemId);
        this.savePortfolio();
        this.updatePortfolio();
        this.showSuccess('Item removed from portfolio');
    }

    savePortfolio() {
        localStorage.setItem('craftingPortfolio', JSON.stringify(this.portfolio));
    }

    updateMaterialCost(recipeId, materialIndex, customCost) {
        const recipe = this.filteredRecipes.find(r => r.recipe_id === recipeId);
        if (!recipe || !recipe.materialDetails[materialIndex]) return;

        const material = recipe.materialDetails[materialIndex];
        const cost = parseFloat(customCost);
        
        if (isNaN(cost) || cost < 0) {
            this.showError('Please enter a valid cost in copper');
            return;
        }

        // Store custom cost
        this.customMaterialCosts[material.itemId] = cost;
        localStorage.setItem('customMaterialCosts', JSON.stringify(this.customMaterialCosts));

        // Reprocess data to update calculations
        this.processData();
        
        // Refresh the modal with updated costs
        this.showRecipeDetails(recipeId);
        
        this.showSuccess(`Updated cost for ${material.name} to ${this.formatCurrency(cost)}`);
    }

    resetMaterialCost(itemId) {
        delete this.customMaterialCosts[itemId];
        localStorage.setItem('customMaterialCosts', JSON.stringify(this.customMaterialCosts));
        this.processData();
        this.showSuccess('Reset to market price');
    }

    updateAlerts() {
        const alertsList = document.getElementById('alertsList');
        if (!alertsList) return;

        if (this.alerts.length === 0) {
            alertsList.innerHTML = '<div class="no-data">No active alerts</div>';
            return;
        }

        alertsList.innerHTML = this.alerts.map(alert => `
            <div class="alert-item">
                <div class="alert-info">
                    <div class="alert-title">${alert.title}</div>
                    <div class="alert-description">${alert.description}</div>
                    <div class="alert-threshold">Threshold: ${alert.threshold}</div>
                </div>
                <div class="alert-actions">
                    <button class="btn btn-outline btn-sm" onclick="platform.removeAlert(${alert.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    showRecipeDetails(recipeId) {
        const recipe = this.filteredRecipes.find(r => r.recipe_id === recipeId);
        if (!recipe) return;

        const modal = document.getElementById('recipeModal');
        const title = document.getElementById('modalTitle');
        const details = document.getElementById('recipeDetails');
        
        if (title) title.textContent = recipe.name;
        
        if (details) {
            details.innerHTML = `
                <!-- Header Section -->
                <div class="recipe-overview">
                    <div class="overview-left">
                        <div class="recipe-title-section">
                            <h3>${recipe.name}</h3>
                            <div class="recipe-badges">
                                <span class="profession-badge" data-profession="${recipe.profession}">${recipe.profession}</span>
                                <span class="skill-level">Level ${recipe.skill_level}</span>
                            </div>
                        </div>
                        <div class="key-metrics">
                            <div class="metric-item">
                                <span class="metric-label">Profit</span>
                                <span class="metric-value ${this.getProfitClass(recipe.profit)}">${this.formatCurrency(recipe.profit)}</span>
                            </div>
                            <div class="metric-item">
                                <span class="metric-label">ROI</span>
                                <span class="metric-value ${this.getProfitClass(recipe.roi)}">${recipe.roi.toFixed(1)}%</span>
                            </div>
                            <div class="metric-item">
                                <span class="metric-label">Trend</span>
                                <span class="metric-value ${recipe.trend.direction === 'up' ? 'positive' : recipe.trend.direction === 'down' ? 'negative' : 'neutral'}">
                                    <i class="fas fa-arrow-${recipe.trend.direction === 'up' ? 'up' : recipe.trend.direction === 'down' ? 'down' : 'right'}"></i>
                                    ${recipe.trend.change > 0 ? '+' : ''}${recipe.trend.change}%
                                </span>
                            </div>
                        </div>
                    </div>
                    <div class="overview-right">
                        <div class="result-summary">
                            <div class="result-label">Creates</div>
                            <div class="result-name">${recipe.resultName}</div>
                            <div class="result-quantity">${recipe.result_quantity}x</div>
                            <div class="result-value">${this.formatCurrency(recipe.resultValue)}</div>
                        </div>
                    </div>
                </div>

                <!-- Financial Summary -->
                <div class="financial-summary">
                    <div class="summary-card">
                        <div class="summary-header">
                            <h4>Cost Breakdown</h4>
                            ${recipe.totalSavings > 0 ? `<span class="savings-badge">Saves ${this.formatCurrency(recipe.totalSavings)}</span>` : ''}
                        </div>
                        <div class="cost-items">
                            <div class="cost-item">
                                <span>Materials Cost</span>
                                <span>${this.formatCurrency(recipe.materialsCost)}</span>
                            </div>
                            ${recipe.totalSavings > 0 ? `
                                <div class="cost-item savings">
                                    <span>Crafting Savings</span>
                                    <span class="positive">-${this.formatCurrency(recipe.totalSavings)}</span>
                                </div>
                            ` : ''}
                            <div class="cost-item">
                                <span>Market Value</span>
                                <span>${this.formatCurrency(recipe.resultValue)}</span>
                            </div>
                            <div class="cost-item total ${this.getProfitClass(recipe.profit)}">
                                <span><strong>Net Profit</strong></span>
                                <span><strong>${this.formatCurrency(recipe.profit)}</strong></span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Materials Table -->
                <div class="materials-section">
                    <h4>Required Materials</h4>
                    <div class="materials-table-wrapper">
                        ${recipe.materialDetails.map((material, index) => `
                            <div class="material-row">
                                <div class="material-info">
                                    <div class="material-main">
                                        <span class="material-name">${material.name}</span>
                                        <span class="material-qty">${material.quantity}x</span>
                                    </div>
                                    <div class="material-meta">
                                        <span class="material-stock">${material.available} available</span>
                                        ${this.getCostSourceBadge(material.costSource)}
                                    </div>
                                </div>
                                <div class="material-costs">
                                    <div class="cost-main">
                                        <span class="unit-cost">${this.formatCurrency(material.unitCost)} each</span>
                                        <span class="total-cost">${this.formatCurrency(material.totalCost)}</span>
                                    </div>
                                    <div class="cost-details">
                                        ${material.costSource === 'crafting' && material.marketCost > material.unitCost ? 
                                            `<span class="market-price">Market: ${this.formatCurrency(material.marketCost)}</span>` : ''
                                        }
                                        ${material.savings > 0 ? 
                                            `<span class="savings-amount">Saves ${this.formatCurrency(material.savings)}</span>` : ''
                                        }
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <!-- Action Buttons -->
                <div class="modal-actions">
                    <button class="btn btn-outline" onclick="platform.addToPortfolio(${recipe.recipe_id})">
                        <i class="fas fa-plus"></i> Add to Portfolio
                    </button>
                    <button class="btn btn-primary" onclick="platform.openCalculatorWithRecipe(${recipe.recipe_id})">
                        <i class="fas fa-calculator"></i> Calculate Profit
                    </button>
                </div>
            `;
        }
        
        if (modal) modal.style.display = 'block';
    }

    openCalculatorWithRecipe(recipeId) {
        this.closeModal('recipeModal');
        this.switchTab('calculator');
        
        setTimeout(() => {
            const calcRecipe = document.getElementById('calcRecipe');
            if (calcRecipe) {
                calcRecipe.value = recipeId;
            }
        }, 100);
    }

    addToPortfolio(recipeId) {
        const recipe = this.filteredRecipes.find(r => r.recipe_id === recipeId);
        if (!recipe) return;

        const portfolioItem = {
            id: Date.now(),
            recipeId: recipeId,
            recipeName: recipe.name,
            profession: recipe.profession,
            quantity: 1,
            investment: recipe.materialsCost,
            expectedProfit: recipe.profit,
            roi: recipe.roi,
            dateAdded: new Date().toISOString()
        };

        this.portfolio.push(portfolioItem);
        this.savePortfolio();
        this.showSuccess(`${recipe.name} added to portfolio!`);
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.style.display = 'none';
    }

    formatCurrency(amount) {
        if (amount === 0) return '<span class="copper">0c</span>';
        
        const gold = Math.floor(Math.abs(amount) / 10000);
        const silver = Math.floor((Math.abs(amount) % 10000) / 100);
        const copper = Math.round(Math.abs(amount) % 100); // Round copper to whole number
        
        let result = '';
        const isNegative = amount < 0;
        
        if (gold > 0) result += `<span class="gold">${gold}g</span> `;
        if (silver > 0) result += `<span class="silver">${silver}s</span> `;
        if (copper > 0 || result === '') result += `<span class="copper">${copper}c</span>`;
        
        return isNegative ? '-' + result.trim() : result.trim();
    }

    getCostSourceBadge(costSource) {
        switch (costSource) {
            case 'crafting':
                return '<span class="cost-source-badge crafting">Crafted</span>';
            case 'custom':
                return '<span class="cost-source-badge custom">Custom</span>';
            case 'market':
            default:
                return '<span class="cost-source-badge market">Market</span>';
        }
    }

    getProfitClass(value) {
        if (value > 0) return 'profit-positive';
        if (value < 0) return 'profit-negative';
        return 'profit-neutral';
    }

    showError(message) {
        this.showNotification(message, 'error');
    }

    showSuccess(message) {
        this.showNotification(message, 'success');
    }

    showNotification(message, type) {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <i class="fas fa-${type === 'error' ? 'exclamation-circle' : 'check-circle'}"></i>
            <span>${message}</span>
            <button onclick="this.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }

    toggleTheme() {
        // Theme toggle functionality would go here
        // For now, we're using dark mode by default
        this.showSuccess('Theme toggle coming soon!');
    }
}

// Initialize the platform
const platform = new CraftingProPlatform();

// Add notification styles
const notificationStyles = `
<style>
.notification {
    position: fixed;
    top: 80px;
    right: 20px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    z-index: 1001;
    min-width: 300px;
    box-shadow: var(--shadow-lg);
    animation: slideInRight 0.3s ease;
}

.notification.error {
    border-left: 4px solid var(--accent-danger);
}

.notification.success {
    border-left: 4px solid var(--accent-success);
}

.notification button {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    margin-left: auto;
}

@keyframes slideInRight {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
}
</style>
`;

document.head.insertAdjacentHTML('beforeend', notificationStyles);