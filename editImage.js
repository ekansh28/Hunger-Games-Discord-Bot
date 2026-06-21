const { Client } = require("@gradio/client");

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
        const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
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

        // Indicate processing
        await message.channel.sendTyping();

        // Fetch image to a Blob as required by Gradio
        const response = await fetch(imageUrl);
        const imageBlob = await response.blob();

        // Provide HF_TOKEN to bypass ZeroGPU quota limits if set in .env
        const clientOptions = process.env.HF_TOKEN ? { hf_token: process.env.HF_TOKEN } : {};
        const client = await Client.connect("timbrooks/instruct-pix2pix", clientOptions);
        const result = await client.predict("/generate", {
            input_image: imageBlob,
            instruction: prompt,
            steps: 50,
            randomize_seed: "Randomize Seed",
            seed: Math.floor(Math.random() * 1000000), // Randomize seed manually
            randomize_cfg: "Fix CFG",
            text_cfg_scale: 7.5,
            image_cfg_scale: 1.5,
        });

        // The edited image is element [3] in the returned list
        const outImage = result.data[3];
        const finalUrl = outImage.url ? outImage.url : outImage;

        await message.channel.send({
            content: `<@${message.author.id}>  **Edited Image:**\n> *${prompt}*`,
            files: [finalUrl]
        });

    } catch (err) {
        console.error('[GradioEdit] Error editing image:', err);
        return message.channel.send(`<@${message.author.id}> ❌ Failed to edit the image. Error: ${err.message}`);
    }
}

module.exports = handleEditCommand;
