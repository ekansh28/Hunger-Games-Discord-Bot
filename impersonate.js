const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Cooldown: prevent spam impersonates
const impersonateCooldowns = new Map();
const COOLDOWN_MS = 15000;

async function callAI(payload) {
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
        if (response?.status === 429) return null;
        return null;
    }

    const data = await response.json();
    let result = data.choices?.[0]?.message?.content?.trim();
    if (!result) return null;
    return result.replace(/^[""'']|[""'']$/g, '').trim();
}

async function handleImpersonate(message) {
    const target = message.mentions.users.first();
    if (!target) return message.reply('mention someone to impersonate.');
    if (target.bot) return message.reply('not impersonating a bot lmao');

    const now = Date.now();
    const lastUsed = impersonateCooldowns.get(message.author.id) || 0;
    if (now - lastUsed < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
        return message.reply(`wait ${wait}s`);
    }
    impersonateCooldowns.set(message.author.id, now);

    // Fetch recent messages from the target user
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
Generate EXACTLY 2 separate short messages they might send in a row, like a real Discord conversation.
Format your response as two lines, each line being one message. Nothing else — no labels, no quotes, no explanations.
Keep each message short and casual, 1 sentence max. Do NOT start either message with their name.`;

    const userPrompt = `Here are ${displayName}'s recent messages:\n${sampleText}\n\nNow write 2 messages as ${displayName}, one per line:`;

    // google/gemini-2.0-flash-001 — cheapest + most instruction-efficient model on OpenRouter
    const payload = {
        model: 'google/gemini-2.0-flash-001',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        max_tokens: 150,
        temperature: 1.0,
        top_p: 0.95
    };

    try {
        const raw = await callAI(payload);
        if (!raw) return message.reply('failed lol');

        // Split on newlines, filter empty lines, take up to 3
        const msgs = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(0, 3);
        if (msgs.length === 0) return message.reply('nothing came out');

        // Ensure at least 2 — if model only gave 1, duplicate with slight variation
        if (msgs.length === 1) msgs.push(msgs[0]);

        // Send as webhook
        try {
            const webhooks = await message.channel.fetchWebhooks();
            let webhook = webhooks.find(w => w.name === 'Impersonator');
            if (!webhook) {
                webhook = await message.channel.createWebhook({ name: 'Impersonator' });
            }

            const member = message.guild?.members.cache.get(target.id);
            const webhookOpts = {
                username: member?.displayName || target.username,
                avatarURL: target.displayAvatarURL({ dynamic: true })
            };

            // Delete command first so it looks seamless
            await message.delete().catch(() => null);

            for (let i = 0; i < msgs.length; i++) {
                if (i > 0) await new Promise(r => setTimeout(r, 800 + Math.random() * 600)); // natural delay
                await webhook.send({ ...webhookOpts, content: msgs[i] });
            }
        } catch (webhookErr) {
            console.warn('[Impersonate] Webhook failed, falling back:', webhookErr.message);
            const lines = msgs.map(m => `**${displayName}:** ${m}`).join('\n');
            await message.reply(lines);
        }

    } catch (err) {
        console.error('[Impersonate] Error:', err);
        message.reply('died trying');
    }
}

module.exports = { handleImpersonate };
