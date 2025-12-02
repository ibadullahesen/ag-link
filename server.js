require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const shortid = require('shortid');
const axios = require('axios');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// MongoDB Connection (Render.com üçün)
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => {
    console.error('❌ MongoDB Error:', err.message);
    console.log('ℹ️ Local MongoDB istifadə olunacaq...');
    // Əgər MONGO_URI yoxdursa, memory-də işləsin
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
    shortCode: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    customAlias: String,
    password: String,
    clicks: [ClickSchema],
    totalClicks: { type: Number, default: 0 },
    uniqueClicks: { type: Number, default: 0 },
    expiresAt: Date,
    isActive: { type: Boolean, default: true },
    qrCode: String,
    tags: [String],
    createdAt: { type: Date, default: Date.now },
    lastClicked: Date
});

const Link = mongoose.models.Link || mongoose.model('Link', LinkSchema);

// In-memory storage backup
let memoryStorage = {
    links: new Map(),
    clicks: new Map()
};

// Helper Functions
async function getGeoInfo(ip) {
    try {
        const cleanIp = ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
        if (cleanIp === '127.0.0.1') {
            return { country: 'Local', city: 'Local', countryCode: 'LOC' };
        }
        
        const response = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode,city,region`, {
            timeout: 2000
        });
        
        if (response.data.status === 'success') {
            return {
                country: response.data.country || 'Unknown',
                city: response.data.city || response.data.region || 'Unknown',
                countryCode: response.data.countryCode || 'XX'
            };
        }
    } catch (error) {
        console.log('Geolocation skipped:', error.message);
    }
    
    return { country: 'Unknown', city: 'Unknown', countryCode: 'XX' };
}

function getDeviceInfo(userAgent) {
    const device = { browser: 'Unknown', os: 'Unknown', device: 'Desktop' };
    const ua = userAgent || '';
    
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

// Serve HTML
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Redirecting to aglink.pro...</title>
        <meta http-equiv="refresh" content="0; url=/app">
    </head>
    <body>
        <p>Redirecting to application...</p>
    </body>
    </html>
    `);
});

