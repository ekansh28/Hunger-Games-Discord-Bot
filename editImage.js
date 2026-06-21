
async function handleEditCommand(message) {
    const args = message.content.trim().split(/\s+/);
    const prompt = args.slice(1).join(' ');

    if (!prompt) {
        return message.channel.send(`<@${message.author.id}> You need to provide a prompt! Usage: reply to an image with \`=edit <prompt>\``);
    }

    if (!message.reference || !message.reference.messageId) {
        return message.channel.send(`<@${message.author.id}> You need to reply to a message containing an image to edit it.`);
    }

    try {
        let repliedMessage = message.channel.messages.cache.get(message.reference.messageId);
        if (!repliedMessage) {
            repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
        }

        let imageUrl = null;

        // Check for attachments
        if (repliedMessage.attachments.size > 0) {
            const attachment = repliedMessage.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
            if (attachment) imageUrl = attachment.url;
        }

        // Check for embeds if no attachment
        if (!imageUrl && repliedMessage.embeds.length > 0) {
            const embed = repliedMessage.embeds.find(e => e.image || e.thumbnail);
            if (embed && embed.image) imageUrl = embed.image.url;
            else if (embed && embed.thumbnail) imageUrl = embed.thumbnail.url;
        }

        if (!imageUrl) {
            return message.channel.send(`<@${message.author.id}> The message you replied to does not contain a valid image.`);
        }

        // Indicate processing (non-blocking for speed)
        message.channel.sendTyping().catch(() => {});

        // Provide OPENROUTER_API_KEY
        if (!process.env.OPENROUTER_API_KEY) {
            return message.channel.send(`<@${message.author.id}> ❌ OPENROUTER_API_KEY is missing in .env!`);
        }

        const openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "x-ai/grok-imagine-image-quality",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: { url: imageUrl }
                            },
                            {
                                type: "text",
                                text: prompt
                            }
                        ]
                    }
                ],
                modalities: ["image"]
            })
        });

        const result = await openRouterResponse.json();

        if (result.error) {
            throw new Error(result.error.message || JSON.stringify(result.error));
        }

        const messageData = result.choices[0].message;
        
        let finalUrl = null;
        if (messageData.images && messageData.images.length > 0) {
            finalUrl = messageData.images[0].image_url.url;
        } else if (messageData.content) {
            // Sometimes it returns a markdown image link
            const match = messageData.content.match(/!\[.*?\]\((.*?)\)/);
            finalUrl = match ? match[1] : messageData.content;
        }

        if (!finalUrl) {
            throw new Error("No image returned from OpenRouter API.");
        }

        await message.channel.send({
            content: `<@${message.author.id}> 🎨 **Edited Image:**\n> *${prompt}*`,
            files: [finalUrl]
        });

    } catch (err) {
        console.error('[OpenRouter] Error editing image, attempting Gemini fallback...', err.message || err);
        
        // --- GEMINI FALLBACK ---
        try {
            if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
            
            const { GoogleGenAI } = require("@google/genai");
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
            
            // 1. Ask Gemini to analyze the image and the edit instruction
            const responseFetch = await fetch(imageUrl);
            const blob = await responseFetch.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const base64Image = Buffer.from(arrayBuffer).toString("base64");
            
            const geminiPrompt = `Analyze the attached image and apply the user's edit instruction: "${prompt}". Write a highly detailed image generation prompt describing what the final edited image should look like. Only return the prompt text, nothing else.`;
            
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    {
                        role: "user",
                        parts: [
                            { inlineData: { data: base64Image, mimeType: "image/png" } },
                            { text: geminiPrompt }
                        ]
                    }
                ]
            });
            
            const finalPrompt = response.text.trim();
            const encodedPrompt = encodeURIComponent(finalPrompt);
            const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?nologo=true`;
            
            await message.channel.send({
                content: `<@${message.author.id}> ⚠️ *OpenRouter error! Falling back to Gemini Vision...*\n🎨 **Gemini Output:**\n> *${prompt}*`,
                files: [pollinationsUrl]
            });
            
        } catch (geminiErr) {
            console.error('[GeminiFallback] Error:', geminiErr);
            const errMsg = err.message || (err.title ? err.title : JSON.stringify(err));
            return message.channel.send(`<@${message.author.id}> ❌ Failed to edit the image (and Gemini fallback failed). Error: ${errMsg}`);
        }
    }
}

module.exports = handleEditCommand;
