require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const shortid = require('shortid');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static('.'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/aglink', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Error:', err));

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
    lastClicked: Date,
    meta: {
        title: String,
        description: String,
        image: String
    }
});

const Link = mongoose.model('Link', LinkSchema);

// Helper Functions
async function getGeoInfo(ip) {
    try {
        const cleanIp = ip.replace('::ffff:', '');
        if (cleanIp === '127.0.0.1' || cleanIp === '::1') {
            return { country: 'Local', city: 'Local', countryCode: 'LOC' };
        }
        
        const response = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode,city,region`);
        
        if (response.data.status === 'success') {
            return {
                country: response.data.country || 'Unknown',
                city: response.data.city || response.data.region || 'Unknown',
                countryCode: response.data.countryCode || 'XX'
            };
        }
    } catch (error) {
        console.log('Geolocation error:', error.message);
    }
    
    return { country: 'Unknown', city: 'Unknown', countryCode: 'XX' };
}

function getDeviceInfo(userAgent) {
    const device = { browser: 'Unknown', os: 'Unknown', device: 'Desktop' };
    
    // Browser detection
    if (userAgent.includes('Chrome')) device.browser = 'Chrome';
    else if (userAgent.includes('Firefox')) device.browser = 'Firefox';
    else if (userAgent.includes('Safari')) device.browser = 'Safari';
    else if (userAgent.includes('Edge')) device.browser = 'Edge';
    else if (userAgent.includes('Opera')) device.browser = 'Opera';
    
    // OS detection
    if (userAgent.includes('Windows')) device.os = 'Windows';
    else if (userAgent.includes('Mac')) device.os = 'macOS';
    else if (userAgent.includes('Linux')) device.os = 'Linux';
    else if (userAgent.includes('Android')) device.os = 'Android';
    else if (userAgent.includes('iOS')) device.os = 'iOS';
    
    // Device detection
    if (userAgent.includes('Mobile')) device.device = 'Mobile';
    else if (userAgent.includes('Tablet')) device.device = 'Tablet';
    
    return device;
}

// Routes

// Home Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
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
            shortCode = customAlias.trim().toLowerCase();
            const existing = await Link.findOne({ shortCode });
            if (existing) {
                return res.status(400).json({ error: 'Bu ad artıq istifadədədir' });
            }
        } else {
            shortCode = shortid.generate().substring(0, 8);
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
        const qrCodeData = await QRCode.toDataURL(`https://${req.get('host')}/${shortCode}`);

        // Create link
        const link = new Link({
            fullUrl: formattedUrl,
            shortCode,
            userId,
            customAlias,
            password,
            expiresAt,
            tags: tags ? tags.split(',').map(tag => tag.trim()) : [],
            qrCode: qrCodeData
        });

        await link.save();

        res.json({
            success: true,
            shortCode,
            shortUrl: `https://${req.get('host')}/${shortCode}`,
            qrCode: qrCodeData,
            expiresAt
        });

    } catch (error) {
        console.error('Create error:', error);
        res.status(500).json({ error: 'Server xətası' });
    }
});

