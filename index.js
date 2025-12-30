require('dotenv').config(); // Load environment variables from .env file
// Fix Google Auth for Heroku environment
require('./fixGoogleAuth');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const { logError } = require('./logger');
const { logCommandExecution } = require('./utils/commandLogger');
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

            // Check if challenge already exists in Redis (use proper sorted key format)
            const challengeCheck = await redisClient.checkChallenge(rank, opponentRank);
            if (challengeCheck.active) {
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

            // Get challenge date from column D (index 3), or null if not available
            const challengeDate = player[3] || null;

            await redisClient.setChallenge(challenger, target, challengeDate);

            syncedCount++;
            console.log(`✅ Synced challenge: ${player[1]} vs ${opponent[1]}`);
        }
        
        console.log(`🎯 Sync completed: ${syncedCount} challenge pairs synced to Redis`);
        
    } catch (error) {
        console.error('❌ Error syncing existing challenges');
        logError('Error syncing existing challenges', error);
        // Don't crash the bot if sync fails
    }
}

// Function to handle registration button clicks
async function handleRegistrationButton(interaction) {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Registration Button Clicked`);
    console.log(`├─ User: ${interaction.user.tag} (${interaction.user.id})`);
    console.log(`├─ Channel: #${interaction.channel.name} (${interaction.channel.id})`);

    await interaction.deferReply({ ephemeral: true });

    const discUser = interaction.user.username;
    const discUserId = interaction.user.id;

    try {
        const { google } = require('googleapis');
        const { getGoogleAuth } = require('./fixGoogleAuth');

        const sheets = google.sheets({
            version: 'v4',
            auth: getGoogleAuth()
        });

        const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
        const sheetId = 0;

        console.log(`├─ Fetching current ladder data...`);
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `NvD Ladder!A2:H`,
        });

        const rows = result.data.values || [];
        console.log(`├─ Current ladder entries: ${rows.length}`);

        // Check if Discord user already exists
        const existingPlayer = rows.find(row =>
            (row[1] && row[1] === discUser) || (row[5] && row[5] === discUserId)
        );

        if (existingPlayer) {
            console.log(`└─ Error: User already exists on ladder`);
            return interaction.editReply({
                content: 'You already have a character on the NvD ladder.',
                ephemeral: true
            });
        }

        // Find the first empty row
        let emptyRowIndex = rows.length + 2;
        for (let i = 0; i < rows.length; i++) {
            if (!rows[i] || !rows[i][1]) {
                emptyRowIndex = i + 2;
                break;
            }
        }

        console.log(`├─ Registration position: Row ${emptyRowIndex} (Rank #${emptyRowIndex - 1})`);

        // New player row
        const newPlayerRow = [
            emptyRowIndex - 1,
            discUser,
            'Available',
            '',
            '',
            discUserId,
            '',
            ''
        ];

        console.log(`├─ Preparing sheet updates...`);

        // Create requests for copying formatting
        const copyRowIndex = 1;
        const requests = [
            {
                copyPaste: {
                    source: {
                        sheetId: sheetId,
                        startRowIndex: copyRowIndex,
                        endRowIndex: copyRowIndex + 1,
                        startColumnIndex: 1,
                        endColumnIndex: 3
                    },
                    destination: {
                        sheetId: sheetId,
                        startRowIndex: emptyRowIndex - 1,
                        endRowIndex: emptyRowIndex,
                        startColumnIndex: 1,
                        endColumnIndex: 3
                    },
                    pasteType: 'PASTE_FORMAT'
                }
            },
            {
                copyPaste: {
                    source: {
                        sheetId: sheetId,
                        startRowIndex: copyRowIndex,
                        endRowIndex: copyRowIndex + 1,
                        startColumnIndex: 2,
                        endColumnIndex: 3
                    },
                    destination: {
                        sheetId: sheetId,
                        startRowIndex: emptyRowIndex - 1,
                        endRowIndex: emptyRowIndex,
                        startColumnIndex: 2,
                        endColumnIndex: 3
                    },
                    pasteType: 'PASTE_DATA_VALIDATION'
                }
            },
            {
                updateCells: {
                    range: {
                        sheetId: sheetId,
                        startRowIndex: emptyRowIndex - 1,
                        endRowIndex: emptyRowIndex,
                        startColumnIndex: 1,
                        endColumnIndex: 2
                    },
                    rows: [{
                        values: [{
                            userEnteredFormat: {
                                textFormat: {
                                    bold: true
                                }
                            }
                        }]
                    }],
                    fields: 'userEnteredFormat.textFormat.bold'
                }
            }
        ];

        console.log(`├─ Executing batch update for formatting...`);
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: { requests }
        });

        console.log(`├─ Adding new player row...`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `NvD Ladder!A${emptyRowIndex}:H`,
            valueInputOption: 'RAW',
            resource: {
                values: [newPlayerRow]
            }
        });

        console.log(`├─ Setting status to 'Available'...`);
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `NvD Ladder!C${emptyRowIndex}`,
            valueInputOption: 'RAW',
            resource: {
                values: [['Available']]
            }
        });

        console.log(`├─ Creating response embed...`);
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setColor('#8A2BE2')
            .setTitle('✨ New Player Registered to NvD Ladder! ✨')
            .addFields(
                { name: '👤 **Discord User**', value: `**${discUser}** (<@${discUserId}>)`, inline: false },
                { name: '🏆 **Rank**', value: `**#${emptyRowIndex - 1}**`, inline: false }
            )
            .setFooter({ text: 'Successfully added to the NvD Ladder!', iconURL: interaction.client.user.displayAvatarURL() })
            .setTimestamp();

        console.log(`└─ Registration completed successfully`);

        // Reply with the embed
        await interaction.editReply({ embeds: [embed] });

        // Also send a public announcement in the channel
        await interaction.channel.send({ embeds: [embed] });

    } catch (error) {
        console.error(`└─ Error registering player via button`);
        logError('Registration button error', error);
        return interaction.editReply({
            content: 'An error occurred while registering. Please try again later.',
            ephemeral: true
        });
    }
}

// Event listener for handling interactions (slash commands, autocomplete, and buttons)
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        // Button Interaction Handling
        if (interaction.customId === 'nvd-register-button') {
            await handleRegistrationButton(interaction);
            return;
        }
    } else if (interaction.isCommand()) {
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
        // Track command execution time
        const startTime = performance.now();
        let commandError = null;

        try {
            // Execute the command
            await command.execute(interaction);
        } catch (error) {
            commandError = error;
            console.error('Error executing command');
            logError('Command execution error', error);
            // Respond with an error message if command execution fails
            await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
        } finally {
            // Calculate duration and log command execution
            const endTime = performance.now();
            const duration = endTime - startTime;

            // Log the command execution (success or failure)
            await logCommandExecution(interaction, duration, commandError);
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
            console.error('Autocomplete error');
            logError('Autocomplete error', error);
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