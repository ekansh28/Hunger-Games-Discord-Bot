require('dotenv').config();

async function run() {
    process.env.AI_GATEWAY_API_KEY = 'vck_2hkgTTJJLvJtELfxe4kLahyMVnF9CLFiH998lpQj7p0JHSkahN1y1z1p';
    const { generateImage } = await import('ai');

    try {
        const result = await generateImage({
            model: 'bytedance/seedream-5.0-lite',
            prompt: 'A turquoise hummingbird resting on a branch covered with dew at sunrise.',
            apiKey: 'vck_2hkgTTJJLvJtELfxe4kLahyMVnF9CLFiH998lpQj7p0JHSkahN1y1z1p'
        });
        console.log("Success!", Object.keys(result));
    } catch (err) {
        console.error('Error:', err.message);
    }
}
run();
