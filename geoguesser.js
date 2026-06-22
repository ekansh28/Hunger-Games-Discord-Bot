const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const https = require('https');
const cities = require('./cities.json');
const GOOGLE_API_KEY = process.env.GOOGLE_STREETVIEW_API_KEY || 'AIzaSyBtRz5rZio6uqq2UEHT2l-HL-6JEq7r3Bg';

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

const locationCache = [];
let isFetchingCache = false;

async function populateCache() {
    if (isFetchingCache) return;
    isFetchingCache = true;
    try {
        while (locationCache.length < 3) {
            const loc = await getRandomGoogleLocation();
            if (loc) {
                locationCache.push(loc);
            }
        }
    } catch (e) {
        console.error("Cache populate error:", e);
    }
    isFetchingCache = false;
}

async function checkGoogleStreetViewMetadata(lat, lon) {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&radius=2000&key=${GOOGLE_API_KEY}`;
    return new Promise((resolve) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status === 'OK' && json.location) {
                        resolve(json.location);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

async function getRandomGoogleLocation() {
    const uniqueCountries = [...new Set(cities.map(c => c.country))];

    for (let attempt = 0; attempt < 10; attempt++) {
        // Pick a country uniformly at random to ensure equal chances
        const randomCountry = uniqueCountries[Math.floor(Math.random() * uniqueCountries.length)];
        const countryCities = cities.filter(c => c.country === randomCountry);
        const city = countryCities[Math.floor(Math.random() * countryCities.length)];
        
        // Randomize the coordinates slightly around the city center
        const latOffset = (Math.random() - 0.5) * 0.05;
        const lonOffset = (Math.random() - 0.5) * 0.05;
        
        const centerLat = city.lat + latOffset;
        const centerLon = city.lon + lonOffset;
        
        // Check if there is actual Google Street View coverage here
        const panoLocation = await checkGoogleStreetViewMetadata(centerLat, centerLon);
        
        if (panoLocation) {
            // Randomize camera angle
            const heading = Math.floor(Math.random() * 360);
            const pitch = Math.floor(Math.random() * 20) - 10; // -10 to +10 degrees
            
            const imageUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${panoLocation.lat},${panoLocation.lng}&heading=${heading}&pitch=${pitch}&fov=90&key=${GOOGLE_API_KEY}`;
            
            return {
                country: city.country,
                image_url: imageUrl
            };
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
    
    // Pop from cache if available
    let location = locationCache.shift();
    let loadingMsg = null;
    
    // Kick off background task to refill cache
    populateCache();

    if (!location) {
        // Cache was empty, fetch dynamically
        loadingMsg = await message.channel.send('Loading a random location from the world...');
        location = await getRandomGoogleLocation();
    }
    
    if (!location) {
        activeGames.delete(channelId);
        if (loadingMsg) {
            return loadingMsg.edit('Failed to find a location. Please try again!');
        } else {
            return message.channel.send('Failed to find a location. Please try again!');
        }
    }

    const targetCountry = location.country.toLowerCase();

    const attachment = new AttachmentBuilder(location.image_url, { name: 'geoguesser.jpg' });

    const embed = new EmbedBuilder()
        .setTitle('GeoGuesser')
        .setDescription('Where in the world is this? Type the name of the country in the chat to win!\n\nYou have 30 seconds.')
        .setImage('attachment://geoguesser.jpg')
        .setColor('#0099ff')
        .setFooter({ text: 'GeoGuesser' });

    if (loadingMsg) {
        await loadingMsg.delete().catch(() => null);
    }
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
        } else {
            // Only cross-react if the guess is actually a valid country
            // uniqueCountries is computed in getRandomMapillaryLocation, but we can compute it here or use cities directly
            const isValidCountry = cities.some(c => c.country.toLowerCase() === normalizedGuess);
            if (isValidCountry) {
                m.react('❌').catch(() => null);
            }
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
    handleGeoGuesser,
    populateCache // export to initialize on bot startup
};
