const express = require('express');
const mongoose = require('mongoose');
const shortid = require('shortid');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI);

const Link = mongoose.model('Link', new mongoose.Schema({
    full: String,
    short: String,
    clicks: { type: Number, default: 0 }
}));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.post('/api/shorten', async (req, res) => {
    let { fullUrl } = req.body;
    if (!fullUrl) return res.status(400).json({ error: 'Link daxil et' });

    if (!fullUrl.startsWith('http')) fullUrl = 'https://' + fullUrl;

    const shortCode = shortid.generate().substring(0, 6);
    const shortUrl = `${req.protocol}://${req.get('host')}/${shortCode}`;

    const link = new Link({ full: fullUrl, short: shortCode });
    await link.save();

    res.json({ shortUrl });
});

app.get('/:code', async (req, res) => {
    const link = await Link.findOne({ short: req.params.code });
    if (link) {
        link.clicks++;
        await link.save();
        return res.redirect(link.full);
    }
    res.status(404).send('Link tapılmadı');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('Server işləyir'));