// Get User's Links
app.post('/api/mylinks', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId tələb olunur' });
        }

        const links = await Link.find({ userId })
            .sort({ createdAt: -1 })
            .select('shortCode fullUrl createdAt totalClicks expiresAt isActive qrCode tags clicks')
            .lean();

        const enhancedLinks = links.map(link => {
            const lastClick = link.clicks && link.clicks.length > 0 
                ? link.clicks[link.clicks.length - 1].timestamp 
                : null;
            
            const uniqueIps = new Set(link.clicks?.map(c => c.ip) || []);
            
            return {
                ...link,
                lastClick,
                uniqueClicks: uniqueIps.size,
                daysLeft: link.expiresAt ? 
                    Math.ceil((new Date(link.expiresAt) - new Date()) / (1000 * 60 * 60 * 24)) : 
                    null
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
        const link = await Link.findOne({ shortCode: req.params.code });
        
        if (!link) {
            return res.status(404).json({ error: 'Link tapılmadı' });
        }

        // Calculate stats
        const countryStats = {};
        const deviceStats = {};
        const browserStats = {};
        const osStats = {};
        const dailyStats = {};

        link.clicks.forEach(click => {
            // Country
            countryStats[click.country] = (countryStats[click.country] || 0) + 1;
            
            // Device
            deviceStats[click.device] = (deviceStats[click.device] || 0) + 1;
            
            // Browser
            browserStats[click.browser] = (browserStats[click.browser] || 0) + 1;
            
            // OS
            osStats[click.os] = (osStats[click.os] || 0) + 1;
            
            // Daily
            const day = click.timestamp.toISOString().split('T')[0];
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

        res.json({
            success: true,
            link: {
                shortCode: link.shortCode,
                fullUrl: link.fullUrl,
                createdAt: link.createdAt,
                totalClicks: link.totalClicks,
                uniqueClicks: link.uniqueClicks,
                lastClicked: link.lastClicked
            },
            stats: {
                totalClicks: link.totalClicks,
                uniqueClicks: link.uniqueClicks,
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

// Redirect
app.get('/:code', async (req, res) => {
    try {
        const link = await Link.findOne({ shortCode: req.params.code });
        
        if (!link || !link.isActive) {
            return res.status(404).send('Link tapılmadı və ya aktiv deyil');
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
                    <title>Şifrə Tələb Olunur</title>
                    <style>
                        body { font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; background: linear-gradient(135deg, #667eea, #764ba2); }
                        .box { background: white; padding: 30px; border-radius: 10px; text-align: center; }
                        input { padding: 10px; margin: 10px; width: 200px; }
                        button { padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; }
                    </style>
                </head>
                <body>
                    <div class="box">
                        <h2>🔒 Şifrə Tələb Olunur</h2>
                        <input type="password" id="password" placeholder="Şifrəni daxil edin">
                        <button onclick="submit()">Daxil Ol</button>
                    </div>
                    <script>
                        function submit() {
                            const pass = document.getElementById('password').value;
                            window.location.href = window.location.pathname + '?password=' + encodeURIComponent(pass);
                        }
                    </script>
                </body>
                </html>
            `);
        }

        if (link.password && req.query.password !== link.password) {
            return res.status(401).send('Yanlış şifrə');
        }

        // Track click
        const ip = req.headers['x-forwarded-for'] || req.ip;
        const userAgent = req.headers['user-agent'] || '';
        const referrer = req.headers['referer'] || '';

        const geoInfo = await getGeoInfo(ip);
        const deviceInfo = getDeviceInfo(userAgent);

        link.clicks.push({
            ip,
            country: geoInfo.country,
            city: geoInfo.city,
            countryCode: geoInfo.countryCode,
            device: deviceInfo.device,
            browser: deviceInfo.browser,
            os: deviceInfo.os,
            referrer
        });

        link.totalClicks += 1;
        link.lastClicked = new Date();
        
        const uniqueIps = new Set(link.clicks.map(c => c.ip));
        link.uniqueClicks = uniqueIps.size;

        await link.save();

        res.redirect(link.fullUrl);

    } catch (error) {
        console.error('Redirect error:', error);
        res.status(500).send('Server xətası');
    }
});

// Delete Link
app.delete('/api/delete/:code', async (req, res) => {
    try {
        const { userId } = req.body;
        const { code } = req.params;

        const link = await Link.findOne({ shortCode: code, userId });
        
        if (!link) {
            return res.status(404).json({ error: 'Link tapılmadı' });
        }

        await Link.deleteOne({ _id: link._id });
        res.json({ success: true, message: 'Link silindi' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Server xətası' });
    }
});

// Dashboard Stats
app.post('/api/dashboard', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId tələb olunur' });
        }

        const links = await Link.find({ userId });
        
        const totalClicks = links.reduce((sum, link) => sum + link.totalClicks, 0);
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
                link.clicks.forEach(click => {
                    const clickDate = click.timestamp.toISOString().split('T')[0];
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
            .sort((a, b) => b.totalClicks - a.totalClicks)
            .slice(0, 5)
            .map(link => ({
                shortCode: link.shortCode,
                totalClicks: link.totalClicks,
                fullUrl: link.fullUrl.substring(0, 50) + (link.fullUrl.length > 50 ? '...' : '')
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda işləyir`);
    console.log(`🌐 http://localhost:${PORT}`);
});
