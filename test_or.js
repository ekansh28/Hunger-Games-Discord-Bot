async function main() {
    const imageUrl = "https://placehold.co/600x400.png";
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "nvidia/nemotron-nano-12b-v2-vl:free",
            messages: [{
                role: "user",
                content: [
                    { type: "image_url", image_url: { url: imageUrl } },
                    { type: "text", text: "Describe this image." }
                ]
            }]
        })
    });
    const result = await res.json();
    console.dir(result, { depth: null });
}
main();
