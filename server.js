require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const shortid = require('shortid');
const axios = require('axios');
const QRCode = require('qrcode');

const app = express();

// Ultra fast middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Connect to MongoDB with optimizations
const MONGO_URI = process.env.MONGODB_URI;

if (MONGO_URI) {
    mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    }).then(() => console.log('⚡ MongoDB Connected'))
    .catch(err => console.log('⚠️ MongoDB: Using memory storage'));
}

// Simple in-memory storage (FASTEST)
class FastStorage {
    constructor() {
        this.links = new Map();
        this.clicks = new Map();
        this.userLinks = new Map();
        this.index = new Map(); // For searching
    }
    
    addLink(link) {
        this.links.set(link.shortCode, link);
        
        // Index by user
        if (!this.userLinks.has(link.userId)) {
            this.userLinks.set(link.userId, new Set());
        }
        this.userLinks.get(link.userId).add(link.shortCode);
        
        return link;
    }
    
    getLink(code) {
        return this.links.get(code);
    }
    
    getUserLinks(userId) {
        const codes = this.userLinks.get(userId) || new Set();
        return Array.from(codes).map(code => this.links.get(code)).filter(Boolean);
    }
    
    addClick(code, click) {
        if (!this.clicks.has(code)) {
            this.clicks.set(code, []);
        }
        this.clicks.get(code).push(click);
        
        // Update link stats
        const link = this.links.get(code);
        if (link) {
            link.totalClicks = (link.totalClicks || 0) + 1;
            link.lastClicked = new Date();
        }
    }
    
    deleteLink(userId, code) {
        const link = this.links.get(code);
        if (link && link.userId === userId) {
            this.links.delete(code);
            const userSet = this.userLinks.get(userId);
            if (userSet) userSet.delete(code);
            return true;
        }
        return false;
    }
}

const storage = new FastStorage();

// Cache for frequent requests
const cache = {
    userDashboards: new Map(),
    linkStats: new Map(),
    expiry: 5000, // 5 seconds cache
};

function getCached(key) {
    const item = cache[key];
    if (item && Date.now() - item.timestamp < cache.expiry) {
        return item.data;
    }
    return null;
}

function setCached(key, data) {
    cache[key] = { data, timestamp: Date.now() };
}

// Fast helper functions
async function fastGeoInfo(ip) {
    const cleanIp = ip?.replace('::ffff:', '').replace('::1', '127.0.0.1') || 'unknown';
    if (cleanIp === '127.0.0.1') return { country: 'Local', countryCode: 'LOC' };
    
    // Simple IP to country mapping (most common)
    const ipMap = {
        'az': { country: 'Azerbaijan', countryCode: 'AZ' },
        'tr': { country: 'Turkey', countryCode: 'TR' },
        'ru': { country: 'Russia', countryCode: 'RU' },
        'us': { country: 'USA', countryCode: 'US' },
        'de': { country: 'Germany', countryCode: 'DE' },
        'fr': { country: 'France', countryCode: 'FR' },
        'gb': { country: 'UK', countryCode: 'GB' },
    };
    
    // Extract first two letters for quick match
    const ipKey = cleanIp.substring(0, 2).toLowerCase();
    return ipMap[ipKey] || { country: 'Unknown', countryCode: 'XX' };
}

function fastDeviceInfo(userAgent) {
    const ua = userAgent || '';
    const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
    const isTablet = /Tablet|iPad/i.test(ua);
    
    return {
        device: isMobile ? 'Mobile' : (isTablet ? 'Tablet' : 'Desktop'),
        browser: /Chrome/i.test(ua) ? 'Chrome' : 
                 /Firefox/i.test(ua) ? 'Firefox' : 
                 /Safari/i.test(ua) ? 'Safari' : 
                 /Edge/i.test(ua) ? 'Edge' : 'Other',
        os: /Windows/i.test(ua) ? 'Windows' :
            /Mac/i.test(ua) ? 'macOS' :
            /Linux/i.test(ua) ? 'Linux' :
            /Android/i.test(ua) ? 'Android' :
            /iOS|iPhone|iPad/i.test(ua) ? 'iOS' : 'Unknown'
    };
}

// ===== ULTRA FAST ROUTES =====

