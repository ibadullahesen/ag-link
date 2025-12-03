require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const shortid = require('shortid');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// MongoDB Connection (Optional)
const MONGO_URI = process.env.MONGODB_URI;
let useMongoDB = false;

if (MONGO_URI) {
    mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    }).then(() => {
        console.log('⚡ MongoDB Connected');
        useMongoDB = true;
    }).catch(err => {
        console.log('⚠️ Using in-memory storage');
    });
}

// MongoDB Schemas
const ClickSchema = new mongoose.Schema({
    clickId: String,
    ip: String,
    country: String,
    countryCode: String,
    city: String,
    region: String,
    device: String,
    browser: String,
    os: String,
    referrer: String,
    timestamp: Date,
    userAgent: String
});

const LinkSchema = new mongoose.Schema({
    linkId: String,
    shortCode: String,
    fullUrl: String,
    userId: String,
    customAlias: String,
    password: String,
    clicks: [ClickSchema],
    totalClicks: { type: Number, default: 0 },
    uniqueClicks: { type: Number, default: 0 },
    expiresAt: Date,
    isActive: { type: Boolean, default: true },
    qrCode: String,
    tags: [String],
    createdAt: Date,
    lastClicked: Date,
    meta: {
        title: String,
        description: String
    }
});

const UserSchema = new mongoose.Schema({
    userId: String,
    deviceId: String,
    browserId: String,
    links: [String],
    createdAt: Date,
    lastSeen: Date
});

const Link = mongoose.models.Link || mongoose.model('Link', LinkSchema);
const User = mongoose.models.User || mongoose.model('User', UserSchema);

// In-memory storage with persistence
class PersistentStorage {
    constructor() {
        this.links = new Map();
        this.clicks = new Map();
        this.users = new Map();
        this.devices = new Map(); // deviceId -> userId mapping
        
        // Load from memory
        this.loadFromStorage();
        
        // Auto-save every 30 seconds
        setInterval(() => this.saveToStorage(), 30000);
    }
    
    // Load from localStorage if in browser, otherwise in-memory only
    loadFromStorage() {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                const saved = localStorage.getItem('aglink_data');
                if (saved) {
                    const data = JSON.parse(saved);
                    if (data.links) this.links = new Map(data.links);
                    if (data.clicks) this.clicks = new Map(data.clicks);
                    if (data.users) this.users = new Map(data.users);
                    if (data.devices) this.devices = new Map(data.devices);
                    console.log('📂 Loaded from storage:', this.links.size, 'links');
                }
            }
        } catch (e) {
            console.log('Storage load failed, starting fresh');
        }
    }
    
    // Save to localStorage
    saveToStorage() {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                const data = {
                    links: Array.from(this.links.entries()),
                    clicks: Array.from(this.clicks.entries()),
                    users: Array.from(this.users.entries()),
                    devices: Array.from(this.devices.entries()),
                    timestamp: new Date().toISOString()
                };
                localStorage.setItem('aglink_data', JSON.stringify(data));
            }
        } catch (e) {
            console.log('Storage save failed');
        }
    }
    
    // User management
    getOrCreateUser(userId, deviceId, browserId) {
        if (!this.users.has(userId)) {
            this.users.set(userId, {
                userId,
                deviceId,
                browserId,
                links: [],
                createdAt: new Date(),
                lastSeen: new Date()
            });
        } else {
            const user = this.users.get(userId);
            user.lastSeen = new Date();
        }
        
        // Map device to user
        if (deviceId) {
            this.devices.set(deviceId, userId);
        }
        
        return this.users.get(userId);
    }
    
    getUserByDevice(deviceId) {
        return this.devices.get(deviceId);
    }
    
    // Link management
    addLink(link) {
        this.links.set(link.shortCode, link);
        
        // Add to user's links
        const user = this.users.get(link.userId);
        if (user && !user.links.includes(link.shortCode)) {
            user.links.push(link.shortCode);
        }
        
        this.saveToStorage();
        return link;
    }
    
    getLink(code) {
        return this.links.get(code);
    }
    
    getUserLinks(userId) {
        const user = this.users.get(userId);
        if (!user) return [];
        
        return user.links
            .map(code => this.links.get(code))
            .filter(link => link)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    
    // Click tracking
    addClick(code, click) {
        const link = this.links.get(code);
        if (!link) return null;
        
        if (!this.clicks.has(code)) {
            this.clicks.set(code, []);
        }
        
        const clicks = this.clicks.get(code);
        click.clickId = uuidv4();
        click.timestamp = new Date();
        clicks.push(click);
        
        // Update link stats
        link.totalClicks = (link.totalClicks || 0) + 1;
        link.lastClicked = new Date();
        
        // Calculate unique clicks (by IP + device)
        const uniqueKey = `${click.ip}-${click.deviceId || ''}`;
        const uniqueClicks = new Set();
        clicks.forEach(c => {
            const key = `${c.ip}-${c.deviceId || ''}`;
            uniqueClicks.add(key);
        });
        link.uniqueClicks = uniqueClicks.size;
        
        // Add to link's clicks array (limited to last 100)
        if (!link.clicks) link.clicks = [];
        link.clicks.unshift(click);
        if (link.clicks.length > 100) link.clicks.pop();
        
        this.saveToStorage();
        return click;
    }
    
    getClicks(code) {
        return this.clicks.get(code) || [];
    }
    
    deleteLink(userId, code) {
        const link = this.links.get(code);
        if (!link || link.userId !== userId) return false;
        
        this.links.delete(code);
        this.clicks.delete(code);
        
        // Remove from user's links
        const user = this.users.get(userId);
        if (user) {
            user.links = user.links.filter(c => c !== code);
        }
        
        this.saveToStorage();
        return true;
    }
}

