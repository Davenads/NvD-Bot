require('dotenv').config();
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { google } = require('googleapis');
const { logError } = require('../logger'); // Import the logger
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
const SHEET_NAME = 'NvD Ladder'; // CHANGED: Updated sheet name
module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-currentchallenges') // CHANGED: Added nvd- prefix
        .setDescription('Display all current challenges in the NvD ladder'), // CHANGED: Updated description
    
    async execute(interaction) {
        try {
            // Fetch all data from the sheet dynamically
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A2:E`, // CHANGED: Updated range to match new column structure
            });
            const rows = result.data.values;
            if (!rows || !rows.length) {
                return interaction.reply({ content: 'No challenges found.', flags: MessageFlags.Ephemeral });
            }
            // Find players currently in "Challenge" state
            const challenges = rows.filter(row => row[2] === 'Challenge'); // CHANGED: Status is now column C (index 2)
            
            if (challenges.length === 0) {
                return interaction.reply({ content: 'There are currently no active challenges.', flags: MessageFlags.Ephemeral });
            }
            // Track already processed pairs to avoid duplicates
            const processedPairs = new Set();
            // Create an embed to display all current challenges
            const challengeEmbed = new EmbedBuilder()
                .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
                .setTitle('🏆 Current NvD Challenges 🏆') // CHANGED: Updated title
                .setDescription('Here are the ongoing challenges in the NvD Ladder:') // CHANGED: Updated description
                .setTimestamp()
                .setFooter({ text: 'Good luck to all challengers!', iconURL: interaction.client.user.displayAvatarURL() });
            // Add each challenge to the embed, avoiding duplicates
            challenges.forEach(challenge => {
                const challengerRank = challenge[0]; // Rank of challenger
                const challengerName = challenge[1]; // CHANGED: Discord username is now column B (index 1)
                const challengedRank = challenge[4]; // CHANGED: Opp# is now column E (index 4)
                const challengeDate = challenge[3]; // CHANGED: cDate is now column D (index 3)
                const pairKey = `${challengerRank}-${challengedRank}`;
                const reversePairKey = `${challengedRank}-${challengerRank}`;
                // Skip if the reverse pair has already been processed
                if (processedPairs.has(reversePairKey)) {
                    return;
                }
                processedPairs.add(pairKey);
                const challengedPlayer = rows.find(row => row[0] === challengedRank);
                const challengedName = challengedPlayer ? challengedPlayer[1] : 'Unknown'; // CHANGED: Discord username is now column B (index 1)
                // CHANGED: Simplified display without element/spec
                challengeEmbed.addFields({
                    name: `Rank #${challengerRank} vs Rank #${challengedRank}`,
                    value: `**${challengerName}** 🆚 **${challengedName}** • *${challengeDate}*`,
                    inline: false
                });
            });
            // Send the embed privately to the user who invoked the command
            await interaction.reply({ embeds: [challengeEmbed], flags: MessageFlags.Ephemeral });
        } catch (error) {
            logError('Error fetching current challenges', error);
            await interaction.reply({ content: 'There was an error fetching the current challenges. Please try again.', flags: MessageFlags.Ephemeral });
        }
    },
};