// Serve application
app.get('/app', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Create Link
app.post('/api/create', async (req, res) => {
    try {
        const { fullUrl, userId, expiresIn, customAlias, password, tags } = req.body;
        
        if (!fullUrl || !userId) {
            return res.status(400).json({ error: 'URL və userId tələb olunur' });
        }

        // Format URL
        let formattedUrl = fullUrl;
        if (!formattedUrl.startsWith('http')) {
            formattedUrl = 'https://' + formattedUrl;
        }

        try {
            new URL(formattedUrl);
        } catch (e) {
            return res.status(400).json({ error: 'Yanlış URL formatı' });
        }

        // Generate short code
        let shortCode;
        if (customAlias && customAlias.trim()) {
            shortCode = customAlias.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
            if (shortCode.length < 3) {
                return res.status(400).json({ error: 'Alias minimum 3 simvol olmalıdır' });
            }
        } else {
            shortCode = shortid.generate().substring(0, 8);
        }

        // Check if exists
        const existing = await Link.findOne({ shortCode });
        if (existing) {
            return res.status(400).json({ error: 'Bu ad artıq istifadədədir' });
        }

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

        // Create link
        const link = new Link({
            fullUrl: formattedUrl,
            shortCode,
            userId,
            customAlias,
            password,
            expiresAt,
            tags: tags ? tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [],
            qrCode: qrCodeData
        });

        await link.save();

        // Memory backup
        memoryStorage.links.set(shortCode, {
            ...link.toObject(),
            memory: true
        });

        res.json({
            success: true,
            shortCode,
            shortUrl: `${baseUrl}/${shortCode}`,
            qrCode: qrCodeData,
            expiresAt: expiresAt || 'Sonsuz'
        });

    } catch (error) {
        console.error('Create error:', error.message);
        
        // Fallback to memory storage
        if (error.code === 11000) { // Duplicate key
            return res.status(400).json({ error: 'Bu kod artıq istifadədədir' });
        }
        
        res.status(500).json({ error: 'Server xətası', details: error.message });
    }
});

// Get User's Links
app.post('/api/mylinks', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId tələb olunur' });
        }

        let links;
        try {
            links = await Link.find({ userId }).sort({ createdAt: -1 }).lean();
        } catch (dbError) {
            console.log('DB error, using memory storage');
            // Use memory storage if DB fails
            links = Array.from(memoryStorage.links.values())
                .filter(link => link.userId === userId);
        }

        const enhancedLinks = links.map(link => {
            const clicks = link.clicks || [];
            const lastClick = clicks.length > 0 
                ? clicks[clicks.length - 1].timestamp 
                : null;
            
            const uniqueIps = new Set(clicks.map(c => c.ip));
            
            const daysLeft = link.expiresAt ? 
                Math.ceil((new Date(link.expiresAt) - new Date()) / (1000 * 60 * 60 * 24)) : 
                null;
            
            return {
                ...link,
                lastClick,
                uniqueClicks: uniqueIps.size,
                daysLeft,
                status: link.isActive ? 
                    (daysLeft > 0 ? 'active' : 'expired') : 
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
        let link;
        try {
            link = await Link.findOne({ shortCode: req.params.code }).lean();
        } catch (dbError) {
            link = memoryStorage.links.get(req.params.code);
        }
        
        if (!link) {
            return res.status(404).json({ error: 'Link tapılmadı' });
        }

        const clicks = link.clicks || [];
        
        // Calculate stats
        const countryStats = {};
        const deviceStats = {};
        const browserStats = {};
        const osStats = {};
        const dailyStats = {};

        clicks.forEach(click => {
            // Country
            countryStats[click.country] = (countryStats[click.country] || 0) + 1;
            
            // Device
            deviceStats[click.device] = (deviceStats[click.device] || 0) + 1;
            
            // Browser
            browserStats[click.browser] = (browserStats[click.browser] || 0) + 1;
            
            // OS
            osStats[click.os] = (osStats[click.os] || 0) + 1;
            
            // Daily
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
            .slice(0, 10)
            .map(([country, count]) => ({ country, count }));

        const uniqueIps = new Set(clicks.map(c => c.ip));

        res.json({
            success: true,
            link: {
                shortCode: link.shortCode,
                fullUrl: link.fullUrl,
                createdAt: link.createdAt,
                totalClicks: link.totalClicks || clicks.length,
                uniqueClicks: uniqueIps.size,
                lastClicked: link.lastClicked || (clicks.length > 0 ? clicks[clicks.length - 1].timestamp : null),
                qrCode: link.qrCode
            },
            stats: {
                totalClicks: clicks.length,
                uniqueClicks: uniqueIps.size,
                countries: topCountries,
                devices: deviceStats,
                browsers: browserStats,
                os: osStats,
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
        let link;
        try {
            link = await Link.findOne({ shortCode: req.params.code });
        } catch (dbError) {
            link = memoryStorage.links.get(req.params.code);
            if (link && link.memory) {
                // Convert to Mongoose-like object
                link = { ...link, save: async function() {
                    memoryStorage.links.set(this.shortCode, this);
                }};
            }
        }
        
        if (!link) {
            return res.status(404).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Link Tapılmadı - aglink.pro</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; }
                    .container { max-width: 500px; margin: 0 auto; }
                    h1 { font-size: 3em; margin-bottom: 20px; }
                    a { color: white; text-decoration: underline; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>404</h1>
                    <h2>Link Tapılmadı</h2>
                    <p>Bu link mövcud deyil və ya silinib.</p>
                    <p><a href="/app">Əsas səhifəyə qayıt</a></p>
                </div>
            </body>
            </html>
            `);
        }

        if (!link.isActive) {
            return res.status(410).send('Bu link aktiv deyil');
        }

        if (link.expiresAt && new Date() > link.expiresAt) {
            link.isActive = false;
            await link.save();
            return res.status(410).send('Linkin müddəti bitib');
        }

        // Password check
        if (link.password && !req.query.password) {
            return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Şifrə Tələb Olunur - aglink.pro</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea, #764ba2); }
                    .box { background: white; padding: 40px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); text-align: center; width: 90%; max-width: 400px; }
                    input { width: 100%; padding: 12px; margin: 15px 0; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; box-sizing: border-box; }
                    button { background: linear-gradient(45deg, #667eea, #764ba2); color: white; border: none; padding: 12px 30px; border-radius: 8px; font-size: 16px; cursor: pointer; width: 100%; }
                    button:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4); }
                </style>
            </head>
            <body>
                <div class="box">
                    <h2 style="color: #333;">🔒 Şifrə Tələb Olunur</h2>
                    <p style="color: #666; margin-bottom: 20px;">Bu linkə daxil olmaq üçün şifrə daxil edin</p>
                    <input type="password" id="password" placeholder="Şifrəni daxil edin" autofocus>
                    <button onclick="submitPassword()">Daxil Ol</button>
                </div>
                <script>
                    function submitPassword() {
                        const pass = document.getElementById('password').value;
                        if (!pass) {
                            alert('Zəhmət olmasa şifrə daxil edin');
                            return;
                        }
                        window.location.href = window.location.pathname + '?password=' + encodeURIComponent(pass);
                    }
                    
                    document.getElementById('password').addEventListener('keypress', function(e) {
                        if (e.key === 'Enter') submitPassword();
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
        const ip = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'] || '';
        const referrer = req.headers['referer'] || req.headers['referrer'] || '';

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

        // Add click
        if (!link.clicks) link.clicks = [];
        link.clicks.push(clickData);
        link.totalClicks = (link.totalClicks || 0) + 1;
        link.lastClicked = new Date();
        
        // Update unique clicks
        const uniqueIps = new Set(link.clicks.map(c => c.ip));
        link.uniqueClicks = uniqueIps.size;

        // Save
        if (link.save) {
            await link.save();
        } else {
            // Memory storage
            memoryStorage.links.set(link.shortCode, link);
        }

        // Memory storage for clicks
        if (!memoryStorage.clicks.has(link.shortCode)) {
            memoryStorage.clicks.set(link.shortCode, []);
        }
        memoryStorage.clicks.get(link.shortCode).push(clickData);

        // Redirect
        res.redirect(link.fullUrl);

    } catch (error) {
        console.error('Redirect error:', error);
        res.status(500).send('Server xətası. <a href="/app">Əsas səhifə</a>');
    }
});

// Dashboard Stats
app.post('/api/dashboard', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId tələb olunur' });
        }

        let links;
        try {
            links = await Link.find({ userId }).lean();
        } catch (dbError) {
            links = Array.from(memoryStorage.links.values())
                .filter(link => link.userId === userId);
        }
        
        const totalClicks = links.reduce((sum, link) => sum + (link.totalClicks || 0), 0);
        const totalLinks = links.length;
        const activeLinks = links.filter(link => link.isActive).length;
        
        // Last 7 days
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            
            let dayClicks = 0;
            links.forEach(link => {
                const clicks = link.clicks || [];
                clicks.forEach(click => {
                    const clickDate = new Date(click.timestamp).toISOString().split('T')[0];
                    if (clickDate === dateStr) {
                        dayClicks++;
                    }
                });
            });
            
            last7Days.push({
                date: dateStr,
                clicks: dayClicks
            });
        }

        // Top 5 links
        const topLinks = links
            .sort((a, b) => (b.totalClicks || 0) - (a.totalClicks || 0))
            .slice(0, 5)
            .map(link => ({
                shortCode: link.shortCode,
                totalClicks: link.totalClicks || 0,
                fullUrl: link.fullUrl ? 
                    (link.fullUrl.substring(0, 50) + (link.fullUrl.length > 50 ? '...' : '')) : 
                    'N/A'
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

        if (!userId) {
            return res.status(400).json({ error: 'userId tələb olunur' });
        }

        try {
            const result = await Link.deleteOne({ shortCode: code, userId });
            if (result.deletedCount === 0) {
                return res.status(404).json({ error: 'Link tapılmadı' });
            }
        } catch (dbError) {
            // Memory storage
            if (memoryStorage.links.has(code)) {
                const link = memoryStorage.links.get(code);
                if (link.userId === userId) {
                    memoryStorage.links.delete(code);
                } else {
                    return res.status(404).json({ error: 'Link tapılmadı' });
                }
            } else {
                return res.status(404).json({ error: 'Link tapılmadı' });
            }
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

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint tapılmadı' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.status(500).json({ error: 'Server xətası', message: err.message });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ${PORT} portunda işləyir`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