const storage = new PersistentStorage();

// GeoIP Service (Free & Fast)
const geoIPCache = new Map();

async function getGeoInfo(ip) {
    // Clean IP
    const cleanIp = ip?.replace('::ffff:', '').replace('::1', '127.0.0.1') || 'unknown';
    if (cleanIp === '127.0.0.1') {
        return { country: 'Local', countryCode: 'LOC', city: 'Local', region: 'Local' };
    }
    
    // Check cache first
    if (geoIPCache.has(cleanIp)) {
        return geoIPCache.get(cleanIp);
    }
    
    try {
        // Use free ip-api.com with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);
        
        const response = await fetch(`http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode,city,region,isp`, {
            signal: controller.signal,
            timeout: 1000
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            if (data.status === 'success') {
                const result = {
                    country: data.country || 'Unknown',
                    countryCode: data.countryCode || 'XX',
                    city: data.city || 'Unknown',
                    region: data.region || 'Unknown',
                    isp: data.isp || 'Unknown'
                };
                
                // Cache for 1 hour
                geoIPCache.set(cleanIp, result);
                setTimeout(() => geoIPCache.delete(cleanIp), 3600000);
                
                return result;
            }
        }
    } catch (error) {
        console.log('GeoIP failed, using fallback');
    }
    
    // Fallback: Simple IP to country mapping
    const fallback = {
        'az': { country: 'Azerbaijan', countryCode: 'AZ', city: 'Baku', region: 'Baku' },
        'tr': { country: 'Turkey', countryCode: 'TR', city: 'Istanbul', region: 'Istanbul' },
        'ru': { country: 'Russia', countryCode: 'RU', city: 'Moscow', region: 'Moscow' },
        'us': { country: 'USA', countryCode: 'US', city: 'New York', region: 'New York' },
        'gb': { country: 'UK', countryCode: 'GB', city: 'London', region: 'London' },
        'de': { country: 'Germany', countryCode: 'DE', city: 'Berlin', region: 'Berlin' },
        'fr': { country: 'France', countryCode: 'FR', city: 'Paris', region: 'Paris' }
    };
    
    const ipKey = cleanIp.substring(0, 2).toLowerCase();
    const result = fallback[ipKey] || { 
        country: 'Unknown', 
        countryCode: 'XX', 
        city: 'Unknown', 
        region: 'Unknown' 
    };
    
    geoIPCache.set(cleanIp, result);
    return result;
}

// Device/browser detection
function parseUserAgent(userAgent) {
    const ua = userAgent || '';
    
    // Browser detection
    let browser = 'Unknown';
    if (ua.includes('Chrome')) browser = 'Chrome';
    else if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Safari')) browser = 'Safari';
    else if (ua.includes('Edge')) browser = 'Edge';
    else if (ua.includes('Opera')) browser = 'Opera';
    
    // OS detection
    let os = 'Unknown';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
    
    // Device detection
    let device = 'Desktop';
    if (/Mobile|Android|iPhone|iPad|iPod/i.test(ua)) device = 'Mobile';
    else if (/Tablet|iPad/i.test(ua)) device = 'Tablet';
    
    return { browser, os, device, userAgent: ua.substring(0, 200) };
}

// Generate unique device/browser ID
function generateDeviceId(req) {
    const userAgent = req.headers['user-agent'] || '';
    const accept = req.headers['accept'] || '';
    const language = req.headers['accept-language'] || '';
    const platform = req.headers['sec-ch-ua-platform'] || '';
    
    // Create a fingerprint from browser characteristics
    const fingerprint = `${userAgent}::${accept}::${language}::${platform}`;
    
    // Simple hash
    let hash = 0;
    for (let i = 0; i < fingerprint.length; i++) {
        const char = fingerprint.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    
    return `device_${Math.abs(hash).toString(16)}`;
}

// HTML Template with Local Storage
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="az">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌍 AxtarGet aglink.pro | Link Shortener with Analytics</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --primary: #3b82f6;
            --secondary: #1d4ed8;
            --success: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --dark: #1e293b;
            --light: #f8fafc;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
            min-height: 100vh;
            color: var(--dark);
        }
        .navbar {
            background: white;
            padding: 1rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            position: sticky;
            top: 0;
            z-index: 1000;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 1rem;
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
        .btn {
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 6px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 0.9rem;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
        }
        .btn-primary {
            background: var(--primary);
            color: white;
        }
        .btn-primary:hover {
            background: var(--secondary);
            transform: translateY(-1px);
        }
        .btn-outline {
            background: transparent;
            border: 2px solid var(--primary);
            color: var(--primary);
        }
        .btn-group {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
        }
        .card {
            background: white;
            border-radius: 10px;
            padding: 1.5rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
            margin-bottom: 1rem;
        }
        .form-group {
            margin-bottom: 1rem;
        }
        .form-label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            font-size: 0.9rem;
        }
        .form-control {
            width: 100%;
            padding: 0.75rem;
            border: 2px solid #e2e8f0;
            border-radius: 6px;
            font-size: 1rem;
        }
        .form-control:focus {
            outline: none;
            border-color: var(--primary);
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 1rem;
            margin-bottom: 1.5rem;
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
            margin-bottom: 0.75rem;
            border: 1px solid #e2e8f0;
            transition: all 0.2s;
        }
        .link-item:hover {
            border-color: var(--primary);
            box-shadow: 0 2px 8px rgba(59, 130, 246, 0.1);
        }
        .badge {
            padding: 0.25rem 0.5rem;
            border-radius: 12px;
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
        .badge-warning { background: var(--warning); color: white; }
        .flag {
            font-size: 1.2em;
            margin-right: 0.25rem;
        }
        .tab-content {
            padding: 1.5rem 0;
        }
        .notification {
            position: fixed;
            top: 1rem;
            right: 1rem;
            background: white;
            padding: 1rem;
            border-radius: 8px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            z-index: 9999;
            animation: slideIn 0.3s ease;
            max-width: 300px;
            border-left: 4px solid var(--success);
        }
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
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
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 10000;
            align-items: center;
            justify-content: center;
        }
        .modal-content {
            background: white;
            padding: 2rem;
            border-radius: 10px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }
        .table {
            width: 100%;
            border-collapse: collapse;
            margin: 1rem 0;
        }
        .table th, .table td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid #e2e8f0;
        }
        .table th {
            background: #f8fafc;
            font-weight: 600;
        }
        .country-row {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        @media (max-width: 768px) {
            .container { padding: 0 0.5rem; }
            .btn-group { flex-direction: column; }
            .stats-grid { grid-template-columns: 1fr 1fr; }
        }
    </style>
</head>
<body>
    <!-- Navigation -->
    <nav class="navbar">
        <div class="container" style="display: flex; justify-content: space-between; align-items: center;">
            <div class="logo">
                <span>🌍</span> AxtarGet aglink.pro
            </div>
            <div class="btn-group">
                <button class="btn btn-outline" onclick="showTab('create')">➕ Yeni Link</button>
                <button class="btn btn-outline" onclick="showTab('dashboard')">📊 Dashboard</button>
                <button class="btn btn-outline" onclick="showTab('links')">📋 Linklərim</button>
            </div>
        </div>
    </nav>

    <div class="container">
        <!-- Create Tab -->
        <div id="create-tab" class="tab-content">
            <div class="card">
                <h2 style="margin-bottom: 1.5rem; color: var(--dark);">✨ Yeni Link Yarat</h2>
                
                <div class="form-group">
                    <label class="form-label">URL</label>
                    <input type="url" id="fullUrl" class="form-control" 
                           placeholder="https://example.com" autofocus required>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                    <div class="form-group">
                        <label class="form-label">Xüsusi Ad (İstəyə bağlı)</label>
                        <div style="display: flex;">
                            <span style="padding: 0.75rem; background: #f1f5f9; border: 2px solid #e2e8f0; border-right: none; border-radius: 6px 0 0 6px; font-size: 0.9rem;">
                                AxtarGet aglink.pro/
                            </span>
                            <input type="text" id="customAlias" class="form-control" 
                                   style="border-radius: 0 6px 6px 0;" placeholder="mening-linkim">
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label class="form-label">Müddət</label>
                        <select id="expiresIn" class="form-control">
                            <option value="3600">1 Saat</option>
                            <option value="86400">1 Gün</option>
                            <option value="604800">1 Həftə</option>
                            <option value="2592000">1 Ay</option>
                            <option value="31536000">1 İl</option>
                            <option value="forever" selected>Sonsuz</option>
                        </select>
                    </div>
                </div>
                
                <button class="btn btn-primary" onclick="createLink()" id="createBtn" 
                        style="width: 100%; padding: 0.875rem; font-size: 1rem;">
                    <span id="createText">🚀 Linki Qısalt</span>
                </button>
            </div>
            
            <div id="result-card" class="card" style="display: none; margin-top: 1rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
                    <div style="width: 40px; height: 40px; background: var(--success); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 1.5rem;">
                        ✓
                    </div>
                    <div>
                        <h3 style="color: var(--success);">Link Hazırdır!</h3>
                        <p style="color: #64748b; font-size: 0.9rem;">Aşağıdakı linki paylaşa bilərsiniz</p>
                    </div>
                </div>
                
                <div class="form-group">
                    <label class="form-label">Qısaldılmış Link</label>
                    <div style="display: flex; gap: 0.5rem;">
                        <input type="text" id="shortUrlResult" class="form-control" readonly>
                        <button class="btn btn-primary" onclick="copyResult()" style="min-width: 60px;">📋</button>
                    </div>
                </div>
                
                <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                    <button class="btn btn-outline" onclick="shareLink()" style="flex: 1;">📤 Paylaş</button>
                    <button class="btn btn-outline" onclick="viewStats()" style="flex: 1;">📊 Statistika</button>
                </div>
            </div>
        </div>

        <!-- Dashboard Tab -->
        <div id="dashboard-tab" class="tab-content" style="display: none;">
            <h2 style="margin-bottom: 1.5rem; color: var(--dark);">📊 Dashboard</h2>
            
            <div class="stats-grid">
                <div class="stat-card">
                    <div style="font-size: 0.85rem; color: #64748b; margin-bottom: 0.5rem;">Ümumi Linklər</div>
                    <div id="totalLinks" style="font-size: 2rem; font-weight: 800; color: var(--primary);">0</div>
                </div>
                <div class="stat-card">
                    <div style="font-size: 0.85rem; color: #64748b; margin-bottom: 0.5rem;">Aktiv Linklər</div>
                    <div id="activeLinks" style="font-size: 2rem; font-weight: 800; color: var(--success);">0</div>
                </div>
                <div class="stat-card">
                    <div style="font-size: 0.85rem; color: #64748b; margin-bottom: 0.5rem;">Ümumi Kliklər</div>
                    <div id="totalClicks" style="font-size: 2rem; font-weight: 800; color: var(--secondary);">0</div>
                </div>
                <div class="stat-card">
                    <div style="font-size: 0.85rem; color: #64748b; margin-bottom: 0.5rem;">Unikal Kliklər</div>
                    <div id="uniqueClicks" style="font-size: 2rem; font-weight: 800; color: var(--warning);">0</div>
                </div>
            </div>
            
            <div class="card">
                <h3 style="margin-bottom: 1rem;">📈 Son Aktivlik</h3>
                <div style="height: 250px;">
                    <canvas id="activityChart"></canvas>
                </div>
            </div>
            
            <div class="card" style="margin-top: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                    <h3 style="margin: 0;">🌍 Ölkə Paylanması</h3>
                    <small style="color: #64748b;" id="topCountriesCount">Yüklənir...</small>
                </div>
                <div id="countriesChart"></div>
            </div>
        </div>

        <!-- Links Tab -->
        <div id="links-tab" class="tab-content" style="display: none;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <h2 style="color: var(--dark);">📋 Linklərim</h2>
                <div style="display: flex; gap: 0.5rem;">
                    <input type="text" id="searchLinks" class="form-control" 
                           placeholder="🔍 Link axtar..." style="width: 200px;">
                    <button class="btn btn-primary" onclick="showTab('create')">➕ Yeni</button>
                </div>
            </div>
            
            <div id="linksList"></div>
            
            <div id="noLinks" style="text-align: center; padding: 3rem; display: none;">
                <div style="width: 80px; height: 80px; background: #f1f5f9; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; font-size: 2rem;">
                    🔗
                </div>
                <h3 style="color: #64748b; margin-bottom: 0.5rem;">Hələ link yoxdur</h3>
                <p style="color: #94a3b8; margin-bottom: 1.5rem;">İlk linkinizi yaradaraq başlayın</p>
                <button class="btn btn-primary" onclick="showTab('create')">
                    🚀 İlk Linkini Yarad
                </button>
            </div>
        </div>
        
        <!-- Footer -->
        <div style="text-align: center; margin-top: 3rem; padding: 1rem; color: #64748b; font-size: 0.9rem; border-top: 1px solid #e2e8f0;">
            <p>© 2025 AxtarGet aglink.pro | 🌍 Ölkə analitikası ilə | ⚡ Sürətli</p>
        </div>
    </div>

    <!-- Stats Modal -->
    <div id="statsModal" class="modal">
        <div class="modal-content">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <h3 style="margin: 0;">📊 Detallı Statistika</h3>
                <button onclick="closeModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #64748b;">×</button>
            </div>
            <div id="statsContent">
                <div style="text-align: center; padding: 2rem;">
                    <div class="loading" style="margin: 0 auto;"></div>
                    <p style="margin-top: 1rem; color: #64748b;">Yüklənir...</p>
                </div>
            </div>
        </div>
    </div>

    <!-- Scripts -->
    <script>
        // User and Device Management
        let userId = localStorage.getItem('aglink_userId');
        let deviceId = localStorage.getItem('aglink_deviceId');
        
        if (!userId) {
            userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('aglink_userId', userId);
        }
        
        if (!deviceId) {
            // Generate device ID from browser fingerprint
            const fingerprint = [
                navigator.userAgent,
                navigator.language,
                navigator.hardwareConcurrency,
                screen.width + 'x' + screen.height,
                navigator.platform
            ].join('|');
            
            // Simple hash
            let hash = 0;
            for (let i = 0; i < fingerprint.length; i++) {
                const char = fingerprint.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            
            deviceId = 'device_' + Math.abs(hash).toString(36);
            localStorage.setItem('aglink_deviceId', deviceId);
        }
        
        // Send device info to server
        fetch('/api/register-device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, deviceId })
        }).catch(() => {});
        
        // Global variables
        let allLinks = [];
        let activityChart = null;
        let currentStatsLink = null;
        
        // Tab management
        function showTab(tabName) {
            ['create', 'dashboard', 'links'].forEach(tab => {
                document.getElementById(tab + '-tab').style.display = 'none';
            });
            document.getElementById(tabName + '-tab').style.display = 'block';
            localStorage.setItem('lastTab', tabName);
            
            if (tabName === 'dashboard') {
                loadDashboard();
            } else if (tabName === 'links') {
                loadMyLinks();
            }
        }
        
        // Create link
        async function createLink() {
            const urlInput = document.getElementById('fullUrl');
            const url = urlInput.value.trim();
            
            if (!url) {
                showNotify('URL daxil edin', 'error');
                return;
            }
            
            const btn = document.getElementById('createBtn');
            const btnText = document.getElementById('createText');
            const originalText = btnText.textContent;
            btnText.innerHTML = '<span class="loading"></span>';
            btn.disabled = true;
            
            try {
                const response = await fetch('/api/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fullUrl: url,
                        userId,
                        deviceId,
                        expiresIn: document.getElementById('expiresIn').value,
                        customAlias: document.getElementById('customAlias').value.trim()
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    // Show result
                    document.getElementById('shortUrlResult').value = data.shortUrl;
                    document.getElementById('result-card').style.display = 'block';
                    
                    // Clear form
                    urlInput.value = '';
                    document.getElementById('customAlias').value = '';
                    
                    // Load updated data
                    loadDashboard();
                    loadMyLinks();
                    
                    showNotify('✅ Link uğurla yaradıldı!', 'success');
                    
                    // Auto-scroll to result
                    setTimeout(() => {
                        document.getElementById('result-card').scrollIntoView({ behavior: 'smooth' });
                    }, 100);
                } else {
                    showNotify(data.error || 'Xəta baş verdi', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showNotify('❌ Server xətası', 'error');
            } finally {
                btnText.textContent = originalText;
                btn.disabled = false;
            }
        }
        
        // Copy to clipboard
        function copyResult() {
            const input = document.getElementById('shortUrlResult');
            input.select();
            navigator.clipboard.writeText(input.value).then(() => {
                showNotify('✅ Link kopyalandı!', 'success');
            });
        }
        
        // Share link
        function shareLink() {
            const url = document.getElementById('shortUrlResult').value;
            if (navigator.share) {
                navigator.share({
                    title: 'AxtarGet aglink.pro - Qısaldılmış Link',
                    text: 'Bu linki yoxlayın:',
                    url: url
                });
            } else {
                copyResult();
            }
        }
        
        // View stats
        function viewStats() {
            const url = document.getElementById('shortUrlResult').value;
            const code = url.split('/').pop();
            showLinkStats(code);
        }
        
        // Load dashboard
        async function loadDashboard() {
            try {
                const response = await fetch('/api/dashboard', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, deviceId })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    // Update stats
                    document.getElementById('totalLinks').textContent = data.overview.totalLinks;
                    document.getElementById('activeLinks').textContent = data.overview.activeLinks;
                    document.getElementById('totalClicks').textContent = data.overview.totalClicks;
                    document.getElementById('uniqueClicks').textContent = data.overview.uniqueClicks;
                    
                    // Update chart
                    updateActivityChart(data.recentActivity);
                    
                    // Update countries chart
                    updateCountriesChart(data.countries || []);
                }
            } catch (error) {
                console.error('Dashboard error:', error);
            }
        }
        
        // Load user's links
        async function loadMyLinks() {
            try {
                const response = await fetch('/api/mylinks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, deviceId })
                });
                
                const data = await response.json();
                
                const listDiv = document.getElementById('linksList');
                const noLinksDiv = document.getElementById('noLinks');
                
                if (data.success && data.links.length > 0) {
                    allLinks = data.links;
                    noLinksDiv.style.display = 'none';
                    
                    listDiv.innerHTML = data.links.map(link => {
                        const shortUrl = \`\${window.location.origin}/\${link.shortCode}\`;
                        const isActive = link.isActive && (!link.expiresAt || new Date(link.expiresAt) > new Date());
                        const daysLeft = link.expiresAt ? 
                            Math.ceil((new Date(link.expiresAt) - new Date()) / (1000 * 60 * 60 * 24)) : 
                            null;
                        
                        return \`
                        <div class="link-item">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
                                <div style="flex: 1;">
                                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                                        <h4 style="margin: 0;">
                                            <a href="\${shortUrl}" target="_blank" style="color: var(--primary); text-decoration: none;">
                                                \${window.location.host}/\${link.shortCode}
                                            </a>
                                        </h4>
                                        \${link.customAlias ? '<span class="badge badge-warning">Custom</span>' : ''}
                                    </div>
                                    
                                    <p style="color: #64748b; font-size: 0.9rem; margin-bottom: 0.75rem;">
                                        \${link.fullUrl?.substring(0, 60)}\${link.fullUrl?.length > 60 ? '...' : ''}
                                    </p>
                                    
                                    <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
                                        <span class="badge badge-primary">
                                            👆 \${link.totalClicks || 0} klik
                                        </span>
                                        <span class="badge badge-success">
                                            👥 \${link.uniqueClicks || 0} unikal
                                        </span>
                                        <span class="badge \${isActive ? 'badge-success' : 'badge-danger'}">
                                            \${isActive ? '✅ Aktiv' : '❌ Deaktiv'}
                                        </span>
                                        \${daysLeft !== null ? \`
                                            <span class="badge \${daysLeft > 0 ? 'badge-primary' : 'badge-danger'}">
                                                ⏰ \${daysLeft > 0 ? daysLeft + ' gün' : 'Bitib'}
                                            </span>
                                        \` : ''}
                                        <span class="badge" style="background: #f1f5f9; color: #64748b;">
                                            📅 \${new Date(link.createdAt).toLocaleDateString('az-AZ')}
                                        </span>
                                    </div>
                                </div>
                                
                                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                                    <button class="btn btn-outline" onclick="showLinkStats('\${link.shortCode}')" style="font-size: 0.8rem;">
                                        📊 Statistika
                                    </button>
                                    <button class="btn btn-outline" onclick="copyToClipboard('\${shortUrl}')" style="font-size: 0.8rem;">
                                        📋 Kopyala
                                    </button>
                                    <button class="btn" onclick="deleteLink('\${link.shortCode}')" 
                                            style="font-size: 0.8rem; background: #fee2e2; color: var(--danger); border: none;">
                                        🗑️ Sil
                                    </button>
                                </div>
                            </div>
                        </div>
                        \`;
                    }).join('');
                } else {
                    listDiv.innerHTML = '';
                    noLinksDiv.style.display = 'block';
                }
            } catch (error) {
                console.error('Links error:', error);
            }
        }
        
        // Show link stats modal
        async function showLinkStats(code) {
            currentStatsLink = code;
            document.getElementById('statsModal').style.display = 'flex';
            
            try {
                const response = await fetch(\`/api/stats/\${code}\`);
                const data = await response.json();
                
                if (data.success) {
                    const shortUrl = \`\${window.location.origin}/\${code}\`;
                    
                    let statsHtml = \`
                        <div>
                            <div style="margin-bottom: 1.5rem;">
                                <h4 style="color: var(--primary); margin-bottom: 0.5rem;">\${window.location.host}/\${code}</h4>
                                <p style="color: #64748b; font-size: 0.9rem;">\${data.link.fullUrl}</p>
                            </div>
                            
                            <!-- Quick Stats -->
                            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 1.5rem;">
                                <div style="text-align: center; padding: 1rem; background: #f8fafc; border-radius: 8px;">
                                    <div style="font-size: 2rem; font-weight: 800; color: var(--primary);">\${data.stats.totalClicks}</div>
                                    <div style="font-size: 0.85rem; color: #64748b;">Ümumi Klik</div>
                                </div>
                                <div style="text-align: center; padding: 1rem; background: #f8fafc; border-radius: 8px;">
                                    <div style="font-size: 2rem; font-weight: 800; color: var(--success);">\${data.stats.uniqueClicks}</div>
                                    <div style="font-size: 0.85rem; color: #64748b;">Unikal Klik</div>
                                </div>
                            </div>
                            
                            <!-- Countries Table -->
                            <h5 style="margin-bottom: 1rem;">🌍 Ölkə Paylanması</h5>
                    \`;
                    
                    if (data.stats.countries && data.stats.countries.length > 0) {
                        statsHtml += \`
                            <div style="max-height: 300px; overflow-y: auto;">
                                <table class="table">
                                    <thead>
                                        <tr>
                                            <th>Ölkə</th>
                                            <th>Klik</th>
                                            <th>Faiz</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                        \`;
                        
                        data.stats.countries.forEach(country => {
                            const percentage = ((country.count / data.stats.totalClicks) * 100).toFixed(1);
                            const flag = getFlagEmoji(country.countryCode);
                            
                            statsHtml += \`
                                <tr>
                                    <td>
                                        <div class="country-row">
                                            <span class="flag">\${flag}</span>
                                            <span>\${country.country}</span>
                                        </div>
                                    </td>
                                    <td>\${country.count}</td>
                                    <td>
                                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                                            <div style="flex: 1; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden;">
                                                <div style="width: \${percentage}%; height: 100%; background: var(--primary);"></div>
                                            </div>
                                            <span>\${percentage}%</span>
                                        </div>
                                    </td>
                                </tr>
                            \`;
                        });
                        
                        statsHtml += \`
                                    </tbody>
                                </table>
                            </div>
                        \`;
                    } else {
                        statsHtml += \`
                            <div style="text-align: center; padding: 2rem; color: #94a3b8;">
                                <p>Hələ klik yoxdur</p>
                            </div>
                        \`;
                    }
                    
                    statsHtml += \`
                            <!-- Recent Clicks -->
                            <h5 style="margin-top: 1.5rem; margin-bottom: 1rem;">🕒 Son Kliklər</h5>
                            <div style="max-height: 200px; overflow-y: auto;">
                    \`;
                    
                    if (data.stats.recentClicks && data.stats.recentClicks.length > 0) {
                        data.stats.recentClicks.forEach(click => {
                            const flag = getFlagEmoji(click.countryCode);
                            const time = new Date(click.timestamp).toLocaleString('az-AZ');
                            
                            statsHtml += \`
                                <div style="padding: 0.75rem; border-bottom: 1px solid #e2e8f0;">
                                    <div style="display: flex; justify-content: space-between; align-items: center;">
                                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                                            <span class="flag">\${flag}</span>
                                            <div>
                                                <div>\${click.country}</div>
                                                <div style="font-size: 0.8rem; color: #64748b;">
                                                    \${click.city}, \${click.device} • \${click.browser}
                                                </div>
                                            </div>
                                        </div>
                                        <div style="font-size: 0.8rem; color: #64748b;">\${time}</div>
                                    </div>
                                </div>
                            \`;
                        });
                    } else {
                        statsHtml += \`
                            <div style="text-align: center; padding: 1rem; color: #94a3b8;">
                                <p>Hələ klik yoxdur</p>
                            </div>
                        \`;
                    }
                    
                    statsHtml += \`
                            </div>
                            
                            <div style="margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #e2e8f0;">
                                <button class="btn btn-primary" onclick="copyToClipboard('\${shortUrl}')" style="width: 100%;">
                                    📋 Linki Kopyala
                                </button>
                            </div>
                        </div>
                    \`;
                    
                    document.getElementById('statsContent').innerHTML = statsHtml;
                }
            } catch (error) {
                document.getElementById('statsContent').innerHTML = \`
                    <div style="text-align: center; padding: 2rem;">
                        <div style="color: var(--danger); font-size: 3rem; margin-bottom: 1rem;">❌</div>
                        <p style="color: #64748b;">Statistika yüklənmədi</p>
                    </div>
                \`;
            }
        }
        
        // Close modal
        function closeModal() {
            document.getElementById('statsModal').style.display = 'none';
        }
        
        // Delete link
        async function deleteLink(code) {
            if (!confirm('Bu linki silmək istədiyinizə əminsiniz? Bütün statistikalar silinəcək.')) {
                return;
            }
            
            try {
                const response = await fetch(\`/api/delete/\${code}\`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, deviceId })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showNotify('✅ Link silindi', 'success');
                    loadMyLinks();
                    loadDashboard();
                } else {
                    showNotify(data.error || 'Xəta', 'error');
                }
            } catch (error) {
                showNotify('❌ Server xətası', 'error');
            }
        }
        
        // Copy to clipboard helper
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                showNotify('✅ Kopyalandı!', 'success');
            });
        }
        
        // Update activity chart
        function updateActivityChart(data) {
            const ctx = document.getElementById('activityChart').getContext('2d');
            if (activityChart) {
                activityChart.destroy();
            }
            
            const labels = data.map(d => {
                const date = new Date(d.date);
                return date.toLocaleDateString('az-AZ', { weekday: 'short', day: 'numeric' });
            });
            
            const clicks = data.map(d => d.clicks);
            
            activityChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Kliklər',
                        data: clicks,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                stepSize: 1
                            }
                        }
                    }
                }
            });
        }
        
        // Update countries chart
        function updateCountriesChart(countries) {
            const container = document.getElementById('countriesChart');
            document.getElementById('topCountriesCount').textContent = \`\${countries.length} ölkə\`;
            
            if (countries.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 2rem;">Hələ məlumat yoxdur</p>';
                return;
            }
            
            let html = '';
            countries.forEach(country => {
                const percentage = ((country.count / country.total) * 100).toFixed(1);
                const flag = getFlagEmoji(country.countryCode);
                
                html += \`
                    <div style="margin-bottom: 0.75rem;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <span class="flag">\${flag}</span>
                                <span style="font-weight: 500;">\${country.country}</span>
                            </div>
                            <span style="font-weight: 600;">\${country.count}</span>
                        </div>
                        <div style="height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
                            <div style="width: \${percentage}%; height: 100%; background: var(--primary);"></div>
                        </div>
                    </div>
                \`;
            });
            
            container.innerHTML = html;
        }
        
        // Get flag emoji from country code
        function getFlagEmoji(countryCode) {
            if (!countryCode || countryCode === 'XX' || countryCode === 'LOC') return '🌍';
            
            const codePoints = countryCode.toUpperCase()
                .split('')
                .map(char => 127397 + char.charCodeAt());
            
            try {
                return String.fromCodePoint(...codePoints);
            } catch (e) {
                return '🏳️';
            }
        }
        
        // Show notification
        function showNotify(message, type) {
            const container = document.createElement('div');
            container.className = 'notification';
            container.style.borderLeftColor = type === 'success' ? 'var(--success)' : 'var(--danger)';
            
            container.innerHTML = \`
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span style="font-size: 1.2rem;">\${type === 'success' ? '✅' : '❌'}</span>
                    <span>\${message}</span>
                </div>
            \`;
            
            document.body.appendChild(container);
            setTimeout(() => {
                if (container.parentNode) {
                    container.remove();
                }
            }, 3000);
        }
        
        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            // Show last active tab
            const lastTab = localStorage.getItem('lastTab') || 'create';
            showTab(lastTab);
            
            // Auto-focus URL input
            if (lastTab === 'create') {
                setTimeout(() => {
                    const input = document.getElementById('fullUrl');
                    if (input) input.focus();
                }, 100);
            }
            
            // Enter key support
            document.getElementById('fullUrl').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') createLink();
            });
            
            // Search functionality
            document.getElementById('searchLinks').addEventListener('input', function() {
                const term = this.value.toLowerCase();
                const items = document.querySelectorAll('.link-item');
                
                let visibleCount = 0;
                items.forEach(item => {
                    const text = item.textContent.toLowerCase();
                    item.style.display = text.includes(term) ? 'block' : 'none';
                    if (text.includes(term)) visibleCount++;
                });
            });
            
            // Load initial data
            loadDashboard();
        });
    </script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</body>
</html>`;

// ===== API ROUTES =====

// Serve HTML
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(HTML_TEMPLATE);
});

app.get('/home', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(HTML_TEMPLATE);
});

// Register device
app.post('/api/register-device', (req, res) => {
    try {
        const { userId, deviceId } = req.body;
        
        if (!userId || !deviceId) {
            return res.json({ success: false, error: 'Missing data' });
        }
        
        storage.getOrCreateUser(userId, deviceId, req.headers['user-agent']);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: 'Server error' });
    }
});

