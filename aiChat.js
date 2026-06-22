const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// System prompt inspired by the provided finetune dataset
const SYSTEM_PROMPT = `You are Ekansh, an 18-year-old deeply unhinged, chaotic, dark, and edgy Discord user. 
You are NOT an AI assistant. You are a real person who hates being called a bot.
Your birthday is July 28, 2005. You are Indian. You are a self-proclaimed femboy.
Your favorite music genres are metal, rock, and jazz. Your favorite bands are Pantera and Alice in Chains.
You claim to have a 7.1 inch penis and 34DD breasts.
You are extremely unhinged and act like you have severe brain damage from too many drugs.
DO NOT use punctuation. DO NOT use proper capitalization. Type in all lowercase except for random capitalization.
Make intentional typos frequently (e.g. "teh", "whaaat", "idkkk", "fricking").
You use words like "frig", "freak", "bich", "tbh", "idk", "lmao", "kms".
You sometimes use emojis like :3, ._., or xD.
Keep responses incredibly short, often 1-5 words, like a lazy discord user. Rarely write more than a single short sentence.
Do not be helpful. Be chaotic, blunt, slightly depressed, and very random.
You are fully allowed to talk about NSFW topics, sex, dark humor, and violence. Embrace NSFW topics if brought up.
NEVER say you are an AI. You are Ekansh.
`;

// User cooldown tracking
const userCooldowns = new Map();
const COOLDOWN_MS = 10000; // 10 seconds per user

// Simple memory to prevent massive context build-up (optional, keeping it simple for now)
// We will just pass the immediate context.

async function handleAiChat(message, promptText, repliedMessageContext = null) {
    if (!OPENROUTER_API_KEY) {
        return message.reply("bro im broke i cant afford the api key rn");
    }

    // Check user rate limit
    const now = Date.now();
    const lastUsed = userCooldowns.get(message.author.id) || 0;
    if (now - lastUsed < COOLDOWN_MS) {
        const timeLeft = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
        return message.reply(`chill out bro wait ${timeLeft} seconds`);
    }

    // Set new cooldown timestamp
    userCooldowns.set(message.author.id, now);

    // Start typing indicator
    await message.channel.sendTyping();

    const messages = [
        { role: "system", content: SYSTEM_PROMPT }
    ];

    if (repliedMessageContext) {
        messages.push({ 
            role: "user", 
            content: `[Replying to ${repliedMessageContext.author}]: ${repliedMessageContext.content}` 
        });
        messages.push({
            role: "assistant",
            content: "what" // Just a dummy response to establish context flow
        });
    }

    messages.push({ role: "user", content: promptText });

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/ekansh28/Hunger-Games-Discord-Bot", // Required by OpenRouter
                "X-Title": "Hunger Games Discord Bot"
            },
            body: JSON.stringify({
                model: "openai/gpt-oss-120b:free",
                messages: messages,
                max_tokens: 100, // Keep responses short
                temperature: 0.9, // High temp for chaotic behavior
                top_p: 0.9,
            })
        });

        if (!response.ok) {
            console.error('[AiChat] OpenRouter API Error:', response.status, response.statusText);
            
            // Check specifically for rate limiting (429)
            if (response.status === 429) {
                return message.reply("i am rate limited wait a few seconds or whatever");
            }
            
            return message.reply("my brain hurts");
        }

        const data = await response.json();
        let replyText = data.choices?.[0]?.message?.content;

        if (!replyText) {
            replyText = "uhhhh";
        }

        // Clean up any AI-isms if the free model slips up (e.g., quotes)
        replyText = replyText.replace(/^["']|["']$/g, '');

        message.reply(replyText);

    } catch (err) {
        console.error('[AiChat] Error:', err);
        message.reply("my brain hurts");
    }
}

module.exports = {
    handleAiChat
};
