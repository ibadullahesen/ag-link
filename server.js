require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const shortid = require('shortid');
const axios = require('axios');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// MongoDB Connection
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/aglink';

mongoose.connect(MONGO_URI)
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => {
    console.log('⚠️ MongoDB connection failed, using in-memory storage');
    console.log('ℹ️ Add MONGODB_URI to environment variables for persistent storage');
});

// Schemas
const ClickSchema = new mongoose.Schema({
    ip: String,
    country: String,
    city: String,
    countryCode: String,
    device: String,
    browser: String,
    os: String,
    referrer: String,
    timestamp: { type: Date, default: Date.now }
});

const LinkSchema = new mongoose.Schema({
    fullUrl: { type: String, required: true },
    shortCode: { type: String, required: true },
    userId: { type: String, required: true },
    customAlias: String,
    password: String,
    clicks: [ClickSchema],
    totalClicks: { type: Number, default: 0 },
    expiresAt: Date,
    isActive: { type: Boolean, default: true },
    qrCode: String,
    tags: [String],
    createdAt: { type: Date, default: Date.now },
    lastClicked: Date
});

const Link = mongoose.models.Link || mongoose.model('Link', LinkSchema);

// In-memory storage as fallback
const memoryStorage = {
    links: new Map(),
    clicks: new Map()
};

// Helper Functions
async function getGeoInfo(ip) {
    try {
        const cleanIp = ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
        if (cleanIp === '127.0.0.1') return { country: 'Local', city: 'Local', countryCode: 'LOC' };
        
        const response = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode,city`);
        if (response.data.status === 'success') {
            return {
                country: response.data.country || 'Unknown',
                city: response.data.city || 'Unknown',
                countryCode: response.data.countryCode || 'XX'
            };
        }
    } catch (error) {
        console.log('Geolocation skipped');
    }
    return { country: 'Unknown', city: 'Unknown', countryCode: 'XX' };
}

function getDeviceInfo(userAgent) {
    const ua = userAgent || '';
    const device = { browser: 'Unknown', os: 'Unknown', device: 'Desktop' };
    
    if (ua.includes('Chrome')) device.browser = 'Chrome';
    else if (ua.includes('Firefox')) device.browser = 'Firefox';
    else if (ua.includes('Safari')) device.browser = 'Safari';
    else if (ua.includes('Edge')) device.browser = 'Edge';
    else if (ua.includes('Opera')) device.browser = 'Opera';
    
    if (ua.includes('Windows')) device.os = 'Windows';
    else if (ua.includes('Mac')) device.os = 'macOS';
    else if (ua.includes('Linux')) device.os = 'Linux';
    else if (ua.includes('Android')) device.os = 'Android';
    else if (ua.includes('iOS')) device.os = 'iOS';
    
    if (ua.includes('Mobile')) device.device = 'Mobile';
    else if (ua.includes('Tablet')) device.device = 'Tablet';
    
    return device;
}

// ===== ROUTES =====

// Serve HTML directly from this file
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Redirecting to aglink.pro...</title>
        <meta http-equiv="refresh" content="0; url=/home">
    </head>
    <body>
        <p>Redirecting...</p>
    </body>
    </html>
    `);
});

// Main application page
app.get('/home', (req, res) => {
    res.send(getHTML());
});