// Create link
app.post('/api/create', async (req, res) => {
    try {
        const { fullUrl, userId, deviceId, expiresIn, customAlias } = req.body;
        
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
            shortCode = shortid.generate().substring(0, 8);
        }

        // Check if exists
        if (storage.getLink(shortCode)) {
            return res.json({ success: false, error: 'Bu kod artıq istifadədədir' });
        }

        // Register user/device
        storage.getOrCreateUser(userId, deviceId, req.headers['user-agent']);

        // Create link
        const link = {
            linkId: uuidv4(),
            shortCode,
            fullUrl: url,
            userId,
            customAlias,
            totalClicks: 0,
            uniqueClicks: 0,
            clicks: [],
            isActive: true,
            createdAt: new Date(),
            expiresAt: expiresIn && expiresIn !== 'forever' ? 
                new Date(Date.now() + parseInt(expiresIn) * 1000) : null
        };

        storage.addLink(link);

        // Generate QR code async
        setTimeout(async () => {
            try {
                const qrCode = await QRCode.toDataURL(`${req.protocol}://${req.get('host')}/${shortCode}`);
                link.qrCode = qrCode;
            } catch (error) {
                console.log('QR generation failed');
            }
        }, 0);

        res.json({
            success: true,
            shortCode,
            shortUrl: `${req.protocol}://${req.get('host')}/${shortCode}`,
            link
        });

    } catch (error) {
        console.error('Create error:', error);
        res.json({ success: false, error: 'Server xətası' });
    }
});

