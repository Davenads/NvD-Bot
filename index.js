require('dotenv').config(); // Load environment variables from .env file
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
// Load scheduled tasks module
const { initScheduledTasks } = require('./scheduledTasks');

// Event listener for when the bot becomes ready and online
client.once('ready', () => {
    const timestamp = new Date().toLocaleString();
    console.log(`Logged in as ${client.user.tag} at ${timestamp}`);
    
    // Initialize scheduled tasks (complementing Redis auto-null system)
    initScheduledTasks(client);
});
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
// Login to Discord with your bot token
client.login(process.env.BOT_TOKEN);