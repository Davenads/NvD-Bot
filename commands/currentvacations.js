require('dotenv').config();
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { google } = require('googleapis');
const credentials = require('../config/credentials.json');
const { logError } = require('../logger'); // Import the logger

const sheets = google.sheets({ version: 'v4', auth: new google.auth.JWT(
    credentials.client_email, null, credentials.private_key, ['https://www.googleapis.com/auth/spreadsheets']
)});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'NvD Ladder'; // CHANGED: Updated sheet name

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-currentvacations') // CHANGED: Added nvd- prefix
        .setDescription('Display all players currently on vacation in the NvD ladder'), // CHANGED: Updated description
    
    async execute(interaction) {
        try {
            // Fetch all data from the sheet dynamically
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A2:D`, // CHANGED: Updated range to match new column structure
            });

            const rows = result.data.values;
            if (!rows || !rows.length) {
                return interaction.reply({ content: 'No players found.', ephemeral: true });
            }

            // Find players currently in "Vacation" state
            const vacations = rows.filter(row => row[2] === 'Vacation'); // CHANGED: Status is now column C (index 2)
            
            if (vacations.length === 0) {
                return interaction.reply({ content: 'There are currently no players on vacation.', ephemeral: true });
            }

            // Sort players by vacation date (cDate, column D, index 3)
            vacations.sort((a, b) => new Date(a[3]) - new Date(b[3])); // CHANGED: cDate is now column D (index 3)

            // Split vacations into pages of 10 players each
            const pages = [];
            for (let i = 0; i < vacations.length; i += 10) {
                const pageVacations = vacations.slice(i, i + 10);
                const vacationEmbed = new EmbedBuilder()
                    .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
                    .setTitle('🏝️ NvD Vacation Leaderboard 🏝️') // CHANGED: Updated title
                    .setDescription('Who is winning the vacation game? ranked by longest time away... *looks off into sunset*☀️')
                    .setTimestamp()
                    .setFooter({ text: 'We hope to see you back soon!', iconURL: interaction.client.user.displayAvatarURL() });

                pageVacations.forEach(player => {
                    const playerRank = player[0]; // Rank of player
                    const discordUsername = player[1]; // CHANGED: Discord username is now column B (index 1)
                    const vacationDate = player[3] ? player[3].split(',')[0] : 'Enjoying an indefinite holiday 😎'; // CHANGED: cDate is now column D (index 3)

                    // CHANGED: Simplified display without element/spec
                    vacationEmbed.addFields({
                        name: `Rank #${playerRank}: ${discordUsername}`,
                        value: `Start Date: ${vacationDate}`,
                        inline: false
                    });
                });

                pages.push(vacationEmbed);
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
                    .setDisabled(pages.length <= 1), // Disable if there's only one page
                new ButtonBuilder()
                    .setCustomId('last')
                    .setLabel('Last')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(pages.length <= 1) // Disable if there's only one page
            );

            const message = await interaction.reply({
                embeds: [pages[currentPage]],
                components: [buttonRow],
                ephemeral: true
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
                    currentPage = pages.length - 1;
                }

                await buttonInteraction.update({
                    embeds: [pages[currentPage]],
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
                                .setDisabled(currentPage === pages.length - 1),
                            new ButtonBuilder()
                                .setCustomId('last')
                                .setLabel('Last')
                                .setStyle(ButtonStyle.Primary)
                                .setDisabled(currentPage === pages.length - 1)
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
            logError(`Error fetching current vacations: ${error.message}\nStack: ${error.stack}`);
            await interaction.reply({ content: 'There was an error fetching the players on vacation. Please try again.', ephemeral: true });
        }
    },
};