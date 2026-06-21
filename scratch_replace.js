const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'infection.js');
let content = fs.readFileSync(filePath, 'utf8');

// We only want to replace message.reply within handleVirusCommand and command == 'top'
// Let's replace `message.reply('` with `message.channel.send(\`<@${message.author.id}> `
// and closing `'` with `\``
// Actually, some use backticks inside, e.g. `Usage: \`=virus...\``, so we need to be careful.

content = content.replace(/return message\.reply\('([^']+)'\);/g, (match, p1) => {
    // p1 might contain \` which is fine inside \`...\`
    return `return message.channel.send(\`<@\${message.author.id}> ${p1}\`);`;
});

// For top command:
content = content.replace(/return message\.reply\(`([^`]+)`\);/g, (match, p1) => {
    return `return message.channel.send(\`<@\${message.author.id}> ${p1}\`);`;
});

fs.writeFileSync(filePath, content);
console.log('Replaced message.reply in infection.js');
