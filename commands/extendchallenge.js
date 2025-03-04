const { GoogleSpreadsheet } = require('google-spreadsheet');
require('dotenv').config();
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { DateTime } = require('luxon');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-extendchallenge') // CHANGED: Added nvd- prefix
    .setDescription('Extend the challenge date involving a specific player on the NvD ladder.') // CHANGED: Updated description
    .addStringOption(option =>
      option.setName('player')
        .setDescription('The rank or name of the player involved in the challenge')
        .setRequired(true)
    ),
  async execute(interaction) {
    // CHANGED: Check if the user has the '@NvD Admin' role
    if (!interaction.member.roles.cache.some(role => role.name === 'NvD Admin')) {
      return interaction.reply('You do not have permission to use this command. Only users with the @NvD Admin role can use it.');
    }

    const playerInput = interaction.options.getString('player').trim();

    await interaction.deferReply();

    try {
      // Load the Google Sheet
      const { google } = require('googleapis');

      const sheets = google.sheets({
        version: 'v4',
        auth: new google.auth.JWT(
          process.env.GOOGLE_CLIENT_EMAIL,
          null,
          process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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
      console.log('Rows fetched:', JSON.stringify(rows, null, 2));

      // Filter out empty rows
      rows = rows.filter(row => row[0] && row[1] && row[1].trim() !== '');
      console.log('Filtered rows:', JSON.stringify(rows, null, 2));

      // Find the row for the player based on rank or Discord username
      console.log(`Searching for player: ${playerInput}`);
      const playerRowIndex = rows.findIndex((row) => row[0].trim() === playerInput || row[1].trim().toLowerCase() === playerInput.toLowerCase());
      console.log('Player row index found:', playerRowIndex);

      if (playerRowIndex === -1) {
        console.log('Player not found in the rows. Please verify the player name or rank.');
        return interaction.editReply('The specified player could not be found. Please check the rank or name and try again.');
      }

      const playerRow = rows[playerRowIndex];
      console.log('Player row data:', JSON.stringify(playerRow, null, 2));

      // Find the opponent based on the 'Opp#' column (now in column E, index 4)
      const opponentRank = playerRow[4].trim(); // CHANGED: Opp# is now column E (index 4)
      console.log('Opponent rank:', opponentRank);
      if (!opponentRank) {
        return interaction.editReply('The specified player is not currently in a challenge.');
      }

      const opponentRowIndex = rows.findIndex((row) => row[0].trim() === opponentRank);
      console.log('Opponent row index found:', opponentRowIndex);
      if (opponentRowIndex === -1) {
        console.log('Opponent not found in the rows. Please verify the opponent rank and data.');
        return interaction.editReply('The opponent could not be found. Please check the data and try again.');
      }

      const opponentRow = rows[opponentRowIndex];
      console.log('Opponent row data:', JSON.stringify(opponentRow, null, 2));

      // Verify both players have the correct 'Opp#' entries pointing to each other
      if (playerRow[4].trim() !== opponentRow[0].trim() || opponentRow[4].trim() !== playerRow[0].trim()) {
        console.log('Mismatch in Opp# columns. Player and opponent are not in a valid challenge pair.');
        return interaction.editReply('The specified players are not currently in a valid challenge with each other. Please verify the challenge pair.');
      }

      // Parse the current challenge date from the player's row and extend it by 2 days
      let currentChallengeDateString = playerRow[3]; // CHANGED: cDate is now column D (index 3)
      console.log('Parsing current challenge date:', currentChallengeDateString);

      // Remove any timezone abbreviation (like EDT, EST)
      const timezoneRegex = /\s(EDT|EST)$/;
      let timezoneAbbreviation = '';
      if (timezoneRegex.test(currentChallengeDateString)) {
        timezoneAbbreviation = currentChallengeDateString.match(timezoneRegex)[1];
        currentChallengeDateString = currentChallengeDateString.replace(timezoneRegex, '');
      }
      console.log('Challenge date after removing timezone abbreviation:', currentChallengeDateString);

      const possibleFormats = [
        'M/d, h:mm a',
        'M/d/yyyy, h:mm a'
      ];

      let currentChallengeDate = null;
      for (const format of possibleFormats) {
        currentChallengeDate = DateTime.fromFormat(currentChallengeDateString, format, { zone: 'America/New_York' });
        if (currentChallengeDate.isValid) {
          break;
        }
      }

      if (!currentChallengeDate || !currentChallengeDate.isValid) {
        console.log('Invalid current challenge date:', playerRow[3]); // CHANGED: cDate is now column D (index 3)
        return interaction.editReply('The current challenge date format is invalid. Please check the data in the Google Sheet.');
      }

      const extendedDate = currentChallengeDate.plus({ days: 2 });
      const formattedDate = `${extendedDate.toFormat('M/d, h:mm a')} ${timezoneAbbreviation}`;

      const updates = [
        {
          range: `${sheetName}!D${playerRowIndex + 2}`, // CHANGED: cDate is now column D
          values: [[formattedDate]],
          previousValue: playerRow[3] // CHANGED: cDate is now column D (index 3)
        },
        {
          range: `${sheetName}!D${opponentRowIndex + 2}`, // CHANGED: cDate is now column D
          values: [[formattedDate]],
          previousValue: opponentRow[3] // CHANGED: cDate is now column D (index 3)
        }
      ];

      console.log('Updating player and opponent rows to extend challenge date...');
      // Update player and opponent rows
      for (const update of updates) {
        console.log(`Updating range: ${update.range} from previous value: ${update.previousValue} to new value: ${formattedDate}`);
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
        .setTitle('⏳ Challenge Extended ⏳')
        .setDescription(`The challenge between **${playerDiscUser}** and **${opponentDiscUser}** has been successfully extended.`)
        .addFields(
          { name: `Player: ${playerDiscUser}`, value: `New Challenge Date: ${formattedDate}`, inline: true },
          { name: 'VS', value: '​', inline: true },
          { name: `Opponent: ${opponentDiscUser}`, value: `New Challenge Date: ${formattedDate}`, inline: true }
        )
        .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('Error extending the challenge:', error);
      await interaction.editReply('An error occurred while attempting to extend the challenge. Please try again later.');
    }
  },
};