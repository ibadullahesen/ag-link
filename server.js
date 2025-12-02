require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const shortid = require('shortid');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI);

const LinkSchema = new mongoose.Schema({
    full: String,
    short: String,
    userId: String,
    clicks: [{ 
        ip: String,
        country: String,
        device: String,
        timestamp: { type: Date, default: Date.now }
    }],
    expiresAt: Date,
    createdAt: { type: Date, default: Date.now }
});

const Link = mongoose.model('Link', LinkSchema);

// Ana səhifə
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// Yeni link yarat
app.post('/api/create', async (req, res) => {
    const { fullUrl, userId, expiresIn } = req.body;
    
    const short = shortid.generate().substring(0, 6);
    let expiresAt = null;
    if (expiresIn !== 'forever') {
        expiresAt = new Date(Date.now() + parseInt(expiresIn) * 1000);
    }

    const link = new Link({ full: fullUrl, short, userId, expiresAt });
    await link.save();

    res.json({ shortCode: short });
});

// Bütün linkləri gətir (userId ilə)
app.post('/api/mylinks', async (req, res) => {
    const { userId } = req.body;
    const links = await Link.find({ userId }).sort({ createdAt: -1 });
    res.json(links);
});

// Redirect + statistika
app.get('/:code', async (req, res) => {
    const link = await Link.findOne({ short: req.params.code });
    
    if (!link || (link.expiresAt && link.expiresAt < new Date())) {
        return res.status(404).send('Link bitib və ya tapılmadı');
    }

    const ip = req.headers['x-forwarded-for'] || req.ip;
    let country = 'Bilinmir';
    let device = req.headers['user-agent'].includes('Mobile') ? 'Mobil' : 'PC';

    try {
        const geo = await axios.get(`http://ip-api.com/json/${ip}`);
        country = geo.data.country || 'Bilinmir';
    } catch {}

    link.clicks.push({ ip, country, device });
    await link.save();

    res.redirect(link.full);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('Server işləyir'));
