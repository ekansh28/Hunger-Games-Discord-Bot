const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const psychoCooldowns = new Map();
const COOLDOWN_MS = 20000;

async function handlePsychoanalyze(message) {
    const target = message.mentions.users.first() || message.author;

    const now = Date.now();
    const lastUsed = psychoCooldowns.get(message.author.id) || 0;
    if (now - lastUsed < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
        return message.reply(`wait ${wait}s`);
    }
    psychoCooldowns.set(message.author.id, now);

    // Fetch the target's recent messages from the channel
    let recentMessages = [];
    try {
        const fetched = await message.channel.messages.fetch({ limit: 100 });
        recentMessages = fetched
            .filter(m => m.author.id === target.id && m.content && m.content.length > 1 && !m.content.startsWith('='))
            .map(m => m.content)
            .slice(0, 50);
    } catch (e) {
        console.error('[Psychoanalyze] Failed to fetch messages:', e);
    }

    if (recentMessages.length < 3) {
        return message.reply(`not enough data on ${target.username}. they need to talk more.`);
    }

    await message.channel.sendTyping();

    const displayName = message.guild?.members.cache.get(target.id)?.displayName || target.username;
    const sampleText = recentMessages.join('\n');

    const systemPrompt = `You are a completely unhinged, brutally honest, fake clinical psychologist writing a patient report.
Your job is to psychoanalyze someone based only on their Discord messages.
Write a short fake clinical report (3-5 sentences). Use dry, clinical language mixed with dark humor.
Be specific and reference what they actually said. Be brutal but funny. No sugarcoating.
Do NOT use markdown headers. Write it as one flowing paragraph like a real report.
Do NOT start with "Subject" — use their name.`;

    const userPrompt = `The patient's name is ${displayName}. Here are their recent Discord messages:\n\n${sampleText}\n\nWrite the psychological profile:`;

    const payload = {
        model: 'google/gemini-2.0-flash-001',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        max_tokens: 250,
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
                body: JSON.stringify({ ...payload, model: 'llama-3.3-70b-versatile', max_completion_tokens: 250 })
            });
        }

        if (!response || !response.ok) {
            if (response?.status === 429) return;
            return message.reply('my brain broke');
        }

        const data = await response.json();
        let result = data.choices?.[0]?.message?.content?.trim();
        if (!result) return message.reply('nothing came out');

        result = result.replace(/^["""'']|["""'']$/g, '').trim();

        // Format it like an actual report card
        const isSelf = target.id === message.author.id;
        const header = isSelf
            ? `**Psychological Profile — ${displayName}** *(self-referred)*`
            : `**Psychological Profile — ${displayName}** *(referred by ${message.member?.displayName || message.author.username})*`;

        return message.reply(`${header}\n\n${result}`);

    } catch (err) {
        console.error('[Psychoanalyze] Error:', err);
        message.reply('died trying');
    }
}

module.exports = { handlePsychoanalyze };
