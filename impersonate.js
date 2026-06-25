const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Cooldown: prevent spam impersonates
const impersonateCooldowns = new Map();
const COOLDOWN_MS = 15000;

async function handleImpersonate(message) {
    const target = message.mentions.users.first();
    if (!target) {
        return message.reply('mention someone to impersonate.');
    }

    if (target.bot) {
        return message.reply('not impersonating a bot lmao');
    }

    const now = Date.now();
    const lastUsed = impersonateCooldowns.get(message.author.id) || 0;
    if (now - lastUsed < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
        return message.reply(`wait ${wait}s`);
    }
    impersonateCooldowns.set(message.author.id, now);

    // Fetch the last 40 messages in the channel and filter to the target user
    let recentMessages = [];
    try {
        const fetched = await message.channel.messages.fetch({ limit: 100 });
        recentMessages = fetched
            .filter(m => m.author.id === target.id && m.content && m.content.length > 1 && !m.content.startsWith('='))
            .map(m => m.content)
            .slice(0, 25);
    } catch (e) {
        console.error('[Impersonate] Failed to fetch messages:', e);
    }

    if (recentMessages.length < 3) {
        return message.reply(`${target.username} hasn't said enough here for me to work with.`);
    }

    await message.channel.sendTyping();

    const sampleText = recentMessages.join('\n');
    const displayName = message.guild?.members.cache.get(target.id)?.displayName || target.username;

    const systemPrompt = `You are mimicking a specific Discord user named "${displayName}". 
Study their writing style, vocabulary, humor, tone, and quirks from their recent messages.
Then generate ONE realistic message they might send, in their exact style.
Do not use quotation marks. Do not explain what you're doing. Just write the message.
Keep it short — 1 to 2 sentences max, like a casual Discord message.
Do NOT start with their name. Just write what they'd say.`;

    const userPrompt = `Here are ${displayName}'s recent messages:\n${sampleText}\n\nNow write one message as ${displayName}:`;

    // google/gemini-2.0-flash-001 — cheapest + most instruction-efficient model on OpenRouter
    const payload = {
        model: 'google/gemini-2.0-flash-001',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        max_tokens: 100,
        temperature: 1.0,
        top_p: 0.95
    };

    try {
        let response;

        if (OPENROUTER_API_KEY) {
            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
        }

        if ((!response || !response.ok) && GROQ_API_KEY) {
            response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ...payload, model: 'llama-3.3-70b-versatile', max_completion_tokens: 100 })
            });
        }

        if (!response || !response.ok) {
            if (response?.status === 429) return;
            return message.reply('failed lol');
        }

        const data = await response.json();
        let result = data.choices?.[0]?.message?.content?.trim();

        if (!result) return message.reply('nothing came out');

        // Strip quotes if model wraps it
        result = result.replace(/^["""'']|["""'']$/g, '').trim();

        // Send as a webhook to make it look like the actual user
        try {
            const webhooks = await message.channel.fetchWebhooks();
            let webhook = webhooks.find(w => w.name === 'Impersonator');
            if (!webhook) {
                webhook = await message.channel.createWebhook({ name: 'Impersonator' });
            }

            const member = message.guild?.members.cache.get(target.id);
            await webhook.send({
                content: result,
                username: member?.displayName || target.username,
                avatarURL: target.displayAvatarURL({ dynamic: true })
            });

            // Delete the original command so it looks seamless
            await message.delete().catch(() => null);
        } catch (webhookErr) {
            // No webhook perms — fall back to plaintext
            console.warn('[Impersonate] Webhook failed, falling back:', webhookErr.message);
            await message.reply(`**${displayName}:** ${result}`);
        }

    } catch (err) {
        console.error('[Impersonate] Error:', err);
        message.reply('died trying');
    }
}

module.exports = { handleImpersonate };