// Create Link
app.post('/api/create', async (req, res) => {
    try {
        const { fullUrl, userId, expiresIn, customAlias, password, tags } = req.body;
        
        if (!fullUrl) return res.status(400).json({ error: 'URL tələb olunur' });

        // Format URL
        let formattedUrl = fullUrl;
        if (!formattedUrl.startsWith('http')) {
            formattedUrl = 'https://' + formattedUrl;
        }

        // Generate short code
        let shortCode;
        if (customAlias && customAlias.trim()) {
            shortCode = customAlias.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
            if (shortCode.length < 3) return res.status(400).json({ error: 'Alias minimum 3 simvol' });
        } else {
            shortCode = shortid.generate().substring(0, 8);
        }

        // Check if exists
        let existing = null;
        try {
            existing = await Link.findOne({ shortCode });
        } catch (e) {
            existing = memoryStorage.links.get(shortCode);
        }
        
        if (existing) return res.status(400).json({ error: 'Bu kod artıq istifadədədir' });

        // Set expiration
        let expiresAt = null;
        if (expiresIn && expiresIn !== 'forever') {
            const seconds = parseInt(expiresIn);
            if (!isNaN(seconds) && seconds > 0) {
                expiresAt = new Date(Date.now() + seconds * 1000);
            }
        }

        // Generate QR Code
        const baseUrl = req.protocol + '://' + req.get('host');
        const qrCodeData = await QRCode.toDataURL(`${baseUrl}/${shortCode}`);

        // Create link object
        const linkData = {
            fullUrl: formattedUrl,
            shortCode,
            userId: userId || 'anonymous',
            customAlias,
            password,
            expiresAt,
            tags: tags ? tags.split(',').map(tag => tag.trim()) : [],
            qrCode: qrCodeData,
            clicks: [],
            totalClicks: 0,
            isActive: true,
            createdAt: new Date()
        };

        // Save to MongoDB if available
        try {
            const link = new Link(linkData);
            await link.save();
        } catch (e) {
            // Save to memory if MongoDB fails
            memoryStorage.links.set(shortCode, linkData);
        }

        res.json({
            success: true,
            shortCode,
            shortUrl: `${baseUrl}/${shortCode}`,
            qrCode: qrCodeData,
            expiresAt: expiresAt || 'Sonsuz'
        });

    } catch (error) {
        console.error('Create error:', error.message);
        res.status(500).json({ error: 'Server xətası' });
    }
});

// Get User's Links
app.post('/api/mylinks', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId tələb olunur' });

        let links = [];
        try {
            links = await Link.find({ userId }).sort({ createdAt: -1 }).lean();
        } catch (e) {
            // Get from memory storage
            links = Array.from(memoryStorage.links.values())
                .filter(link => link.userId === userId)
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }

        const enhancedLinks = links.map(link => {
            const uniqueIps = new Set(link.clicks?.map(c => c.ip) || []);
            const daysLeft = link.expiresAt ? 
                Math.ceil((new Date(link.expiresAt) - new Date()) / (1000 * 60 * 60 * 24)) : 
                null;
            
            return {
                ...link,
                uniqueClicks: uniqueIps.size,
                daysLeft,
                status: link.isActive ? 
                    (daysLeft > 0 || daysLeft === null ? 'active' : 'expired') : 
                    'inactive'
            };
        });

        res.json({
            success: true,
            links: enhancedLinks,
            totalLinks: links.length,
            totalClicks: links.reduce((sum, link) => sum + (link.totalClicks || 0), 0)
        });

    } catch (error) {
        console.error('MyLinks error:', error);
        res.status(500).json({ error: 'Server xətası' });
    }
});

// Get Link Stats
app.get('/api/stats/:code', async (req, res) => {
    try {
        let link = null;
        try {
            link = await Link.findOne({ shortCode: req.params.code }).lean();
        } catch (e) {
            link = memoryStorage.links.get(req.params.code);
        }
        
        if (!link) return res.status(404).json({ error: 'Link tapılmadı' });

        const clicks = link.clicks || [];
        const uniqueIps = new Set(clicks.map(c => c.ip));
        
        // Calculate stats
        const countryStats = {};
        const deviceStats = {};
        const browserStats = {};
        const dailyStats = {};

        clicks.forEach(click => {
            countryStats[click.country] = (countryStats[click.country] || 0) + 1;
            deviceStats[click.device] = (deviceStats[click.device] || 0) + 1;
            browserStats[click.browser] = (browserStats[click.browser] || 0) + 1;
            
            const day = new Date(click.timestamp).toISOString().split('T')[0];
            dailyStats[day] = (dailyStats[day] || 0) + 1;
        });

        // Last 7 days
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            last7Days.push({
                date: dateStr,
                clicks: dailyStats[dateStr] || 0
            });
        }

        // Top countries
        const topCountries = Object.entries(countryStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([country, count]) => ({ country, count }));

        res.json({
            success: true,
            link: {
                shortCode: link.shortCode,
                fullUrl: link.fullUrl,
                createdAt: link.createdAt,
                totalClicks: clicks.length,
                uniqueClicks: uniqueIps.size,
                lastClicked: link.lastClicked,
                qrCode: link.qrCode
            },
            stats: {
                totalClicks: clicks.length,
                uniqueClicks: uniqueIps.size,
                countries: topCountries,
                devices: deviceStats,
                browsers: browserStats,
                daily: last7Days
            }
        });

    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Server xətası' });
    }
});

