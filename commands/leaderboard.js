require('dotenv').config();
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { google } = require('googleapis');
// Import the Google auth helper
const { getGoogleAuth } = require('../fixGoogleAuth');

// Initialize Google Sheets API client
const sheets = google.sheets({
    version: 'v4',
    auth: getGoogleAuth()
});
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'NvD Ladder'; // CHANGED: Updated sheet name
module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-leaderboard') // CHANGED: Added nvd- prefix
        .setDescription('Displays the NvD ladder leaderboard'), // CHANGED: Updated description
    
    async execute(interaction) {
        // Simplified, concise logging
        console.log(`[${new Date().toISOString()}] /nvd-leaderboard by ${interaction.user.tag}`);
        
        let deferred = false;
        const deferIfNecessary = async () => {
            if (!deferred) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                deferred = true;
            }
        };
        try {
            await deferIfNecessary();
            // Fetch data from the Google Sheet
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A2:G`, // CHANGED: Updated range to cover all rows in the new structure
            });
            const rows = result.data.values;
            if (!rows || !rows.length) {
                return await interaction.editReply({ content: 'No data available on the leaderboard.' });
            }
            const validRows = rows.filter(row => row[0] && row[1]); // Filter out rows with missing rank or discord username
            
            // Additional concise logging with player count but not the actual data
            console.log(`[${new Date().toISOString()}] Leaderboard data: ${validRows.length} players found`);
            if (!validRows.length) {
                return await interaction.editReply({ content: 'No valid data available on the leaderboard.' });
            }
            const embeds = [];
            let currentEmbed = new EmbedBuilder()
                .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
                .setTitle(':bone: NvD Ladder Leaderboard :bear:') // CHANGED: Updated title with class emojis
                .setDescription('Current standings in the NvD Ladder.') // CHANGED: Updated description
                .setTimestamp()
                .setFooter({ text: 'NvD Bot Leaderboard', iconURL: interaction.client.user.displayAvatarURL() }); // CHANGED: Updated footer
            // CHANGED: Updated emoji map for Status
            const statusEmojiMap = {
                Available: '✅',
                Challenge: '❌',
                Vacation: '🌴'
            };
            // Process rows into multiple embeds if necessary
            validRows.forEach((row, index) => {
                const rank = row[0] || 'N/A';
                const discordUsername = row[1] || 'Unknown'; // CHANGED: This is now Discord username from column B
                const status = row[2] || 'Available'; // CHANGED: Status is now column C (index 2)
                // CHANGED: Simplified display without element/spec
                const statusEmoji = statusEmojiMap[status] || '';
                currentEmbed.addFields({
                    name: `#${rank} - ${discordUsername}`, // CHANGED: Just display Discord username
                    value: `Status: ${statusEmoji} ${status}`,
                    inline: false
                });
                // If the current embed has reached 15 fields, push it to the array and create a new embed
                if ((index + 1) % 10 === 0 || index === validRows.length - 1) {
                    embeds.push(currentEmbed);
                    currentEmbed = new EmbedBuilder()
                        .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
                        .setTitle('🏆 :bone: NvD Ladder Leaderboard (continued) :bear: 🏆') // CHANGED: Updated title with class emojis
                        .setTimestamp()
                        .setFooter({ text: 'NvD Bot Leaderboard', iconURL: interaction.client.user.displayAvatarURL() }); // CHANGED: Updated footer
                }
            });
            // If only one embed is required
            if (embeds.length === 1) {
                return await interaction.editReply({ embeds: [embeds[0]] });
            }
            // Pagination logic with buttons
            let currentPage = 0;
            const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('first')
                    .setLabel('First')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true), // Initially disable the 'First' button
                new ButtonBuilder()
                    .setCustomId('previous')
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true), // Initially disable the 'Previous' button
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(embeds.length <= 1), // Disable if there's only one page
                new ButtonBuilder()
                    .setCustomId('last')
                    .setLabel('Last')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(embeds.length <= 1) // Disable if there's only one page
            );
            const message = await interaction.editReply({
                embeds: [embeds[currentPage]],
                components: [buttonRow],
            });
            const collector = message.createMessageComponentCollector({
                time: 60000, // Time to listen for button clicks (60 seconds)
            });
            collector.on('collect', async (buttonInteraction) => {
                if (buttonInteraction.customId === 'next') {
                    currentPage++;
                } else if (buttonInteraction.customId === 'previous') {
                    currentPage--;
                } else if (buttonInteraction.customId === 'first') {
                    currentPage = 0;
                } else if (buttonInteraction.customId === 'last') {
                    currentPage = embeds.length - 1;
                }
                await buttonInteraction.update({
                    embeds: [embeds[currentPage]],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('first')
                                .setLabel('First')
                                .setStyle(ButtonStyle.Primary)
                                .setDisabled(currentPage === 0),
                            new ButtonBuilder()
                                .setCustomId('previous')
                                .setLabel('Previous')
                                .setStyle(ButtonStyle.Primary)
                                .setDisabled(currentPage === 0),
                            new ButtonBuilder()
                                .setCustomId('next')
                                .setLabel('Next')
                                .setStyle(ButtonStyle.Primary)
                                .setDisabled(currentPage === embeds.length - 1),
                            new ButtonBuilder()
                                .setCustomId('last')
                                .setLabel('Last')
                                .setStyle(ButtonStyle.Primary)
                                .setDisabled(currentPage === embeds.length - 1)
                        ),
                    ],
                });
            });
            collector.on('end', () => {
                interaction.editReply({
                    components: [], // Remove buttons after the collector ends
                });
            });
        } catch (error) {
            console.error(`Error in leaderboard command: ${error.message}`);
            await deferIfNecessary();
            await interaction.editReply({ content: 'There was an error retrieving the leaderboard data.' });
        }
    },
};