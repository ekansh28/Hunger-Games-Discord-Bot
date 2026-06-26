async function run() {
    try {
        const prompt = encodeURIComponent('make it cyberpunk');
        const imageUrl = encodeURIComponent('https://media.discordapp.net/attachments/1198980443823947930/1328406148013166642/image.png');
        const url = `https://gen.pollinations.ai/image/${prompt}?model=flux&image=${imageUrl}`;
        
        console.log("Fetching:", url);
        const res = await fetch(url);
        console.log("Status:", res.status);
        console.log("Content-Type:", res.headers.get('content-type'));
    } catch (e) {
        console.error(e);
    }
}

run();
