# 🏹 Hunger Games Discord Bot

A Discord bot that simulates Hunger Games events with dynamically generated images, similar to BrantSteele's Hunger Games simulator.

## ✨ Features

- **Interactive Lobby System**: Players join using buttons, with live participant tracking
- **Dynamic Image Generation**: Canvas-based images showing participants with their Discord avatars
- **Realistic Game Flow**: The Bloodbath → Day/Night cycles → Special events (Feast, Arena Events)
- **Timed Progression**: Events appear every 4-5 seconds for immersive gameplay
- **Authorized User Control**: Only specific user can start games to prevent spam

## 🎮 How to Play

1. Type `=play` to start a game lobby (requires authorized user)
2. Click "🟢 Join the Game" to enter the simulation
3. Once 4+ players join, the authorized user can click "🔴 Start Game"
4. Watch as the deadly simulation unfolds with dynamic images!

## 🛠️ Setup Instructions

### Prerequisites

- Node.js (v16 or higher)
- Discord bot token
- Canvas dependencies (see below)

### Installation

1. **Clone or download this repository**
   ```bash
   git clone <your-repo-url>
   cd hunger-games-discord-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure the bot**
   - Edit `config.json`
   - Replace `"YOUR_BOT_TOKEN_HERE"` with your Discord bot token
   - Update `authorizedUserId` to your Discord user ID

4. **Canvas Setup** (OS-specific)

   **Windows:**
   ```bash
   npm install --global windows-build-tools
   npm install canvas
   ```

   **macOS:**
   ```bash
   brew install pkg-config cairo pango libpng jpeg giflib librsvg
   npm install canvas
   ```

   **Linux (Ubuntu/Debian):**
   ```bash
   sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
   npm install canvas
   ```

5. **Run the bot**
   ```bash
   npm start
   ```

## 🎯 Game Mechanics

### Stages
- **The Bloodbath**: Initial chaos at the Cornucopia
- **Day/Night Cycles**: Regular survival events
- **The Feast**: Mid-game supply replenishment
- **Arena Events**: Gamemaker interventions (fires, mutts, etc.)

### Event Types
- **Solo Events**: Single participant actions
- **Duels**: Two participants interact
- **Team Events**: Multiple participants work together or fight

### Win Condition
The simulation continues until only one tribute remains alive.

## 📁 Project Structure

```
hunger-games-bot/
├── index.js              # Main bot file
├── config.json           # Bot configuration
├── package.json          # Dependencies
├── events/               # Event data files
│   ├── bloodbath.json    # Bloodbath events
│   ├── day.json          # Daytime events
│   ├── night.json        # Nighttime events
│   ├── feast.json        # Feast events
│   └── arena.json        # Arena/Gamemaker events
└── utils/                # Utility modules
    ├── eventLogic.js     # Game logic and flow
    └── imageGenerator.js # Canvas image generation
```

## ⚙️ Configuration

### config.json
```json
{
  "token": "YOUR_DISCORD_BOT_TOKEN",
  "authorizedUserId": "YOUR_DISCORD_USER_ID"
}
```

### Bot Permissions Required
- Send Messages
- Use Slash Commands (for buttons)
- Attach Files (for images)
- Read Message History

## 🔧 Technical Details

- **Discord.js v14**: Modern Discord API integration
- **Canvas**: Server-side image generation
- **Dynamic Event System**: JSON-based event templates
- **Memory Efficient**: Avatar caching and optimized rendering
- **Error Handling**: Graceful fallbacks for image generation failures

## 🚀 Performance Notes

- Images are generated at 800x900 resolution for optimal Discord display
- Avatar caching prevents repeated downloads
- Events are batched (3-5 per image) to avoid spam
- Timed intervals prevent rate limiting

## 🤝 Contributing

Feel free to add new events by editing the JSON files in the `events/` directory or improve the image generation in `utils/imageGenerator.js`.

## 📜 License

MIT License - feel free to modify and distribute!

---

**May the odds be ever in your favor!** 🎯