// Redirect endpoint
app.get('/:code', async (req, res) => {
    try {
        let link = null;
        try {
            link = await Link.findOne({ shortCode: req.params.code });
        } catch (e) {
            link = memoryStorage.links.get(req.params.code);
        }
        
        if (!link || !link.isActive) {
            return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Link Tapılmadı - aglink.pro</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; }
                    .container { max-width: 500px; margin: 0 auto; }
                    h1 { font-size: 4em; margin-bottom: 20px; }
                    a { color: white; text-decoration: underline; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>404</h1>
                    <h2>Link Tapılmadı</h2>
                    <p>Bu link mövcud deyil, silinib və ya aktiv deyil.</p>
                    <p><a href="/home">Əsas səhifəyə qayıt</a></p>
                </div>
            </body>
            </html>
            `);
        }

        // Check expiration
        if (link.expiresAt && new Date() > link.expiresAt) {
            link.isActive = false;
            return res.status(410).send('Linkin müddəti bitib');
        }

        // Password check
        if (link.password && !req.query.password) {
            return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Şifrə Tələb Olunur</title>
                <style>
                    body { font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea, #764ba2); }
                    .box { background: white; padding: 40px; border-radius: 15px; text-align: center; }
                    input { padding: 10px; margin: 10px; width: 200px; border: 2px solid #ddd; border-radius: 5px; }
                    button { padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; }
                </style>
            </head>
            <body>
                <div class="box">
                    <h2>🔒 Şifrə Tələb Olunur</h2>
                    <p>Bu linkə daxil olmaq üçün şifrə daxil edin</p>
                    <input type="password" id="password" placeholder="Şifrə" autofocus>
                    <br>
                    <button onclick="submit()">Daxil Ol</button>
                </div>
                <script>
                    function submit() {
                        const pass = document.getElementById('password').value;
                        window.location.href = window.location.pathname + '?password=' + encodeURIComponent(pass);
                    }
                    document.getElementById('password').addEventListener('keypress', function(e) {
                        if (e.key === 'Enter') submit();
                    });
                </script>
            </body>
            </html>
            `);
        }

        if (link.password && req.query.password !== link.password) {
            return res.status(401).send('Yanlış şifrə. <a href="javascript:history.back()">Yenidən cəhd et</a>');
        }

        // Track click
        const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
        const userAgent = req.headers['user-agent'] || '';
        const referrer = req.headers['referer'] || '';

        const geoInfo = await getGeoInfo(ip);
        const deviceInfo = getDeviceInfo(userAgent);

        const clickData = {
            ip,
            country: geoInfo.country,
            city: geoInfo.city,
            countryCode: geoInfo.countryCode,
            device: deviceInfo.device,
            browser: deviceInfo.browser,
            os: deviceInfo.os,
            referrer,
            timestamp: new Date()
        };

        // Update link
        if (!link.clicks) link.clicks = [];
        link.clicks.push(clickData);
        link.totalClicks = (link.totalClicks || 0) + 1;
        link.lastClicked = new Date();

        // Save
        if (link.save) {
            await link.save();
        } else {
            memoryStorage.links.set(link.shortCode, link);
            if (!memoryStorage.clicks.has(link.shortCode)) {
                memoryStorage.clicks.set(link.shortCode, []);
            }
            memoryStorage.clicks.get(link.shortCode).push(clickData);
        }

        // Redirect
        res.redirect(link.fullUrl);

    } catch (error) {
        console.error('Redirect error:', error);
        res.status(500).send('Server xətası');
    }
});

