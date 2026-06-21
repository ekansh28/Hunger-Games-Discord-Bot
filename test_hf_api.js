const fetch = require("node-fetch");
const fs = require("fs");

async function main() {
    try {
        const imageRes = await fetch("https://placehold.co/600x400.png");
        const imageBlob = await imageRes.blob();
        const arrayBuffer = await imageBlob.arrayBuffer();
        const base64Image = Buffer.from(arrayBuffer).toString("base64");
        
        console.log("Sending request to HF API...");
        const response = await fetch(
            "https://api-inference.huggingface.co/models/timbrooks/instruct-pix2pix",
            {
                headers: { 
                    Authorization: "Bearer hf_test_token_here", // I'll use no token or generic token, or user's HF token? The user's env has REPLICATE_API_TOKEN. I can tell them to get an HF token. 
                    "Content-Type": "application/json" 
                },
                method: "POST",
                body: JSON.stringify({
                    inputs: "make it red",
                    image: base64Image
                }),
            }
        );
        console.log(response.status);
        const result = await response.json();
        console.log(result);
    } catch(err) {
        console.error(err);
    }
}
main();