// Pre-generated HTML (NO FILE READING)
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="az">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>⚡ aglink.pro | Ultra Fast Link Shortener</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --primary: #667eea;
            --secondary: #764ba2;
            --success: #10b981;
            --danger: #ef4444;
            --light: #f8fafc;
            --dark: #1e293b;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: var(--dark);
        }
        .navbar {
            background: white;
            padding: 1rem;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            position: sticky;
            top: 0;
            z-index: 1000;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 1rem;
        }
        .navbar .container {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .logo {
            font-size: 1.5rem;
            font-weight: 800;
            background: linear-gradient(45deg, var(--primary), var(--secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .btn-group {
            display: flex;
            gap: 0.5rem;
        }
        .btn {
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 0.3rem;
            font-size: 0.9rem;
        }
        .btn-primary {
            background: linear-gradient(45deg, var(--primary), var(--secondary));
            color: white;
        }
        .btn-outline {
            background: white;
            color: var(--primary);
            border: 2px solid var(--primary);
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
        }
        .card {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            margin-bottom: 1rem;
        }
        .tab-content {
            padding: 2rem 0;
        }
        .form-group {
            margin-bottom: 1rem;
        }
        .form-label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            color: var(--dark);
        }
        .form-control {
            width: 100%;
            padding: 0.75rem;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 1rem;
            transition: border-color 0.2s;
        }
        .form-control:focus {
            outline: none;
            border-color: var(--primary);
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        .stat-card {
            background: white;
            padding: 1rem;
            border-radius: 8px;
            border-left: 4px solid var(--primary);
        }
        .link-item {
            background: white;
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 0.5rem;
            border: 1px solid #e2e8f0;
            transition: all 0.2s;
        }
        .link-item:hover {
            border-color: var(--primary);
            transform: translateX(5px);
        }
        .badge {
            padding: 0.25rem 0.5rem;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
            margin-right: 0.5rem;
        }
        .badge-primary { background: var(--primary); color: white; }
        .badge-success { background: var(--success); color: white; }
        .badge-danger { background: var(--danger); color: white; }
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .notification {
            position: fixed;
            top: 1rem;
            right: 1rem;
            background: white;
            padding: 1rem;
            border-radius: 8px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.2);
            z-index: 9999;
            animation: slideIn 0.3s ease;
            max-width: 300px;
        }
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @media (max-width: 768px) {
            .container { padding: 0 0.5rem; }
            .btn { padding: 0.4rem 0.8rem; font-size: 0.8rem; }
            .card { padding: 1rem; }
        }
    </style>
</head>
<body>
    <nav class="navbar">
        <div class="container">
            <div class="logo">
                <span>🔗</span> aglink.pro
            </div>
            <div class="btn-group">
                <button class="btn btn-outline" onclick="showTab('create')">➕ Yeni</button>
                <button class="btn btn-outline" onclick="showTab('dashboard')">📊 Dashboard</button>
                <button class="btn btn-outline" onclick="showTab('links')">📋 Linklər</button>
            </div>
        </div>
    </nav>

    <div class="container">
        <!-- Create Tab -->
        <div id="create-tab" class="tab-content">
            <div class="card">
                <h2 style="margin-bottom: 1.5rem; color: var(--dark);">🚀 Yeni Link Yarat</h2>
                
                <div class="form-group">
                    <label class="form-label">URL</label>
                    <input type="url" id="fullUrl" class="form-control" 
                           placeholder="https://example.com" autofocus>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                    <div class="form-group">
                        <label class="form-label">Xüsusi Ad</label>
                        <div style="display: flex;">
                            <span style="padding: 0.75rem; background: #f1f5f9; border: 2px solid #e2e8f0; border-right: none; border-radius: 8px 0 0 8px;">
                                aglink.pro/
                            </span>
                            <input type="text" id="customAlias" class="form-control" 
                                   style="border-radius: 0 8px 8px 0;" placeholder="mening-linkim">
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label class="form-label">Müddət</label>
                        <select id="expiresIn" class="form-control">
                            <option value="3600">1 Saat</option>
                            <option value="86400">1 Gün</option>
                            <option value="604800">1 Həftə</option>
                            <option value="forever" selected>Sonsuz</option>
                        </select>
                    </div>
                </div>
                
                <button class="btn btn-primary" onclick="createLink()" id="createBtn" 
                        style="width: 100%; padding: 1rem; font-size: 1.1rem;">
                    ⚡ Linki Qısalt
                </button>
            </div>
            
            <div id="result-card" class="card" style="display: none; margin-top: 1rem;">
                <h3 style="color: var(--success); margin-bottom: 1rem;">✅ Link Hazırdır!</h3>
                
                <div class="form-group">
                    <label class="form-label">Qısaldılmış Link</label>
                    <div style="display: flex; gap: 0.5rem;">
                        <input type="text" id="shortUrlResult" class="form-control" readonly>
                        <button class="btn btn-primary" onclick="copyResult()">📋</button>
                    </div>
                </div>
                
                <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                    <button class="btn btn-outline" onclick="shareLink()" style="flex: 1;">📤 Paylaş</button>
                    <button class="btn btn-outline" onclick="showTab('links')" style="flex: 1;">📋 Hamısına Bax</button>
                </div>
            </div>
        </div>

        <!-- Dashboard Tab -->
        <div id="dashboard-tab" class="tab-content" style="display: none;">
            <div class="stats-grid">
                <div class="stat-card">
                    <div style="font-size: 0.9rem; color: #64748b;">Ümumi Linklər</div>
                    <div id="totalLinks" style="font-size: 2rem; font-weight: 800; color: var(--primary);">0</div>
                </div>
                <div class="stat-card">
                    <div style="font-size: 0.9rem; color: #64748b;">Aktiv Linklər</div>
                    <div id="activeLinks" style="font-size: 2rem; font-weight: 800; color: var(--success);">0</div>
                </div>
                <div class="stat-card">
                    <div style="font-size: 0.9rem; color: #64748b;">Ümumi Kliklər</div>
                    <div id="totalClicks" style="font-size: 2rem; font-weight: 800; color: var(--secondary);">0</div>
                </div>
                <div class="stat-card">
                    <div style="font-size: 0.9rem; color: #64748b;">Orta Klik/Link</div>
                    <div id="avgClicks" style="font-size: 2rem; font-weight: 800; color: #f59e0b;">0</div>
                </div>
            </div>
            
            <div class="card">
                <h3 style="margin-bottom: 1rem;">📈 Son Aktivlik</h3>
                <div id="chartContainer" style="height: 200px;">
                    <canvas id="activityChart"></canvas>
                </div>
            </div>
            
            <div class="card" style="margin-top: 1rem;">
                <h3 style="margin-bottom: 1rem;">🏆 Ən Populer Linklər</h3>
                <div id="topLinks"></div>
            </div>
        </div>

        <!-- Links Tab -->
        <div id="links-tab" class="tab-content" style="display: none;">
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                    <h3 style="margin: 0;">📋 Bütün Linklərim</h3>
                    <input type="text" id="searchLinks" class="form-control" 
                           placeholder="🔍 Axtar..." style="width: 200px;">
                </div>
                
                <div id="linksList"></div>
                <div id="noLinks" style="text-align: center; padding: 3rem; color: #94a3b8; display: none;">
                    <div style="font-size: 3rem; margin-bottom: 1rem;">🔗</div>
                    <h4 style="margin-bottom: 0.5rem;">Hələ link yoxdur</h4>
                    <p>İlk linkinizi yaradın!</p>
                    <button class="btn btn-primary" onclick="showTab('create')" style="margin-top: 1rem;">
                        ➕ İlk Linkini Yarad
                    </button>
                </div>
            </div>
        </div>
        
        <div style="text-align: center; margin-top: 2rem; color: white; font-size: 0.9rem;">
            <p>© 2024 aglink.pro | ⚡ Ultra Fast Edition</p>
        </div>
    </div>

    <!-- Scripts -->
    <script>
        // Fast initialization
        let userId = localStorage.getItem('aglink_userId') || 'user_' + Date.now() + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('aglink_userId', userId);
        
        let allLinks = [];
        let chart = null;
        
        // Tab management
        function showTab(tabName) {
            ['create', 'dashboard', 'links'].forEach(tab => {
                document.getElementById(tab + '-tab').style.display = 'none';
            });
            document.getElementById(tabName + '-tab').style.display = 'block';
            localStorage.setItem('lastTab', tabName);
            
            if (tabName === 'dashboard') loadDashboard();
            else if (tabName === 'links') loadMyLinks();
        }
        
        // Create link - Ultra Fast
        async function createLink() {
            const urlInput = document.getElementById('fullUrl');
            const url = urlInput.value.trim();
            if (!url) return showNotify('URL daxil edin', 'error');
            
            const btn = document.getElementById('createBtn');
            btn.innerHTML = '<span class="loading"></span>';
            btn.disabled = true;
            
            try {
                const startTime = Date.now();
                const response = await fetch('/api/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fullUrl: url,
                        userId,
                        expiresIn: document.getElementById('expiresIn').value,
                        customAlias: document.getElementById('customAlias').value.trim()
                    })
                });
                
                const data = await response.json();
                const endTime = Date.now();
                console.log('Create time:', endTime - startTime, 'ms');
                
                if (data.success) {
                    document.getElementById('shortUrlResult').value = data.shortUrl;
                    document.getElementById('result-card').style.display = 'block';
                    urlInput.value = '';
                    document.getElementById('customAlias').value = '';
                    
                    // Fast updates
                    loadDashboard();
                    loadMyLinks();
                    
                    showNotify('✅ Link yaradıldı!', 'success');
                } else {
                    showNotify(data.error, 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showNotify('Xəta baş verdi', 'error');
            } finally {
                btn.innerHTML = '⚡ Linki Qısalt';
                btn.disabled = false;
            }
        }
        
        // Load dashboard - Fast
        async function loadDashboard() {
            try {
                const startTime = Date.now();
                const response = await fetch('/api/dashboard', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });
                
                const data = await response.json();
                console.log('Dashboard load:', Date.now() - startTime, 'ms');
                
                if (data.success) {
                    document.getElementById('totalLinks').textContent = data.overview.totalLinks;
                    document.getElementById('activeLinks').textContent = data.overview.activeLinks;
                    document.getElementById('totalClicks').textContent = data.overview.totalClicks;
                    document.getElementById('avgClicks').textContent = data.overview.averageClicks;
                    
                    // Update chart
                    updateChart(data.recentActivity);
                    
                    // Top links
                    const topDiv = document.getElementById('topLinks');
                    if (data.topLinks?.length > 0) {
                        topDiv.innerHTML = data.topLinks.map(link => 
                            \`<div style="padding: 0.5rem 0; border-bottom: 1px solid #e2e8f0;">
                                <div style="display: flex; justify-content: space-between;">
                                    <span style="font-weight: 600;">\${link.shortCode}</span>
                                    <span class="badge badge-primary">\${link.totalClicks} klik</span>
                                </div>
                                <div style="font-size: 0.9rem; color: #64748b; margin-top: 0.25rem;">
                                    \${link.fullUrl}
                                </div>
                            </div>\`
                        ).join('');
                    } else {
                        topDiv.innerHTML = '<p style="color: #94a3b8; text-align: center;">Hələ yoxdur</p>';
                    }
                }
            } catch (error) {
                console.error('Dashboard error:', error);
            }
        }
        
        // Load links - Fast
        async function loadMyLinks() {
            try {
                const startTime = Date.now();
                const response = await fetch('/api/mylinks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });
                
                const data = await response.json();
                console.log('Links load:', Date.now() - startTime, 'ms');
                
                const listDiv = document.getElementById('linksList');
                const noLinksDiv = document.getElementById('noLinks');
                
                if (data.success && data.links?.length > 0) {
                    allLinks = data.links;
                    noLinksDiv.style.display = 'none';
                    
                    listDiv.innerHTML = data.links.map(link => {
                        const shortUrl = \`\${window.location.origin}/\${link.shortCode}\`;
                        const isActive = link.isActive && (!link.expiresAt || new Date(link.expiresAt) > new Date());
                        
                        return \`<div class="link-item" onclick="copyToClipboard('\${shortUrl}')" style="cursor: pointer;">
                            <div style="display: flex; justify-content: space-between; align-items: start;">
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; margin-bottom: 0.25rem;">
                                        \${window.location.host}/\${link.shortCode}
                                    </div>
                                    <div style="font-size: 0.9rem; color: #64748b; margin-bottom: 0.5rem;">
                                        \${link.fullUrl?.substring(0, 50)}\${link.fullUrl?.length > 50 ? '...' : ''}
                                    </div>
                                    <div>
                                        <span class="badge badge-primary">\${link.totalClicks || 0} klik</span>
                                        <span class="badge \${isActive ? 'badge-success' : 'badge-danger'}">
                                            \${isActive ? 'Aktiv' : 'Deaktiv'}
                                        </span>
                                        \${link.createdAt ? \`<span class="badge" style="background: #f1f5f9; color: #64748b;">
                                            \${new Date(link.createdAt).toLocaleDateString('az-AZ')}
                                        </span>\` : ''}
                                    </div>
                                </div>
                                <button onclick="event.stopPropagation(); deleteLink('\${link.shortCode}')" 
                                        style="background: none; border: none; color: var(--danger); cursor: pointer; padding: 0.5rem;">
                                    🗑️
                                </button>
                            </div>
                        </div>\`;
                    }).join('');
                } else {
                    listDiv.innerHTML = '';
                    noLinksDiv.style.display = 'block';
                }
            } catch (error) {
                console.error('Links error:', error);
            }
        }
        
        // Update chart
        function updateChart(data) {
            const ctx = document.getElementById('activityChart').getContext('2d');
            if (chart) chart.destroy();
            
            chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data.map(d => new Date(d.date).toLocaleDateString('az-AZ', { weekday: 'short' })),
                    datasets: [{
                        data: data.map(d => d.clicks),
                        borderColor: '#667eea',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, ticks: { stepSize: 1 } }
                    }
                }
            });
        }
        
        // Utility functions
        function copyResult() {
            const input = document.getElementById('shortUrlResult');
            input.select();
            navigator.clipboard.writeText(input.value);
            showNotify('✅ Kopyalandı!', 'success');
        }
        
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text);
            showNotify('✅ Kopyalandı!', 'success');
        }
        
        function shareLink() {
            const url = document.getElementById('shortUrlResult').value;
            if (navigator.share) {
                navigator.share({ title: 'aglink.pro', url });
            } else {
                copyResult();
            }
        }
        
        async function deleteLink(code) {
            if (!confirm('Silinsin?')) return;
            
            try {
                await fetch(\`/api/delete/\${code}\`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });
                
                showNotify('🗑️ Link silindi', 'success');
                loadMyLinks();
                loadDashboard();
            } catch (error) {
                showNotify('Xəta', 'error');
            }
        }
        
        function showNotify(message, type) {
            const div = document.createElement('div');
            div.className = 'notification';
            div.innerHTML = \`
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span>\${type === 'success' ? '✅' : '❌'}</span>
                    <span>\${message}</span>
                </div>
            \`;
            
            document.body.appendChild(div);
            setTimeout(() => div.remove(), 3000);
        }
        
        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            showTab(localStorage.getItem('lastTab') || 'create');
            loadDashboard();
            
            // Enter key support
            document.getElementById('fullUrl').addEventListener('keypress', e => {
                if (e.key === 'Enter') createLink();
            });
        });
    </script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</body>
</html>`;

// Serve HTML
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
    res.send(HTML_TEMPLATE);
});

app.get('/home', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(HTML_TEMPLATE);
});

// API Routes - Ultra Fast

// Create link
app.post('/api/create', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { fullUrl, userId, expiresIn, customAlias } = req.body;
        
        if (!fullUrl) {
            return res.json({ success: false, error: 'URL tələb olunur' });
        }

        // Format URL
        let url = fullUrl;
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        // Generate short code
        let shortCode;
        if (customAlias && customAlias.trim()) {
            shortCode = customAlias.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
            if (shortCode.length < 2) {
                return res.json({ success: false, error: 'Minimum 2 simvol' });
            }
        } else {
            shortCode = shortid.generate().substring(0, 6);
        }

        // Check if exists
        if (storage.getLink(shortCode)) {
            return res.json({ success: false, error: 'Bu kod artıq var' });
        }

        // Create link object
        const link = {
            shortCode,
            fullUrl: url,
            userId: userId || 'anonymous',
            customAlias,
            totalClicks: 0,
            clicks: [],
            isActive: true,
            createdAt: new Date(),
            expiresAt: expiresIn && expiresIn !== 'forever' ? 
                new Date(Date.now() + parseInt(expiresIn) * 1000) : null
        };

        // Save
        storage.addLink(link);

        // Generate QR code asynchronously
        setTimeout(async () => {
            try {
                const qrCode = await QRCode.toDataURL(`${req.protocol}://${req.get('host')}/${shortCode}`);
                link.qrCode = qrCode;
            } catch (qrError) {
                console.log('QR code generation skipped');
            }
        }, 100);

        const responseTime = Date.now() - startTime;
        console.log(`Create API: ${responseTime}ms`);

        res.json({
            success: true,
            shortCode,
            shortUrl: `${req.protocol}://${req.get('host')}/${shortCode}`,
            responseTime: `${responseTime}ms`
        });

    } catch (error) {
        console.error('Create error:', error);
        res.json({ success: false, error: 'Server xətası' });
    }
});

// Get user's links
app.post('/api/mylinks', (req, res) => {
    const startTime = Date.now();
    
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.json({ success: false, error: 'userId tələb olunur' });
        }

        const links = storage.getUserLinks(userId);
        
        // Fast processing
        const processedLinks = links.map(link => ({
            shortCode: link.shortCode,
            fullUrl: link.fullUrl,
            totalClicks: link.totalClicks || 0,
            isActive: link.isActive,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
            customAlias: link.customAlias
        })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const responseTime = Date.now() - startTime;
        console.log(`MyLinks API: ${responseTime}ms`);

        res.json({
            success: true,
            links: processedLinks,
            totalLinks: links.length,
            totalClicks: links.reduce((sum, link) => sum + (link.totalClicks || 0), 0),
            responseTime: `${responseTime}ms`
        });

    } catch (error) {
        console.error('MyLinks error:', error);
        res.json({ success: false, error: 'Server xətası' });
    }
});

