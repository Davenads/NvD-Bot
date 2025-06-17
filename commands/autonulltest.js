const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { google } = require('googleapis');
const moment = require('moment-timezone');
const { logError } = require('../logger');

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
const DEFAULT_TIMEZONE = 'America/New_York';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-autonulltest')
    .setDescription('Admin command to test auto-null functionality')
    .addStringOption(option =>
      option.setName('days')
        .setDescription('Number of days to backdate challenges (default: 3.5)')
        .setRequired(false)),
  
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    try {
      // Check if the user has the '@NvD Admin' role
      const managerRole = interaction.guild.roles.cache.find(role => role.name === 'NvD Admin');
      if (!managerRole || !interaction.member.roles.cache.has(managerRole.id)) {
        return await interaction.editReply({
          content: 'You do not have the required @NvD Admin role to use this command.',
        });
      }
      
      // Get days option or default to 3.5 days (older than the 3-day threshold)
      const daysToBackdate = parseFloat(interaction.options.getString('days') || '3.5');
      
      // Fetch data from the Google Sheet
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `NvD Ladder!A2:H`,
      });
      
      const rows = result.data.values;
      if (!rows?.length) {
        return await interaction.editReply({
          content: 'No data available on the leaderboard.'
        });
      }
      
      const now = moment().tz(DEFAULT_TIMEZONE);
      const testDate = now.clone().subtract(daysToBackdate, 'days');
      const testDateStr = testDate.format('M/D, h:mm A') + ' EST';
      
      let challengesUpdated = 0;
      let challengesList = [];
      
      // Find active challenges and backdate them
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row[0] || !row[1]) continue; // Skip rows without rank or name
        
        const playerRank = row[0]; // Player Rank
        const discUser = row[1]; // Discord username in column B
        const status = row[2]; // Status in column C
        
        // Only modify active challenges
        if (status === 'Challenge') {
          const rowNumber = i + 2; // +2 because our range starts from A2
          
          // Update the challenge date to be older than 3 days
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `NvD Ladder!D${rowNumber}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[testDateStr]] }
          });
          
          challengesUpdated++;
          challengesList.push(`Rank #${playerRank} (${discUser})`);
        }
      }
      
      if (challengesUpdated > 0) {
        // Create response embed
        const embed = new EmbedBuilder()
          .setTitle('Auto-Null Test Setup')
          .setDescription(`Successfully backdated ${challengesUpdated} challenges to ${testDateStr} (${daysToBackdate} days ago)`)
          .setColor('#8A2BE2')
          .addFields({
            name: 'Modified Challenges',
            value: challengesList.join('\n').substring(0, 1024) || 'None'
          })
          .setFooter({
            text: 'Auto-null scheduled task should pick these up within 3 hours',
            iconURL: interaction.client.user.displayAvatarURL()
          });
        
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({
          content: 'No active challenges found to backdate. Create some challenges first and try again.'
        });
      }
    } catch (error) {
      console.error('Error executing nvd-autonulltest command');
      logError('NvD autonulltest command error', error);
      
      await interaction.editReply({
        content: 'An error occurred while processing the command. Please try again later.'
      });
    }
  },
};