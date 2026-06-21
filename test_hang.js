const https = require('https');
require('dotenv').config();
const MAPILLARY_TOKEN = process.env.MAPILLARY_TOKEN;
const cities = require('./cities.json');

function fetchMapillaryData(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'Authorization': 'OAuth ' + MAPILLARY_TOKEN } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function test() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const city = cities[Math.floor(Math.random() * cities.length)];
        
        const latOffset = (Math.random() - 0.5) * 0.05;
        const lonOffset = (Math.random() - 0.5) * 0.05;
        
        const centerLat = city.lat + latOffset;
        const centerLon = city.lon + lonOffset;
        
        const minLon = centerLon - 0.005;
        const maxLon = centerLon + 0.005;
        const minLat = centerLat - 0.005;
        const maxLat = centerLat + 0.005;
        
        const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;
        const url = `https://graph.mapillary.com/images?fields=id,thumb_2048_url&bbox=${bbox}&limit=10`;
        
        console.log(`Attempt ${attempt}: ${city.city} (${bbox})`);
        try {
            const res = await fetchMapillaryData(url);
            console.log(`Response elements: ${res.data ? res.data.length : 0}`);
            if (res.data && res.data.length > 0) {
                const randomImg = res.data[Math.floor(Math.random() * res.data.length)];
                if (randomImg.thumb_2048_url) {
                    console.log("Success:", randomImg.thumb_2048_url);
                    return;
                }
            }
        } catch (e) {
            console.error(e);
        }
    }
    console.log("Failed after 5 attempts");
}
test();
