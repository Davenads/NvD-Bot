// Load environment variables
require('dotenv').config();

// Import necessary modules
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis');
const credentials = require('../config/credentials.json');

// Initialize the Google Sheets API client
const sheets = google.sheets({
    version: 'v4',
    auth: new google.auth.JWT(
        credentials.client_email,
        null,
        credentials.private_key.replace(/\n/g, '\n'),
        ['https://www.googleapis.com/auth/spreadsheets']
    ),
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const sheetId = 0; // CHANGED: Numeric sheetId for 'NvD Ladder' tab

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-register') // CHANGED: Added 'nvd-' prefix
        .setDescription('Register a new player to the NvD ladder') // CHANGED: Updated description
        .addStringOption(option =>
            option.setName('disc_user')
                .setDescription('The Discord username of the player')
                .setRequired(true)
                .setAutocomplete(true)) // Enable dynamic autocomplete for Discord username
        .addStringOption(option =>
            option.setName('notes')
                .setDescription('Optional notes for the player')
                .setRequired(false)),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name === 'disc_user') {
            try {
                // CHANGED: Fetch all members with the 'NvD' role
                const guild = interaction.guild;
                const duelerRole = guild.roles.cache.find(role => role.name === 'NvD');
                if (!duelerRole) return interaction.respond([]);

                const members = await guild.members.fetch();
                const eligibleMembers = members.filter(member => member.roles.cache.has(duelerRole.id));

                const choices = eligibleMembers.map(member => member.user.username);
                const filtered = choices.filter(choice => choice.toLowerCase().includes(focusedOption.value.toLowerCase())).slice(0, 25); // Limit choices to 25

                await interaction.respond(
                    filtered.map(choice => ({ name: choice, value: choice }))
                );
            } catch (error) {
                console.error('Error fetching autocomplete options:', error);
                await interaction.respond([]);
            }
        }
    },

    async execute(interaction) {
        await interaction.deferReply(); // Defer the reply to prevent timeout issues

        // CHANGED: Check if the user has the '@NvD Admin' role
        const managerRole = interaction.guild.roles.cache.find(role => role.name === 'NvD Admin');
        if (!managerRole || !interaction.member.roles.cache.has(managerRole.id)) {
            return interaction.editReply({
                content: 'You do not have the required @NvD Admin role to use this command.',
                ephemeral: true
            });
        }

        // Retrieve command options
        const discUser = interaction.options.getString('disc_user');
        const discUserId = interaction.guild.members.cache.find(member => member.user.username === discUser)?.id;
        const notes = interaction.options.getString('notes') || '';

        if (!discUserId) {
            return interaction.editReply({ content: 'Could not find the specified Discord user.', ephemeral: true });
        }

        try {
            // CHANGED: Fetch data from the Google Sheet (Main Tab: 'NvD Ladder')
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `NvD Ladder!A2:H`, // CHANGED: Fetch columns A to H (new structure)
            });

            const rows = result.data.values || [];
            
            // CHANGED: Check if Discord user already exists
            const existingPlayer = rows.find(row => 
                row[1] === discUser || row[5] === discUserId
            );
            
            if (existingPlayer) {
                return interaction.editReply({
                    content: 'This Discord user already has a character on the NvD ladder.',
                    ephemeral: true
                });
            }

            // Find the first empty row based on the Discord User column (Column B)
            let emptyRowIndex = rows.length + 2; // Default to appending at the end
            for (let i = 0; i < rows.length; i++) {
                if (!rows[i][1]) { // CHANGED: Check if Column B (DiscUser) is empty
                    emptyRowIndex = i + 2;
                    break;
                }
            }

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

            // Execute batch update for copying formatting, data validation, and custom styling
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests }
            });

            // Update the Google Sheet with the new row at the correct position
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `NvD Ladder!A${emptyRowIndex}:H`, // CHANGED: Updated column range
                valueInputOption: 'RAW',
                resource: {
                    values: [newPlayerRow]
                }
            });

            // Ensure the Status column (Column C) is set to 'Available' after copying data validation
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `NvD Ladder!C${emptyRowIndex}`, // CHANGED: Status is now column C
                valueInputOption: 'RAW',
                resource: {
                    values: [['Available']]
                }
            });

            // CHANGED: Create an embed with NvD theme and no spec/element
            const embed = new EmbedBuilder()
                .setColor('#8A2BE2') // Different color for NVD theme
                .setTitle('✨ New Player Registered to NVD Ladder! ✨')
                .addFields(
                    { name: '👤 **Discord User**', value: `**${discUser}**`, inline: false },
                    { name: '📜 **Notes**', value: notes ? `**${notes}**` : 'None', inline: false }
                )
                .setFooter({ text: 'Successfully added to the NvD Ladder!', iconURL: interaction.client.user.displayAvatarURL() })
                .setTimestamp();

            // Reply with the embed
            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Error registering new player:', error);
            return interaction.editReply({ content: 'An error occurred while registering the player. Please try again later.', ephemeral: true });
        }
    },
};