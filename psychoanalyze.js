const { EmbedBuilder } = require('discord.js');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const psychoCooldowns = new Map();
const COOLDOWN_MS = 15000;

async function handlePsychoanalyze(message, globalMessageBuffer) {
    const target = message.mentions.users.first() || message.author;

    const now = Date.now();
    const lastUsed = psychoCooldowns.get(message.author.id) || 0;
    if (now - lastUsed < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
        return message.reply(`wait ${wait}s`);
    }
    psychoCooldowns.set(message.author.id, now);

    let recentMessages = [];
    try {
        if (globalMessageBuffer && globalMessageBuffer.length > 0) {
            recentMessages = globalMessageBuffer
                .filter(m => m.authorId === target.id && m.content && m.content.length > 1 && !m.content.startsWith('='))
                .slice(-150)
                .map(m => {
                    let text = `[${new Date(m.timestamp).toLocaleTimeString()}] `;
                    if (m.replyContext) text += `(Replying to: "${m.replyContext}") -> `;
                    text += `"${m.content}"`;
                    return text;
                });
        }
    } catch (e) {
        console.error('[Psychoanalyze] Failed to read from buffer:', e);
    }

    if (recentMessages.length < 3) {
        return message.reply(`not enough data on ${target.username}. they need to talk more.`);
    }

    await message.channel.sendTyping();

    const displayName = message.guild?.members.cache.get(target.id)?.displayName || target.username;
    const sampleText = recentMessages.join('\n');

    const systemPrompt = `You are a highly analytical, slightly unhinged internet psychologist writing a clinical patient report based on someone's Discord messages.
Your goal is to deeply overanalyze their quirks, grammar, obsessions, and topics, turning their casual chat into a severe psychological condition.

DO NOT just tell them to shut up. DO NOT use generic insults. Be creative, dry, and hyper-specific to the exact things they said.
You are given the time of day and the context of what they are replying to. Use this to make extremely accurate behavioral deductions.

Respond with EXACTLY this JSON format and nothing else. Do not output markdown code blocks. Just the JSON object.

EXAMPLE OUTPUT:
{
  "diagnosis": "Chronically Online Avoidance Syndrome",
  "summary": "This patient exhibits a severe inability to engage with reality, opting instead to respond to serious questions with 'skibidi'. Their late-night posting habits suggest a circadian rhythm permanently altered by TikTok.",
  "symptoms": ["Uses 'bro' as punctuation", "Responds to emotional vulnerability with 'skill issue'", "Active exclusively between 2AM and 5AM"],
  "prognosis": "Will likely communicate entirely in hieroglyphs (emojis) within 5 years."
}`;

    const userPrompt = `Patient name: ${displayName}\n\nTheir Discord messages:\n${sampleText}\n\nGenerate the report:`;

    const payload = {
        model: 'google/gemini-2.5-flash-lite',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
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
            if (!response.ok) {
                const errText = await response.text();
                console.error('[Psychoanalyze] OpenRouter error:', response.status, errText);
                // Body consumed — stop here, don't fall through to json()
                if (response.status === 429) return;
                return message.reply('api failed, try again');
            }
        }

        // Only fall back to Groq if OpenRouter had a network failure (no response at all)
        if (!response && GROQ_API_KEY) {
            const groqPayload = { ...payload, model: 'llama-3.3-70b-versatile' };
            response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(groqPayload)
            });
        }

        if (!response || !response.ok) {
            const errText = response ? await response.text() : 'no response';
            console.error('[Psychoanalyze] API error:', response?.status, errText);
            if (response?.status === 429) return;
            return message.reply('api failed, try again');
        }

        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content?.trim();
        if (!raw) return message.reply('nothing came out');

        let report;
        try {
            // Strip markdown code fences and find the JSON object
            let cleaned = raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
            // Extract JSON object if there's extra text around it
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (jsonMatch) cleaned = jsonMatch[0];
            report = JSON.parse(cleaned);
        } catch (e) {
            console.error('[Psychoanalyze] JSON parse failed:', e.message, '\nRaw:', raw);
            // Fallback: dump raw text into embed
            const embed = new EmbedBuilder()
                .setTitle(`Psychological Profile — ${displayName}`)
                .setDescription(raw.slice(0, 4096))
                .setColor('#1a1a2e')
                .setFooter({ text: 'not a real diagnosis. probably.' });
            return message.reply({ embeds: [embed] });
        }

        const symptoms = Array.isArray(report.symptoms)
            ? report.symptoms.map(s => `- ${s}`).join('\n')
            : String(report.symptoms);

        const isSelf = target.id === message.author.id;
        const referredBy = isSelf
            ? 'self-referred'
            : `referred by ${message.member?.displayName || message.author.username}`;

        const embed = new EmbedBuilder()
            .setTitle(`Psychological Profile — ${displayName}`)
            .setColor('#1a1a2e')
            .setThumbnail(target.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: 'Diagnosis', value: report.diagnosis || 'Unknown', inline: false },
                { name: 'Summary', value: report.summary || 'N/A', inline: false },
                { name: 'Symptoms', value: symptoms || 'none detected', inline: false },
                { name: 'Prognosis', value: report.prognosis || 'grim', inline: false }
            )
            .setFooter({ text: referredBy });

        return message.reply({ embeds: [embed] });

    } catch (err) {
        console.error('[Psychoanalyze] Error:', err);
        message.reply('died trying');
    }
}

module.exports = { handlePsychoanalyze };
