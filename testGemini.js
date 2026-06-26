require('dotenv').config();

async function run() {
    const key = 'AQ.Ab8RN6J-0Iv8ZquZBUIF__Uxs7zJsxnolIy-F9BRGTcOx4AGFw';
    
    // Test Imagen 3
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instances: [{ prompt: 'A futuristic cyberpunk city skyline at night' }],
                parameters: { sampleCount: 1 }
            })
        });
        
        const data = await res.json();
        console.log("Response:", JSON.stringify(data).substring(0, 500));
    } catch (e) {
        console.error(e);
    }
}

run();