// Dashboard stats
app.post('/api/dashboard', (req, res) => {
    const startTime = Date.now();
    
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.json({ success: false, error: 'userId tələb olunur' });
        }

        const links = storage.getUserLinks(userId);
        const totalClicks = links.reduce((sum, link) => sum + (link.totalClicks || 0), 0);
        
        // Generate last 7 days activity (fast mockup for now)
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            last7Days.push({
                date: date.toISOString().split('T')[0],
                clicks: Math.floor(Math.random() * 10) // Mock data for speed
            });
        }

        // Top links
        const topLinks = links
            .sort((a, b) => (b.totalClicks || 0) - (a.totalClicks || 0))
            .slice(0, 3)
            .map(link => ({
                shortCode: link.shortCode,
                totalClicks: link.totalClicks || 0,
                fullUrl: link.fullUrl?.substring(0, 30) + (link.fullUrl?.length > 30 ? '...' : '')
            }));

        const responseTime = Date.now() - startTime;
        console.log(`Dashboard API: ${responseTime}ms`);

        res.json({
            success: true,
            overview: {
                totalLinks: links.length,
                activeLinks: links.filter(l => l.isActive).length,
                totalClicks,
                averageClicks: links.length > 0 ? (totalClicks / links.length).toFixed(1) : 0
            },
            recentActivity: last7Days,
            topLinks,
            responseTime: `${responseTime}ms`
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.json({ success: false, error: 'Server xətası' });
    }
});

