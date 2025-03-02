const { GoogleSpreadsheet } = require('google-spreadsheet');
require('dotenv').config();
const credentials = require('../config/credentials.json');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-cancelchallenge') // CHANGED: Added nvd- prefix
    .setDescription('Cancel a challenge involving a specific player on the NvD ladder.') // CHANGED: Updated description
    .addStringOption(option =>
      option.setName('player')
        .setDescription('The rank number of one player involved in the challenge')
        .setRequired(true)
    ),
  async execute(interaction) {
    // CHANGED: Check if the user has the '@NvD Admin' role
    if (!interaction.member.roles.cache.some(role => role.name === 'NvD Admin')) {
      return interaction.reply('You do not have permission to use this command. Only users with the @NvD Admin role can use it.');
    }

    const playerName = interaction.options.getString('player');

    await interaction.deferReply();

    try {
      // Load the Google Sheet
      const { google } = require('googleapis');

      const sheets = google.sheets({
        version: 'v4',
        auth: new google.auth.JWT(
          credentials.client_email,
          null,
          credentials.private_key,
          ['https://www.googleapis.com/auth/spreadsheets']
        )
      });
      
      const sheetName = 'NvD Ladder'; // CHANGED: Updated sheet name
      console.log('Fetching data from Google Sheets...');
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${sheetName}!A2:H` // CHANGED: Updated range to match new structure
      });
      let rows = result.data.values;
      console.log('Rows fetched:', rows);

      // Filter out empty rows
      rows = rows.filter(row => row[1] && row[1].trim() !== '');
      console.log('Filtered rows:', rows);

      // Find the row for the player
      console.log(`Searching for rank: ${playerName}`);
      const playerRowIndex = rows.findIndex((row) => row[0] && row[0].trim() === playerName.trim());
      console.log('Player row index found:', playerRowIndex);

      if (playerRowIndex === -1) {
        return interaction.editReply('The specified player could not be found. Please check the rank number and try again.');
      }

      const playerRow = rows[playerRowIndex];

      // Find the opponent based on the 'Opp#' column (now in column E, index 4)
      const opponentName = playerRow[4]; // CHANGED: Opp# is now column E (index 4)
      console.log('Opponent name:', opponentName);
      if (!opponentName) {
        return interaction.editReply('The specified player is not currently in a challenge.');
      }

      const opponentRowIndex = rows.findIndex((row) => row[0] && row[0].trim() === opponentName.trim());
      console.log('Opponent row index found:', opponentRowIndex);
      if (opponentRowIndex === -1) {
        return interaction.editReply('The opponent could not be found. Please check the data and try again.');
      }

      const opponentRow = rows[opponentRowIndex];

      // Prepare the updates to clear the challenge information
      const updates = [
        {
          range: `${sheetName}!C${playerRowIndex + 2}:E${playerRowIndex + 2}`, // CHANGED: Status, cDate, Opp# are now columns C-E
          values: [['Available', '', '']]
        },
        {
          range: `${sheetName}!C${opponentRowIndex + 2}:E${opponentRowIndex + 2}`, // CHANGED: Status, cDate, Opp# are now columns C-E
          values: [['Available', '', '']]
        }
      ];

      console.log('Updating player and opponent rows to clear challenge information...');
      // Update player and opponent rows
      for (const update of updates) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: update.range,
          valueInputOption: 'USER_ENTERED',
          resource: { values: update.values }
        });
      }

      // CHANGED: Simplified embed with no spec/element
      const playerDiscUser = playerRow[1]; // CHANGED: Discord username is now column B (index 1)
      const opponentDiscUser = opponentRow[1]; // CHANGED: Discord username is now column B (index 1)

      const embed = new EmbedBuilder()
        .setTitle('⚔️ Challenge Canceled ⚔️')
        .setDescription(`The challenge between **Rank ${playerRow[0]}** and **Rank ${opponentRow[0]}** has been successfully canceled.`)
        .addFields(
          { name: `Rank ${playerRow[0]}`, value: `${playerDiscUser}`, inline: true },
          { name: 'VS', value: '​', inline: true },
          { name: `Rank ${opponentRow[0]}`, value: `${opponentDiscUser}`, inline: true }
        )
        .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('Error canceling the challenge:', error);
      await interaction.editReply('An error occurred while attempting to cancel the challenge. Please try again later.');
    }
  },
};