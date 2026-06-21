const API_URL = 'http://ws.audioscrobbler.com/2.0/';

async function fetchUserTopArtists(username, limit = 10) {
    const key = process.env.LASTFM_API_KEY;
    if (!key) throw new Error('LASTFM_API_KEY is not configured in .env');
    const url = `${API_URL}?method=user.gettopartists&user=${encodeURIComponent(username)}&api_key=${key}&format=json&limit=${limit}&period=6month`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Last.fm API returned ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.message || 'Last.fm API error');
    return data.topartists?.artist || [];
}

async function fetchArtistInfo(artistName) {
    const key = process.env.LASTFM_API_KEY;
    const url = `${API_URL}?method=artist.getinfo&artist=${encodeURIComponent(artistName)}&api_key=${key}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data.artist;
}

function calculateArtistScore(listenersStr) {
    if (!listenersStr || listenersStr === '0') return 100;
    const l = parseInt(listenersStr, 10);
    if (l < 5000) return 100;
    const logL = Math.log10(l);
    // 5k listeners -> 100%, 5M listeners -> 0%
    const minLog = 3.7;
    const maxLog = 6.7;
    let score = 100 - ((logL - minLog) / (maxLog - minLog)) * 100;
    return Math.max(0, Math.min(100, Math.round(score)));
}

async function getNicheScore(username) {
    const artists = await fetchUserTopArtists(username, 10);
    if (!artists || artists.length === 0) {
        throw new Error('User has no top artists. Go listen to some music!');
    }
    
    let totalScore = 0;
    let validArtists = 0;

    const promises = artists.map(async (a) => {
        const info = await fetchArtistInfo(a.name);
        if (info && info.stats && info.stats.listeners) {
            return calculateArtistScore(info.stats.listeners);
        }
        return null;
    });

    const scores = await Promise.all(promises);
    for (const score of scores) {
        if (score !== null) {
            totalScore += score;
            validArtists++;
        }
    }

    if (validArtists === 0) throw new Error('Could not calculate niche score (Last.fm API data missing).');
    
    return Math.round(totalScore / validArtists);
}

function generateProgressBar(percentage) {
    const totalBlocks = 10;
    let filledBlocks = Math.round((percentage / 100) * totalBlocks);
    
    let bar = '';
    
    // First block
    if (filledBlocks >= 1) {
        bar += '<:start:1518186169517740222>';
    } else {
        bar += '<:empstart:1518186299411005482>';
    }

    // Middle blocks
    for (let i = 1; i < totalBlocks - 1; i++) {
        if (i < filledBlocks) {
            bar += '<:mid:1518186166912811084>';
        } else {
            bar += '<:empmid:1518186297657786368>';
        }
    }

    // Last block
    if (filledBlocks === totalBlocks) {
        bar += '<:end:1518186164371193897>';
    } else {
        bar += '<:empend:1518186295355117639>';
    }

    return `${bar} **${percentage}% Niche**`;
}

module.exports = {
    getNicheScore,
    generateProgressBar
};