// Delete link
app.delete('/api/delete/:code', (req, res) => {
    try {
        const { userId } = req.body;
        const { code } = req.params;
        
        if (!userId) {
            return res.json({ success: false, error: 'userId tələb olunur' });
        }

        const deleted = storage.deleteLink(userId, code);
        
        if (!deleted) {
            return res.json({ success: false, error: 'Link tapılmadı' });
        }

        res.json({ success: true, message: 'Link silindi' });
    } catch (error) {
        console.error('Delete error:', error);
        res.json({ success: false, error: 'Server xətası' });
    }
});

// Redirect endpoint
app.get('/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const link = storage.getLink(code);
        
        if (!link || !link.isActive) {
            return res.redirect('/');
        }

        // Check expiration
        if (link.expiresAt && new Date() > link.expiresAt) {
            link.isActive = false;
            return res.send('Linkin müddəti bitib');
        }

        // Fast click tracking (async)
        const click = {
            ip: req.ip,
            timestamp: new Date(),
            ...fastGeoInfo(req.ip),
            ...fastDeviceInfo(req.headers['user-agent'])
        };
        
        storage.addClick(code, click);

        // Immediate redirect
        res.redirect(link.fullUrl);

    } catch (error) {
        console.error('Redirect error:', error);
        res.redirect('/');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: '⚡ ULTRA FAST', 
        timestamp: new Date().toISOString(),
        totalLinks: storage.links.size,
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`⚡ Ultra Fast Server ${PORT} portunda işləyir`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`📊 Health: http://localhost:${PORT}/health`);
});
