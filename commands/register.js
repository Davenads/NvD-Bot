// Load environment variables
require('dotenv').config();

// Import necessary modules
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis');
const { logError } = require('../logger'); // Import the logger

// Initialize the Google Sheets API client
const sheets = google.sheets({
    version: 'v4',
    auth: new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      null,
      process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    )
  });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const sheetId = 0; // CHANGED: Numeric sheetId for 'NvD Ladder' tab

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-register') // CHANGED: Added 'nvd-' prefix
        .setDescription('Register a new player to the NvD ladder') // CHANGED: Updated description
        .addStringOption(option =>
            option.setName('discord_user')
                .setDescription('Discord username to register (Admin only)')
                .setRequired(false)
                .setAutocomplete(true)) // Enable dynamic autocomplete for Discord username
        .addStringOption(option =>
            option.setName('notes')
                .setDescription('Optional notes for the player')
                .setRequired(false)),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        // Only show autocomplete options to admin users
        const isAdmin = interaction.member.roles.cache.some(role => role.name === 'NvD Admin');
        
        if (isAdmin && focusedOption.name === 'discord_user') {
            try {
                // CHANGED: Fetch all members with the 'NvD' role
                const guild = interaction.guild;
                const nvdRole = guild.roles.cache.find(role => role.name === 'NvD');
                if (!nvdRole) return interaction.respond([]);

                const members = await guild.members.fetch();
                const eligibleMembers = members.filter(member => member.roles.cache.has(nvdRole.id));

                const choices = eligibleMembers.map(member => member.user.username);
                const filtered = choices.filter(choice => choice.toLowerCase().includes(focusedOption.value.toLowerCase())).slice(0, 25); // Limit choices to 25

                await interaction.respond(
                    filtered.map(choice => ({ name: choice, value: choice }))
                );
            } catch (error) {
                console.error('Error fetching autocomplete options:', error);
                await interaction.respond([]);
            }
        } else {
            await interaction.respond([]);
        }
    },

    async execute(interaction) {
        // Enhanced logging - timestamp and command invocation details
        const timestamp = new Date().toISOString();
        console.log(`\n[${timestamp}] Register Command Execution Started`);
        console.log(`├─ Invoked by: ${interaction.user.tag} (${interaction.user.id})`);
        console.log(`├─ Channel: #${interaction.channel.name} (${interaction.channel.id})`);
        console.log(`├─ Guild: ${interaction.guild.name} (${interaction.guild.id})`);

        await interaction.deferReply(); // Defer the reply to prevent timeout issues

        // Check if the user has the NvD Admin role
        const isAdmin = interaction.member.roles.cache.some(role => role.name === 'NvD Admin');
        console.log(`├─ Admin privileges: ${isAdmin ? 'Yes' : 'No'}`);
        
        // Determine which user to register based on role
        let discUser, discUserId;
        
        if (isAdmin && interaction.options.getString('discord_user')) {
            // Admin is registering another player
            discUser = interaction.options.getString('discord_user');
            const member = interaction.guild.members.cache.find(member => member.user.username === discUser);
            discUserId = member?.id;
            
            console.log(`├─ Registration type: Admin registering another user`);
            console.log(`│  ├─ Target user: ${discUser}`);
            console.log(`│  └─ Target ID: ${discUserId || 'Not found'}`);
            
            if (!discUserId) {
                console.log(`└─ Error: Target Discord user not found`);
                return interaction.editReply({ content: 'Could not find the specified Discord user.', ephemeral: true });
            }
        } else {
            // User is registering themselves
            discUser = interaction.user.username;
            discUserId = interaction.user.id;
            console.log(`├─ Registration type: Self-registration`);
        }
        
        const notes = interaction.options.getString('notes') || '';
        console.log(`├─ Notes provided: ${notes ? 'Yes' : 'No'}`);

        try {
            console.log(`├─ Fetching current ladder data...`);
            // CHANGED: Fetch data from the Google Sheet (Main Tab: 'NvD Ladder')
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `NvD Ladder!A2:H`, // CHANGED: Fetch columns A to H (new structure)
            });

            const rows = result.data.values || [];
            console.log(`├─ Current ladder entries: ${rows.length}`);
            
            // CHANGED: Check if Discord user already exists
            const existingPlayer = rows.find(row => 
                (row[1] && row[1] === discUser) || (row[5] && row[5] === discUserId)
            );
            
            if (existingPlayer) {
                console.log(`└─ Error: User already exists on ladder`);
                return interaction.editReply({
                    content: 'This Discord user already has a character on the NvD ladder.',
                    ephemeral: true
                });
            }

            // Find the first empty row based on the Discord User column (Column B)
            let emptyRowIndex = rows.length + 2; // Default to appending at the end
            for (let i = 0; i < rows.length; i++) {
                if (!rows[i] || !rows[i][1]) { // CHANGED: Check if Column B (DiscUser) is empty
                    emptyRowIndex = i + 2;
                    break;
                }
            }
            console.log(`├─ Registration position: Row ${emptyRowIndex} (Rank #${emptyRowIndex - 1})`);

            // CHANGED: New player row with simplified structure (no spec/element)
            const newPlayerRow = [
                emptyRowIndex - 1, // Rank (new entry based on available position)
                discUser, // Discord username in Column B
                'Available', // Status in Column C
                '', // cDate in Column D
                '', // Opp# in Column E
                discUserId, // Discord user ID in Column F
                notes, // Notes in Column G
                '' // Cooldown in Column H
            ];

            console.log(`├─ Preparing sheet updates...`);
            // Create requests for copying formatting from an existing row
            const copyRowIndex = 1; // Assuming row 2 (index 1) has the desired formatting
            const requests = [
                {
                    copyPaste: {
                        source: {
                            sheetId: sheetId,
                            startRowIndex: copyRowIndex,
                            endRowIndex: copyRowIndex + 1,
                            startColumnIndex: 1, // CHANGED: start from column B
                            endColumnIndex: 3 // CHANGED: end at column C (Status)
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
                            startColumnIndex: 2, // CHANGED: Status column is now C
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
                            startColumnIndex: 1, // CHANGED: Discord username column (B)
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
            // Execute batch update for copying formatting, data validation, and custom styling
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests }
            });

            console.log(`├─ Adding new player row...`);
            // Update the Google Sheet with the new row at the correct position
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `NvD Ladder!A${emptyRowIndex}:H`, // CHANGED: Updated column range
                valueInputOption: 'RAW',
                resource: {
                    values: [newPlayerRow]
                }
            });

            console.log(`├─ Setting status to 'Available'...`);
            // Ensure the Status column (Column C) is set to 'Available' after copying data validation
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `NvD Ladder!C${emptyRowIndex}`, // CHANGED: Status is now column C
                valueInputOption: 'RAW',
                resource: {
                    values: [['Available']]
                }
            });

            console.log(`├─ Creating response embed...`);
            // CHANGED: Create an embed with NvD theme and no spec/element
            const embed = new EmbedBuilder()
                .setColor('#8A2BE2') // Different color for NVD theme
                .setTitle('✨ New Player Registered to NvD Ladder! ✨')
                .addFields(
                    { name: '👤 **Discord User**', value: `**${discUser}** (<@${discUserId}>)`, inline: false },
                    { name: '🏆 **Rank**', value: `**#${emptyRowIndex - 1}**`, inline: false },
                    { name: '📜 **Notes**', value: notes ? `**${notes}**` : 'None', inline: false }
                )
                .setFooter({ text: 'Successfully added to the NvD Ladder!', iconURL: interaction.client.user.displayAvatarURL() })
                .setTimestamp();

            console.log(`└─ Registration completed successfully`);
            // Reply with the embed
            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error(`└─ Error registering new player:`, error);
            logError(`Register command error: ${error.message}\nStack: ${error.stack}`);
            return interaction.editReply({ content: 'An error occurred while registering the player. Please try again later.', ephemeral: true });
        }
    },
};