// Dashboard Stats
app.post('/api/dashboard', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId tələb olunur' });

        let links = [];
        try {
            links = await Link.find({ userId }).lean();
        } catch (e) {
            links = Array.from(memoryStorage.links.values())
                .filter(link => link.userId === userId);
        }
        
        const totalClicks = links.reduce((sum, link) => sum + (link.totalClicks || 0), 0);
        const totalLinks = links.length;
        const activeLinks = links.filter(link => link.isActive).length;
        
        // Last 7 days stats
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            
            let dayClicks = 0;
            links.forEach(link => {
                (link.clicks || []).forEach(click => {
                    if (new Date(click.timestamp).toISOString().split('T')[0] === dateStr) {
                        dayClicks++;
                    }
                });
            });
            
            last7Days.push({ date: dateStr, clicks: dayClicks });
        }

        // Top links
        const topLinks = links
            .sort((a, b) => (b.totalClicks || 0) - (a.totalClicks || 0))
            .slice(0, 3)
            .map(link => ({
                shortCode: link.shortCode,
                totalClicks: link.totalClicks || 0,
                fullUrl: link.fullUrl ? link.fullUrl.substring(0, 40) + '...' : 'N/A'
            }));

        res.json({
            success: true,
            overview: {
                totalLinks,
                activeLinks,
                totalClicks,
                averageClicks: totalLinks > 0 ? (totalClicks / totalLinks).toFixed(1) : 0
            },
            recentActivity: last7Days,
            topLinks
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Server xətası' });
    }
});

// Delete Link
app.delete('/api/delete/:code', async (req, res) => {
    try {
        const { userId } = req.body;
        const { code } = req.params;
        
        if (!userId) return res.status(400).json({ error: 'userId tələb olunur' });

        let deleted = false;
        try {
            const result = await Link.deleteOne({ shortCode: code, userId });
            deleted = result.deletedCount > 0;
        } catch (e) {
            if (memoryStorage.links.has(code)) {
                const link = memoryStorage.links.get(code);
                if (link.userId === userId) {
                    memoryStorage.links.delete(code);
                    deleted = true;
                }
            }
        }

        if (!deleted) {
            return res.status(404).json({ error: 'Link tapılmadı' });
        }

        res.json({ success: true, message: 'Link silindi' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Server xətası' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        memoryLinks: memoryStorage.links.size,
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

// 404 handler for API
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint tapılmadı' });
});

// Serve HTML for all other routes
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
        return res.status(404).json({ error: 'Not found' });
    }
    
    if (req.path === '/' || req.path === '/home') {
        return res.send(getHTML());
    }
    
    // For other routes, try to redirect if it's a short code
    if (req.path.length > 1 && req.path.length < 20) {
        // This will be handled by the /:code route
        return res.redirect(req.path);
    }
    
    res.send(getHTML());
});

