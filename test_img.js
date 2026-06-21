const https = require('https');
const cities = require('./cities.json');
require('dotenv').config();
const MAPILLARY_TOKEN = process.env.MAPILLARY_TOKEN;

function fetchMapillaryData(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'Authorization': 'OAuth ' + MAPILLARY_TOKEN } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function test() {
    const city = cities[0]; // Paris
    const centerLat = city.lat;
    const centerLon = city.lon;
    
    const minLon = centerLon - 0.005;
    const maxLon = centerLon + 0.005;
    const minLat = centerLat - 0.005;
    const maxLat = centerLat + 0.005;
    
    const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;
    const url = `https://graph.mapillary.com/images?fields=id&bbox=${bbox}&limit=10`;
    
    try {
        const res = await fetchMapillaryData(url);
        if (res.data && res.data.length > 0) {
            const randomImg = res.data[0];
            const imgUrlRes = await fetchMapillaryData(`https://graph.mapillary.com/${randomImg.id}?fields=thumb_2048_url`);
            console.log("Image URL:", imgUrlRes.thumb_2048_url);
        } else {
            console.log("No data");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
