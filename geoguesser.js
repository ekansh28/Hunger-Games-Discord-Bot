const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const https = require('https');
const cities = require('./cities.json');
const MAPILLARY_TOKEN = process.env.MAPILLARY_TOKEN;

const countryAliases = {
    'usa': 'united states',
    'us': 'united states',
    'america': 'united states',
    'united states of america': 'united states',
    'uk': 'united kingdom',
    'england': 'united kingdom',
    'great britain': 'united kingdom',
    'britain': 'united kingdom',
    'uae': 'united arab emirates',
    'korea': 'south korea',
    'czech republic': 'czechia',
    'holland': 'netherlands'
};

const activeGames = new Set(); // Stores channel IDs

function fetchMapillaryData(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'Authorization': 'OAuth ' + MAPILLARY_TOKEN }, timeout: 5000 }, (res) => {
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
        
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Mapillary API Request Timeout'));
        });
    });
}

async function getRandomMapillaryLocation() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const city = cities[Math.floor(Math.random() * cities.length)];
        
        // Randomize the bbox slightly around the city center to get diverse images
        const latOffset = (Math.random() - 0.5) * 0.05;
        const lonOffset = (Math.random() - 0.5) * 0.05;
        
        const centerLat = city.lat + latOffset;
        const centerLon = city.lon + lonOffset;
        
        // Mapillary bbox: min_lon,min_lat,max_lon,max_lat (max area 0.01)
        const minLon = centerLon - 0.005;
        const maxLon = centerLon + 0.005;
        const minLat = centerLat - 0.005;
        const maxLat = centerLat + 0.005;
        
        const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;
        const url = `https://graph.mapillary.com/images?fields=id,thumb_2048_url&bbox=${bbox}&limit=10`;
        
        try {
            const res = await fetchMapillaryData(url);
            if (res.data && res.data.length > 0) {
                // Pick a random image from the results
                const randomImg = res.data[Math.floor(Math.random() * res.data.length)];
                
                if (randomImg.thumb_2048_url) {
                    return {
                        country: city.country,
                        image_url: randomImg.thumb_2048_url
                    };
                }
            }
        } catch (e) {
            console.error("Mapillary fetch error:", e);
        }
    }
    return null;
}

async function handleGeoGuesser(message) {
    const channelId = message.channel.id;

    if (activeGames.has(channelId)) {
        return message.reply('A GeoGuesser game is already active in this channel.');
    }

    activeGames.add(channelId);
    
    // Send loading message since Mapillary fetch might take a second
    const loadingMsg = await message.channel.send('Loading a random location from the world...');

    const location = await getRandomMapillaryLocation();
    
    if (!location) {
        activeGames.delete(channelId);
        return loadingMsg.edit('Failed to find a location. Please try again!');
    }

    const targetCountry = location.country.toLowerCase();

    const attachment = new AttachmentBuilder(location.image_url, { name: 'geoguesser.jpg' });

    const embed = new EmbedBuilder()
        .setTitle('GeoGuesser')
        .setDescription('Where in the world is this? Type the name of the country in the chat to win!\n\nYou have 30 seconds.')
        .setImage('attachment://geoguesser.jpg')
        .setColor('#0099ff')
        .setFooter({ text: 'GeoGuesser' });

    await loadingMsg.delete().catch(() => null);
    await message.channel.send({ embeds: [embed], files: [attachment] });

    // Set up message collector
    const filter = (m) => !m.author.bot;
    const collector = message.channel.createMessageCollector({ filter, time: 30000 });

    collector.on('collect', (m) => {
        const guess = m.content.trim().toLowerCase();
        
        let normalizedGuess = guess;
        if (countryAliases[guess]) {
            normalizedGuess = countryAliases[guess];
        }

        // Exact match
        if (normalizedGuess === targetCountry) {
            collector.stop('winner');
            activeGames.delete(channelId);
            
            const winEmbed = new EmbedBuilder()
                .setTitle('Winner')
                .setDescription(`Congratulations **${m.author.username}**! The correct answer was **${location.country}**!`)
                .setColor('#00ff00');
                
            m.channel.send({ embeds: [winEmbed] });
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason !== 'winner') {
            activeGames.delete(channelId);
            
            const timeoutEmbed = new EmbedBuilder()
                .setTitle('Time is up')
                .setDescription(`No one guessed the correct country. The answer was **${location.country}**!`)
                .setColor('#ff0000');
                
            message.channel.send({ embeds: [timeoutEmbed] }).catch(() => null);
        }
    });
}

module.exports = {
    handleGeoGuesser
};
