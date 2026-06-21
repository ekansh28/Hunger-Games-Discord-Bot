
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

        // Provide GEMINI_API_KEY
        if (!process.env.GEMINI_API_KEY) {
            return message.channel.send(`<@${message.author.id}> ❌ GEMINI_API_KEY is missing in .env!`);
        }

        const { GoogleGenAI } = require("@google/genai");
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        // Ask Gemini to analyze the image and the edit instruction
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
            content: `<@${message.author.id}> 🎨 **Edited Image:**\n> *${prompt}*`,
            files: [pollinationsUrl]
        });

    } catch (err) {
        console.error('[GeminiEdit] Error editing image:', err);
        const errMsg = err.message || (err.title ? err.title : JSON.stringify(err));
        return message.channel.send(`<@${message.author.id}> ❌ Failed to edit the image. Error: ${errMsg}`);
    }
}

module.exports = handleEditCommand;
