require('dotenv').config(); // Load environment variables from .env file
// Fix Google Auth for Heroku environment
require('./fixGoogleAuth');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
// Initialize the Discord client with the necessary intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers, // Added GuildMembers intent for autocomplete
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent // Added MessageContent intent to ensure autocomplete works correctly
    ]
});

// Make client globally available for Redis expiry handlers
global.discordClient = client;

// Create a collection to store commands
client.commands = new Collection();
// Load the command handler
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    client.commands.set(command.data.name, command);
}
// Scheduled tasks module (disabled - kept for potential future use)
// const { initScheduledTasks } = require('./scheduledTasks');

// Event listener for when the bot becomes ready and online
client.once('ready', async () => {
    const timestamp = new Date().toLocaleString();
    console.log(`Logged in as ${client.user.tag} at ${timestamp}`);
    
    // Scheduled tasks disabled - Redis TTL handles challenge expiry automatically
    // initScheduledTasks(client);
    
    // NEW: Sync existing challenges to Redis on startup
    await syncExistingChallenges();
});

// Function to sync existing Google Sheets challenges to Redis
async function syncExistingChallenges() {
    try {
        console.log('🔄 Syncing existing challenges to Redis...');
        
        const { google } = require('googleapis');
        const redisClient = require('./redis-client');
        
        const sheets = google.sheets({
            version: 'v4',
            auth: new google.auth.JWT(
                process.env.GOOGLE_CLIENT_EMAIL,
                null,
                process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                ['https://www.googleapis.com/auth/spreadsheets']
            )
        });
        
        // Fetch current challenges
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'NvD Ladder!A2:H'
        });
        
        const rows = result.data.values || [];
        const challengePlayers = rows.filter(row => 
            row[2] === 'Challenge' && row[4] && row[5] // Status = Challenge, has opponent and Discord ID
        );
        
        console.log(`📊 Found ${challengePlayers.length} players in active challenges`);
        
        if (challengePlayers.length === 0) {
            console.log('✅ No existing challenges to sync');
            return;
        }
        
        // Create Redis entries for existing challenges
        const processedPairs = new Set();
        let syncedCount = 0;
        
        for (const player of challengePlayers) {
            const rank = player[0];
            const opponentRank = player[4];
            const pairKey = [rank, opponentRank].sort().join('-');
            
            if (processedPairs.has(pairKey)) continue;
            
            const opponent = challengePlayers.find(p => p[0] === opponentRank);
            if (!opponent || opponent[4] !== rank) continue; // Verify bidirectional
            
            processedPairs.add(pairKey);
            
            // Check if challenge already exists in Redis
            const existingChallenge = await redisClient.client.get(`nvd:challenge:${rank}:${opponentRank}`);
            if (existingChallenge) {
                console.log(`⏭️ Challenge ${rank} vs ${opponentRank} already exists in Redis`);
                continue;
            }
            
            // Create challenge and locks
            const challenger = {
                discordId: player[5],
                discordName: player[1],
                rank: rank
            };
            
            const target = {
                discordId: opponent[5],
                discordName: opponent[1], 
                rank: opponentRank
            };
            
            await redisClient.setChallenge(challenger, target, client);
            
            const challengeKey = `nvd:challenge:${rank}:${opponentRank}`;
            await redisClient.setPlayerLock(player[5], challengeKey);
            await redisClient.setPlayerLock(opponent[5], challengeKey);
            
            syncedCount++;
            console.log(`✅ Synced challenge: ${player[1]} vs ${opponent[1]}`);
        }
        
        console.log(`🎯 Sync completed: ${syncedCount} challenge pairs synced to Redis`);
        
    } catch (error) {
        console.error('❌ Error syncing existing challenges:', error);
        // Don't crash the bot if sync fails
    }
}
// Event listener for handling interactions (slash commands and autocomplete)
client.on('interactionCreate', async interaction => {
    if (interaction.isCommand()) {
        // Slash Command Handling
        // Retrieve the command from the client's command collection
        const command = client.commands.get(interaction.commandName);
        // If the command doesn't exist, ignore it
        if (!command) return;
        // CHANGED: Check if the user has the '@NvD' role by name, except for register command
        if (command.data.name !== 'nvd-register') {
            const duelerRole = interaction.guild.roles.cache.find(role => role.name === 'NvD');
            if (!duelerRole || !interaction.member.roles.cache.has(duelerRole.id)) {
                return interaction.reply({
                    content: 'You do not have the required @NvD role to use this command.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        try {
            // Execute the command
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            // Respond with an error message if command execution fails
            await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
        }
    } else if (interaction.isAutocomplete()) {
        // Autocomplete Handling
        // Retrieve the command from the client's command collection
        const command = client.commands.get(interaction.commandName);
        // If the command doesn't exist, ignore it
        if (!command) return;
        try {
            // Execute the autocomplete handler
            await command.autocomplete(interaction);
        } catch (error) {
            console.error(error);
        }
    }
});
// Setup a basic HTTP server to satisfy Heroku
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('NvD Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Login to Discord with your bot token
client.login(process.env.BOT_TOKEN);