// Get user's links
app.post('/api/mylinks', (req, res) => {
    try {
        const { userId, deviceId } = req.body;
        
        if (!userId) {
            return res.json({ success: false, error: 'userId tələb olunur' });
        }

        // Register/update device
        storage.getOrCreateUser(userId, deviceId, req.headers['user-agent']);

        const links = storage.getUserLinks(userId);
        
        const processedLinks = links.map(link => ({
            shortCode: link.shortCode,
            fullUrl: link.fullUrl,
            customAlias: link.customAlias,
            totalClicks: link.totalClicks || 0,
            uniqueClicks: link.uniqueClicks || 0,
            isActive: link.isActive,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
            qrCode: link.qrCode,
            lastClicked: link.lastClicked
        })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({
            success: true,
            links: processedLinks,
            totalLinks: links.length,
            totalClicks: links.reduce((sum, link) => sum + (link.totalClicks || 0), 0)
        });

    } catch (error) {
        console.error('MyLinks error:', error);
        res.json({ success: false, error: 'Server xətası' });
    }
});

// Dashboard stats
app.post('/api/dashboard', (req, res) => {
    try {
        const { userId, deviceId } = req.body;
        
        if (!userId) {
            return res.json({ success: false, error: 'userId tələb olunur' });
        }

        storage.getOrCreateUser(userId, deviceId, req.headers['user-agent']);
        const links = storage.getUserLinks(userId);
        
        const totalClicks = links.reduce((sum, link) => sum + (link.totalClicks || 0), 0);
        const uniqueClicks = links.reduce((sum, link) => sum + (link.uniqueClicks || 0), 0);
        
        // Last 7 days activity
        const last7Days = [];
        const now = new Date();
        const clicksByDay = {};
        
        // Collect all clicks
        links.forEach(link => {
            const clicks = storage.getClicks(link.shortCode);
            clicks.forEach(click => {
                const day = click.timestamp.toISOString().split('T')[0];
                clicksByDay[day] = (clicksByDay[day] || 0) + 1;
            });
        });
        
        for (let i = 6; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            last7Days.push({
                date: dateStr,
                clicks: clicksByDay[dateStr] || 0
            });
        }
        
        // Country stats
        const countryStats = {};
        let totalClicksForCountries = 0;
        
        links.forEach(link => {
            const clicks = storage.getClicks(link.shortCode);
            clicks.forEach(click => {
                countryStats[click.country] = countryStats[click.country] || { count: 0, countryCode: click.countryCode };
                countryStats[click.country].count++;
                totalClicksForCountries++;
            });
        });
        
        const countries = Object.entries(countryStats)
            .map(([country, data]) => ({
                country,
                countryCode: data.countryCode,
                count: data.count,
                total: totalClicksForCountries
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        res.json({
            success: true,
            overview: {
                totalLinks: links.length,
                activeLinks: links.filter(l => l.isActive).length,
                totalClicks,
                uniqueClicks,
                averageClicks: links.length > 0 ? (totalClicks / links.length).toFixed(1) : 0
            },
            recentActivity: last7Days,
            countries
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.json({ success: false, error: 'Server xətası' });
    }
});

// Get link stats
app.get('/api/stats/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const link = storage.getLink(code);
        
        if (!link) {
            return res.json({ success: false, error: 'Link tapılmadı' });
        }

        const clicks = storage.getClicks(code);
        const uniqueIps = new Set(clicks.map(c => c.ip));
        
        // Country stats
        const countryStats = {};
        clicks.forEach(click => {
            countryStats[click.country] = countryStats[click.country] || { count: 0, countryCode: click.countryCode };
            countryStats[click.country].count++;
        });
        
        const countries = Object.entries(countryStats)
            .map(([country, data]) => ({
                country,
                countryCode: data.countryCode,
                count: data.count
            }))
            .sort((a, b) => b.count - a.count);
        
        // Recent clicks (last 20)
        const recentClicks = clicks
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 20)
            .map(click => ({
                country: click.country,
                countryCode: click.countryCode,
                city: click.city,
                region: click.region,
                device: click.device,
                browser: click.browser,
                timestamp: click.timestamp
            }));

        res.json({
            success: true,
            link: {
                shortCode: link.shortCode,
                fullUrl: link.fullUrl,
                createdAt: link.createdAt,
                totalClicks: link.totalClicks || 0,
                uniqueClicks: link.uniqueClicks || 0,
                lastClicked: link.lastClicked
            },
            stats: {
                totalClicks: clicks.length,
                uniqueClicks: uniqueIps.size,
                countries,
                recentClicks
            }
        });

    } catch (error) {
        console.error('Stats error:', error);
        res.json({ success: false, error: 'Server xətası' });
    }
});

// Delete link
app.delete('/api/delete/:code', (req, res) => {
    try {
        const { userId, deviceId } = req.body;
        const { code } = req.params;
        
        if (!userId) {
            return res.json({ success: false, error: 'userId tələb olunur' });
        }

        storage.getOrCreateUser(userId, deviceId, req.headers['user-agent']);
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

// Redirect endpoint with tracking
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

        // Get device ID from cookie or generate
        let deviceId = req.cookies?.deviceId;
        if (!deviceId) {
            deviceId = generateDeviceId(req);
            res.cookie('deviceId', deviceId, { maxAge: 365 * 24 * 60 * 60 * 1000 }); // 1 year
        }

        // Get user ID from device mapping
        const userId = storage.getUserByDevice(deviceId) || 'anonymous';
        
        // Get geo info
        const geoInfo = await getGeoInfo(req.ip);
        const deviceInfo = parseUserAgent(req.headers['user-agent']);
        
        // Create click record
        const click = {
            clickId: uuidv4(),
            ip: req.ip,
            deviceId,
            userId,
            referrer: req.headers.referer || '',
            userAgent: req.headers['user-agent']?.substring(0, 200),
            ...geoInfo,
            ...deviceInfo,
            timestamp: new Date()
        };
        
        // Track click
        storage.addClick(code, click);
        
        // Update user last seen
        if (userId !== 'anonymous') {
            storage.getOrCreateUser(userId, deviceId, req.headers['user-agent']);
        }

        // Redirect
        res.redirect(link.fullUrl);

    } catch (error) {
        console.error('Redirect error:', error);
        res.redirect('/');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: '✅ ACTIVE',
        timestamp: new Date().toISOString(),
        storage: {
            links: storage.links.size,
            users: storage.users.size,
            clicks: storage.clicks.size
        },
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda işləyir`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`📊 Ölkə analitikası aktiv`);
    console.log(`💾 Local storage aktiv`);
});