// HTML template function
function getHTML() {
    return `
<!DOCTYPE html>
<html lang="az">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>aglink.pro | Professional Link Shortener</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --primary: #667eea;
            --secondary: #764ba2;
            --success: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --info: #3b82f6;
        }
        
        body {
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
            font-family: system-ui, -apple-system, sans-serif;
        }
        
        .navbar-brand {
            font-weight: 800;
            font-size: 1.5rem;
            background: linear-gradient(45deg, var(--primary), var(--secondary));
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }
        
        .card {
            border: none;
            border-radius: 12px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.08);
            transition: transform 0.2s;
            background: white;
        }
        
        .card:hover {
            transform: translateY(-3px);
        }
        
        .btn-primary {
            background: linear-gradient(45deg, var(--primary), var(--secondary));
            border: none;
            padding: 10px 25px;
            border-radius: 8px;
            font-weight: 600;
        }
        
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
        }
        
        .stat-card {
            border-left: 4px solid var(--primary);
            padding-left: 15px;
        }
        
        .link-item {
            border-left: 3px solid transparent;
            transition: all 0.2s;
            padding: 12px;
            margin-bottom: 8px;
            background: white;
            border-radius: 8px;
            border: 1px solid #e5e7eb;
        }
        
        .link-item:hover {
            border-left-color: var(--primary);
            background: #f8f9ff;
        }
        
        .nav-tabs .nav-link {
            border: none;
            color: #666;
            font-weight: 500;
            padding: 10px 20px;
            border-radius: 8px 8px 0 0;
        }
        
        .nav-tabs .nav-link.active {
            background: linear-gradient(45deg, var(--primary), var(--secondary));
            color: white;
        }
        
        .qr-code {
            background: white;
            padding: 8px;
            border-radius: 8px;
            border: 1px solid #dee2e6;
            max-width: 150px;
        }
        
        .notification {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 9999;
            min-width: 280px;
            animation: slideIn 0.3s ease;
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
        
        @media (max-width: 768px) {
            .navbar-brand { font-size: 1.2rem; }
            .card { margin: 5px; }
            .btn-primary { padding: 8px 20px; }
        }
    </style>
</head>
<body>
    <!-- Navigation -->
    <nav class="navbar navbar-expand-lg navbar-light bg-white shadow-sm">
        <div class="container">
            <a class="navbar-brand" href="/home">
                <i class="bi bi-link-45deg me-2"></i>aglink.pro
            </a>
            <div class="d-flex gap-2">
                <button class="btn btn-outline-primary btn-sm" onclick="showTab('create')">
                    <i class="bi bi-plus-circle me-1"></i>Yeni
                </button>
                <button class="btn btn-outline-info btn-sm" onclick="showTab('dashboard')">
                    <i class="bi bi-graph-up me-1"></i>Dashboard
                </button>
                <button class="btn btn-outline-secondary btn-sm" onclick="showTab('links')">
                    <i class="bi bi-list me-1"></i>Linklər
                </button>
            </div>
        </div>
    </nav>

    <!-- Main Content -->
    <div class="container py-3">
        <!-- Create Tab -->
        <div id="create-tab">
            <div class="row justify-content-center">
                <div class="col-lg-8">
                    <div class="card p-3 mb-3">
                        <h4 class="mb-3"><i class="bi bi-link me-2"></i>Yeni Link Yarat</h4>
                        
                        <div class="mb-3">
                            <label class="form-label">URL</label>
                            <div class="input-group">
                                <span class="input-group-text"><i class="bi bi-globe"></i></span>
                                <input type="url" id="fullUrl" class="form-control" 
                                       placeholder="https://example.com" required autofocus>
                            </div>
                        </div>
                        
                        <div class="row g-2 mb-3">
                            <div class="col-md-6">
                                <label class="form-label">Xüsusi Ad (İstəyə bağlı)</label>
                                <div class="input-group">
                                    <span class="input-group-text">aglink.pro/</span>
                                    <input type="text" id="customAlias" class="form-control" 
                                           placeholder="mening-linkim">
                                </div>
                            </div>
                            
                            <div class="col-md-6">
                                <label class="form-label">Müddət</label>
                                <select id="expiresIn" class="form-select">
                                    <option value="3600">1 Saat</option>
                                    <option value="86400">1 Gün</option>
                                    <option value="604800">1 Həftə</option>
                                    <option value="2592000">1 Ay</option>
                                    <option value="forever" selected>Sonsuz</option>
                                </select>
                            </div>
                        </div>
                        
                        <div class="row g-2 mb-3">
                            <div class="col-md-6">
                                <label class="form-label">Şifrə (İstəyə bağlı)</label>
                                <input type="password" id="password" class="form-control" 
                                       placeholder="Şifrə">
                            </div>
                            
                            <div class="col-md-6">
                                <label class="form-label">Tags (Vergüllə)</label>
                                <input type="text" id="tags" class="form-control" 
                                       placeholder="iş, sosial, marketting">
                            </div>
                        </div>
                        
                        <button class="btn btn-primary w-100" onclick="createLink()" id="createBtn">
                            <i class="bi bi-lightning me-2"></i>Linki Qısalt
                        </button>
                    </div>
                    
                    <div id="result-card" class="card p-3" style="display: none;">
                        <h5 class="text-success"><i class="bi bi-check-circle me-2"></i>Link Hazırdır!</h5>
                        
                        <div class="row align-items-center">
                            <div class="col-md-8">
                                <div class="input-group mb-2">
                                    <input type="text" id="shortUrlResult" class="form-control" readonly>
                                    <button class="btn btn-success" onclick="copyResult()">
                                        <i class="bi bi-copy"></i>
                                    </button>
                                </div>
                                <div class="mb-2">
                                    <small>Orijinal: <span id="originalUrl" class="text-muted"></span></small>
                                </div>
                            </div>
                            <div class="col-md-4 text-center">
                                <div id="qrCodeContainer"></div>
                                <small class="text-muted">QR Kod</small>
                            </div>
                        </div>
                        
                        <div class="d-flex gap-2 mt-3">
                            <button class="btn btn-outline-primary btn-sm flex-fill" onclick="shareLink()">
                                <i class="bi bi-share me-1"></i>Paylaş
                            </button>
                            <button class="btn btn-outline-info btn-sm flex-fill" onclick="viewStats()">
                                <i class="bi bi-bar-chart me-1"></i>Statistika
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Dashboard Tab -->
        <div id="dashboard-tab" style="display: none;">
            <h4 class="mb-3"><i class="bi bi-speedometer2 me-2"></i>Dashboard</h4>
            
            <div class="row g-3 mb-3">
                <div class="col-md-3 col-6">
                    <div class="card p-2 stat-card">
                        <small class="text-muted">Ümumi Linklər</small>
                        <h3 id="totalLinks" class="mb-0">0</h3>
                    </div>
                </div>
                
                <div class="col-md-3 col-6">
                    <div class="card p-2 stat-card">
                        <small class="text-muted">Aktiv Linklər</small>
                        <h3 id="activeLinks" class="mb-0">0</h3>
                    </div>
                </div>
                
                <div class="col-md-3 col-6">
                    <div class="card p-2 stat-card">
                        <small class="text-muted">Ümumi Kliklər</small>
                        <h3 id="totalClicks" class="mb-0">0</h3>
                    </div>
                </div>
                
                <div class="col-md-3 col-6">
                    <div class="card p-2 stat-card">
                        <small class="text-muted">Orta Klik/Link</small>
                        <h3 id="avgClicks" class="mb-0">0</h3>
                    </div>
                </div>
            </div>
            
            <div class="row g-3">
                <div class="col-lg-8">
                    <div class="card p-3">
                        <h6>Son 7 Gün Aktivlik</h6>
                        <canvas id="activityChart" height="200"></canvas>
                    </div>
                </div>
                
                <div class="col-lg-4">
                    <div class="card p-3">
                        <h6>Ən Populer Linklər</h6>
                        <div id="topLinks" class="mt-2"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Links Tab -->
        <div id="links-tab" style="display: none;">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h4 class="mb-0"><i class="bi bi-list-task me-2"></i>Linklərim</h4>
                <div class="d-flex gap-2">
                    <input type="text" id="searchLinks" class="form-control form-control-sm" 
                           placeholder="Axtar..." style="width: 150px;">
                    <button class="btn btn-primary btn-sm" onclick="showTab('create')">
                        <i class="bi bi-plus"></i>
                    </button>
                </div>
            </div>
            
            <div id="linksList"></div>
            
            <div id="noLinks" class="text-center py-4" style="display: none;">
                <i class="bi bi-link-45deg fs-1 text-muted mb-2"></i>
                <p class="text-muted">Hələ link yoxdur</p>
                <button class="btn btn-primary btn-sm" onclick="showTab('create')">
                    <i class="bi bi-plus-circle me-1"></i>İlk Linkini Yarad
                </button>
            </div>
        </div>
        
        <!-- Footer -->
        <div class="text-center text-muted mt-4 small">
            <p>© 2024 aglink.pro | v2.0</p>
        </div>
    </div>

    <!-- JavaScript -->
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        // Global variables
        let userId = localStorage.getItem('aglink_userId');
        if (!userId) {
            userId = 'user_' + Date.now();
            localStorage.setItem('aglink_userId', userId);
        }

        let activityChart = null;
        let allLinks = [];

        // Show notification
        function showNotification(message, type = 'info') {
            const container = document.createElement('div');
            const alertClass = type === 'success' ? 'alert-success' : 
                              type === 'error' ? 'alert-danger' : 'alert-info';
            
            container.className = \`notification alert \${alertClass} alert-dismissible fade show\`;
            container.innerHTML = \`
                <div class="d-flex align-items-center">
                    <i class="bi \${type === 'success' ? 'bi-check-circle' : 
                                  type === 'error' ? 'bi-exclamation-circle' : 'bi-info-circle'} 
                       me-2"></i>
                    <div>\${message}</div>
                    <button type="button" class="btn-close ms-auto" onclick="this.parentElement.parentElement.remove()"></button>
                </div>
            \`;
            
            document.body.appendChild(container);
            
            setTimeout(() => {
                if (container.parentNode) container.remove();
            }, 3000);
        }

        // Tab management
        function showTab(tabName) {
            document.getElementById('create-tab').style.display = 'none';
            document.getElementById('dashboard-tab').style.display = 'none';
            document.getElementById('links-tab').style.display = 'none';
            
            document.getElementById(tabName + '-tab').style.display = 'block';
            
            if (tabName === 'dashboard') {
                loadDashboard();
            } else if (tabName === 'links') {
                loadMyLinks();
            }
            
            localStorage.setItem('lastTab', tabName);
        }

        // Create new link
        async function createLink() {
            const fullUrl = document.getElementById('fullUrl').value.trim();
            if (!fullUrl) {
                showNotification('URL daxil edin', 'error');
                return;
            }

            const createBtn = document.getElementById('createBtn');
            const originalText = createBtn.innerHTML;
            createBtn.innerHTML = '<span class="loading"></span>';
            createBtn.disabled = true;

            try {
                const response = await fetch('/api/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fullUrl,
                        userId,
                        expiresIn: document.getElementById('expiresIn').value,
                        customAlias: document.getElementById('customAlias').value.trim(),
                        password: document.getElementById('password').value,
                        tags: document.getElementById('tags').value
                    })
                });

                const data = await response.json();

                if (data.success) {
                    const shortUrl = data.shortUrl || \`\${window.location.origin}/\${data.shortCode}\`;
                    document.getElementById('shortUrlResult').value = shortUrl;
                    document.getElementById('originalUrl').textContent = fullUrl;
                    
                    if (data.qrCode) {
                        document.getElementById('qrCodeContainer').innerHTML = 
                            \`<img src="\${data.qrCode}" alt="QR Code" class="img-fluid qr-code">\`;
                    }
                    
                    document.getElementById('result-card').style.display = 'block';
                    document.getElementById('fullUrl').value = '';
                    document.getElementById('customAlias').value = '';
                    
                    loadDashboard();
                    loadMyLinks();
                    
                    showNotification('Link yaradıldı!', 'success');
                } else {
                    showNotification(data.error || 'Xəta', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showNotification('Server xətası', 'error');
            } finally {
                createBtn.innerHTML = originalText;
                createBtn.disabled = false;
            }
        }

        // Copy to clipboard
        function copyResult() {
            const input = document.getElementById('shortUrlResult');
            input.select();
            navigator.clipboard.writeText(input.value).then(() => {
                showNotification('Kopyalandı!', 'success');
            });
        }

        // Share link
        function shareLink() {
            const url = document.getElementById('shortUrlResult').value;
            if (navigator.share) {
                navigator.share({ title: 'aglink.pro', url: url });
            } else {
                copyResult();
            }
        }

        // View stats
        function viewStats() {
            const url = document.getElementById('shortUrlResult').value;
            const code = url.split('/').pop();
            window.open(\`/api/stats/\${code}\`, '_blank');
        }

        // Load dashboard
        async function loadDashboard() {
            try {
                const response = await fetch('/api/dashboard', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });

                const data = await response.json();

                if (data.success) {
                    document.getElementById('totalLinks').textContent = data.overview.totalLinks;
                    document.getElementById('activeLinks').textContent = data.overview.activeLinks;
                    document.getElementById('totalClicks').textContent = data.overview.totalClicks;
                    document.getElementById('avgClicks').textContent = data.overview.averageClicks;
                    
                    // Update top links
                    const topLinksDiv = document.getElementById('topLinks');
                    if (data.topLinks && data.topLinks.length > 0) {
                        let html = '';
                        data.topLinks.forEach((link, index) => {
                            html += \`
                            <div class="d-flex justify-content-between align-items-center mb-2">
                                <div>
                                    <strong class="d-block">\${link.shortCode}</strong>
                                    <small class="text-muted d-block">\${link.fullUrl}</small>
                                </div>
                                <span class="badge bg-primary">\${link.totalClicks}</span>
                            </div>\`;
                        });
                        topLinksDiv.innerHTML = html;
                    } else {
                        topLinksDiv.innerHTML = '<p class="text-muted">Hələ yoxdur</p>';
                    }
                    
                    // Update chart
                    updateActivityChart(data.recentActivity);
                }
            } catch (error) {
                console.error('Dashboard error:', error);
            }
        }

        // Update activity chart
        function updateActivityChart(data) {
            const ctx = document.getElementById('activityChart').getContext('2d');
            
            if (activityChart) {
                activityChart.destroy();
            }
            
            const labels = data.map(item => {
                const date = new Date(item.date);
                return date.toLocaleDateString('az-AZ', { weekday: 'short' });
            });
            
            const clicks = data.map(item => item.clicks);
            
            activityChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Kliklər',
                        data: clicks,
                        borderColor: '#667eea',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { stepSize: 1 }
                        }
                    }
                }
            });
        }

        // Load user's links
        async function loadMyLinks() {
            try {
                const response = await fetch('/api/mylinks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });

                const data = await response.json();

                if (data.success) {
                    allLinks = data.links || [];
                    const linksList = document.getElementById('linksList');
                    const noLinks = document.getElementById('noLinks');
                    
                    if (allLinks.length === 0) {
                        linksList.innerHTML = '';
                        noLinks.style.display = 'block';
                        return;
                    }
                    
                    noLinks.style.display = 'none';
                    
                    let html = '';
                    allLinks.forEach(link => {
                        const shortUrl = \`\${window.location.origin}/\${link.shortCode}\`;
                        const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
                        const status = link.isActive && !isExpired ? 'Aktiv' : 'Deaktiv';
                        
                        html += \`
                        <div class="link-item">
                            <div class="row align-items-center">
                                <div class="col-md-8">
                                    <h6 class="mb-1">
                                        <a href="\${shortUrl}" target="_blank">\${window.location.host}/\${link.shortCode}</a>
                                    </h6>
                                    <p class="text-muted mb-1 small">\${link.fullUrl}</p>
                                    <div>
                                        <span class="badge bg-primary me-1">\${link.totalClicks || 0} klik</span>
                                        <span class="badge bg-secondary me-1">\${status}</span>
                                        \${link.tags && link.tags.length > 0 ? link.tags.map(tag => \`<span class="badge bg-light text-dark border me-1">\${tag}</span>\`).join('') : ''}
                                    </div>
                                </div>
                                <div class="col-md-4 text-end">
                                    <button class="btn btn-sm btn-outline-primary me-1" onclick="copyToClipboard('\${shortUrl}')">
                                        <i class="bi bi-copy"></i>
                                    </button>
                                    <button class="btn btn-sm btn-outline-danger" onclick="deleteLink('\${link.shortCode}')">
                                        <i class="bi bi-trash"></i>
                                    </button>
                                </div>
                            </div>
                        </div>\`;
                    });
                    
                    linksList.innerHTML = html;
                }
            } catch (error) {
                console.error('MyLinks error:', error);
            }
        }

        // Copy to clipboard
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                showNotification('Kopyalandı!', 'success');
            });
        }

        // Delete link
        async function deleteLink(code) {
            if (!confirm('Linki silmək istədiyinizə əminsiniz?')) return;

            try {
                const response = await fetch(\`/api/delete/\${code}\`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                });

                const data = await response.json();

                if (data.success) {
                    showNotification('Link silindi', 'success');
                    loadMyLinks();
                    loadDashboard();
                } else {
                    showNotification(data.error || 'Xəta', 'error');
                }
            } catch (error) {
                console.error('Delete error:', error);
                showNotification('Server xətası', 'error');
            }
        }

        // Search links
        function searchLinks() {
            const term = document.getElementById('searchLinks').value.toLowerCase();
            const links = document.querySelectorAll('.link-item');
            let found = 0;
            
            links.forEach(link => {
                const text = link.textContent.toLowerCase();
                link.style.display = text.includes(term) ? 'block' : 'none';
                if (text.includes(term)) found++;
            });
            
            if (term && found === 0) {
                showNotification('Tapılmadı', 'warning');
            }
        }

        // Initialize
        document.addEventListener('DOMContentLoaded', function() {
            const lastTab = localStorage.getItem('lastTab') || 'create';
            showTab(lastTab);
            
            // Auto-focus URL input
            if (lastTab === 'create') {
                setTimeout(() => document.getElementById('fullUrl').focus(), 100);
            }
            
            // Enter key support
            document.getElementById('fullUrl').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') createLink();
            });
            
            // Load initial data
            loadDashboard();
        });
    </script>
</body>
</html>`;
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda işləyir`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
