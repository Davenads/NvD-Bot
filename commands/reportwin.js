// Load environment variables
require('dotenv').config()
// Import necessary modules
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js')
const { google } = require('googleapis')
const { logError } = require('../logger')
const redisClient = require('../redis-client');
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
const SPREADSHEET_ID = process.env.SPREADSHEET_ID
const sheetId = 0 // CHANGED: Numeric sheetId for 'NvD Ladder' tab
const metricsSheetId = 1 // CHANGED: Numeric sheetId for 'Metrics' tab
// Victory messages for different scenarios
const victoryMessages = {
  defense: [
    'defended their position with unwavering resolve! 🛡️',
    'stood their ground magnificently! ⚔️',
    'proved why they earned their rank! 🏆',
    'successfully protected their standing! 🛡️'
  ],
  climb: [
    'climbed the ranks with an impressive victory! 🏔️',
    'proved their worth and ascended! ⚡',
    'showed they deserve a higher position! 🌟',
    'conquered new heights in the ladder! 🎯'
  ]
}
module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-reportwin') // CHANGED: Added nvd- prefix
    .setDescription('Report the results of a challenge on the NvD ladder') // CHANGED: Updated description
    .addIntegerOption(option =>
      option
        .setName('winner_rank')
        .setDescription('The rank number of the winner')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('loser_rank')
        .setDescription('The rank number of the loser')
        .setRequired(true)
    ),
  async execute (interaction) {
    if (interaction.channelId !== '1144011555378298910') { // CHANGED: Updated channel ID
      return await interaction.reply({
        content: 'This command can only be used in the #nvd-challenges channel.', // CHANGED: Updated channel name
        flags: MessageFlags.Ephemeral
      })
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    console.log(`\n[${new Date().toISOString()}] Report Win Command`)
    console.log(
      `├─ Invoked by: ${interaction.user.tag} (${interaction.user.id})`
    )
    const winnerRank = interaction.options.getInteger('winner_rank')
    const loserRank = interaction.options.getInteger('loser_rank')
    console.log(`├─ Winner Rank: ${winnerRank}`)
    console.log(`├─ Loser Rank: ${loserRank}`)
    try {
      // Fetch data from the Google Sheet
      console.log('├─ Fetching data from Google Sheets...')
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `NvD Ladder!A2:H` // CHANGED: Updated sheet name and column range
      })
      const rows = result.data.values
      if (!rows?.length) {
        console.log('└─ Error: No data found in leaderboard')
        return interaction.editReply({
          content: 'No data available on the leaderboard.'
        })
      }
      // Find the winner and loser rows
      const winnerRow = rows.find(row => parseInt(row[0]) === winnerRank)
      const loserRow = rows.find(row => parseInt(row[0]) === loserRank)
      if (!winnerRow || !loserRow) {
        console.log('└─ Error: Invalid ranks provided')
        return interaction.editReply({ content: 'Invalid ranks provided.' })
      }
      // Permission check
      const userId = interaction.user.id
      const winnerDiscordId = winnerRow[5] // CHANGED: Discord ID is now column F (index 5)
      const loserDiscordId = loserRow[5] // CHANGED: Discord ID is now column F (index 5)
      const hasPermission =
        userId === winnerDiscordId ||
        userId === loserDiscordId ||
        interaction.member.roles.cache.some(role => role.name === 'NvD Admin') // CHANGED: Updated role name
      if (!hasPermission) {
        console.log('└─ Error: User lacks permission')
        return interaction.editReply({
          content: 'You do not have permission to report this challenge result.'
        })
      }
      // NEW: Validate that players are in a challenge together
      const winnerStatus = winnerRow[2] // Status is now column C (index 2)
      const loserStatus = loserRow[2] // Status is now column C (index 2)
      const winnerOpponent = winnerRow[4] // Opp# is now column E (index 4)
      const loserOpponent = loserRow[4] // Opp# is now column E (index 4)
      
      // Check if both players are in challenge status
      if (winnerStatus !== 'Challenge' || loserStatus !== 'Challenge') {
        console.log('└─ Error: One or both players are not in a challenge')
        return interaction.editReply({
          content: 'One or both players are not in a challenge status. Cannot report a win.'
        })
      }
      
      // Check if players are challenging each other
      if (parseInt(winnerOpponent) !== loserRank || parseInt(loserOpponent) !== winnerRank) {
        console.log('└─ Error: Players are not challenging each other')
        console.log(`│  ├─ Winner's opponent: ${winnerOpponent}, Loser rank: ${loserRank}`)
        console.log(`│  └─ Loser's opponent: ${loserOpponent}, Winner rank: ${winnerRank}`)
        return interaction.editReply({
          content: 'These players are not in a challenge with each other. Cannot report a win.'
        })
      }
      console.log('├─ Processing match result...')
      // CHANGED: Store player details with simplified structure
      const winnerDetails = {
        discordName: winnerRow[1] // CHANGED: Discord username is now column B (index 1)
      }
      const loserDetails = {
        discordName: loserRow[1] // CHANGED: Discord username is now column B (index 1)
      }
      const isDefense = winnerRank < loserRank
      console.log(`├─ Match Type: ${isDefense ? 'Defense' : 'Climb'}`)
      // Prepare row updates
      let updatedWinnerRow = [...winnerRow]
      let updatedLoserRow = [...loserRow]
      if (!isDefense) {
        // Swap rows for climb victory
        console.log('├─ Performing rank swap...')
        updatedWinnerRow = [...loserRow]
        updatedWinnerRow[0] = String(winnerRow[0])
        updatedLoserRow = [...winnerRow]
        updatedLoserRow[0] = String(loserRow[0])
        // Swap Notes and Cooldown
        ;[updatedWinnerRow[6], updatedLoserRow[6]] = [loserRow[6], winnerRow[6]] // CHANGED: Notes is now column G (index 6)
        ;[updatedWinnerRow[7], updatedLoserRow[7]] = [loserRow[7], winnerRow[7]] // CHANGED: Cooldown is now column H (index 7)
      } else {
        updatedWinnerRow[0] = String(updatedWinnerRow[0])
        updatedLoserRow[0] = String(updatedLoserRow[0])
      }
      // Reset challenge status
      updatedWinnerRow[2] = 'Available' // CHANGED: Status is now column C (index 2)
      updatedWinnerRow[3] = '' // CHANGED: cDate is now column D (index 3)
      updatedWinnerRow[4] = '' // CHANGED: Opp# is now column E (index 4)
      updatedLoserRow[2] = 'Available' // CHANGED: Status is now column C (index 2)
      updatedLoserRow[3] = '' // CHANGED: cDate is now column D (index 3)
      updatedLoserRow[4] = '' // CHANGED: Opp# is now column E (index 4)
      const winnerRowIndex =
        rows.findIndex(row => parseInt(row[0]) === winnerRank) + 2
      const loserRowIndex =
        rows.findIndex(row => parseInt(row[0]) === loserRank) + 2
      // Create update requests
      console.log('├─ Preparing update requests...')
      const requests = [
        {
          updateCells: {
            range: {
              sheetId: sheetId,
              startRowIndex: winnerRowIndex - 1,
              endRowIndex: winnerRowIndex,
              startColumnIndex: 0,
              endColumnIndex: 8 // CHANGED: H column is index 7
            },
            rows: [
              {
                values: updatedWinnerRow.map((cellValue, index) => ({
                  userEnteredValue: { stringValue: cellValue },
                  userEnteredFormat:
                    index === 0 ? { horizontalAlignment: 'RIGHT' } : {}
                }))
              }
            ],
            fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment'
          }
        },
        {
          updateCells: {
            range: {
              sheetId: sheetId,
              startRowIndex: loserRowIndex - 1,
              endRowIndex: loserRowIndex,
              startColumnIndex: 0,
              endColumnIndex: 8 // CHANGED: H column is index 7
            },
            rows: [
              {
                values: updatedLoserRow.map((cellValue, index) => ({
                  userEnteredValue: { stringValue: cellValue },
                  userEnteredFormat:
                    index === 0 ? { horizontalAlignment: 'RIGHT' } : {}
                }))
              }
            ],
            fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment'
          }
        }
      ]
      // CHANGED: Removed element color updates
      // Execute updates
      console.log('├─ Executing sheet updates...')
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: requests }
      })
      // Create result announcement embed
      const victoryMessage = isDefense
        ? victoryMessages.defense[
            Math.floor(Math.random() * victoryMessages.defense.length)
          ]
        : victoryMessages.climb[
            Math.floor(Math.random() * victoryMessages.climb.length)
          ]
      // Add this new code block for title defends before the embed creation
      if (winnerRank === 1) {
        console.log('Processing title defense metrics...')
        try {
          // CHANGED: Fetch current metrics data - start from row 1
          const metricsResult = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Metrics!A1:C'
          })
          const metricsRows = metricsResult.data.values || []
          // Find if player already exists
          const playerRowIndex = metricsRows.findIndex(
            row => row[1] === winnerRow[5] // CHANGED: Discord ID is now column F (index 5)
          )
          if (playerRowIndex === -1) {
            // New player - append to the list
            await sheets.spreadsheets.values.append({
              spreadsheetId: SPREADSHEET_ID,
              range: 'Metrics!A1:C', // CHANGED: Start from row 1
              valueInputOption: 'USER_ENTERED',
              resource: {
                values: [
                  [
                    winnerRow[1], // CHANGED: Discord Username is now column B (index 1)
                    winnerRow[5], // CHANGED: Discord ID is now column F (index 5)
                    '1'
                  ]
                ]
              }
            })
            console.log('New title defender added to metrics')
          } else {
            // Existing player - update their count
            const currentDefenses =
              parseInt(metricsRows[playerRowIndex][2] || '0') + 1
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `Metrics!A${1 + playerRowIndex}:C${1 + playerRowIndex}`, // CHANGED: Start from row 1
              valueInputOption: 'USER_ENTERED',
              resource: {
                values: [
                  [
                    winnerRow[1], // CHANGED: Discord Username is now column B (index 1)
                    winnerRow[5], // CHANGED: Discord ID is now column F (index 5)
                    currentDefenses.toString()
                  ]
                ]
              }
            })
            console.log('Existing title defender metrics updated')
          }
        } catch (error) {
          console.error('Error updating title defense metrics:', error)
        }
      }
      
      // Set the cooldown for both players
      const player1 = {
        discordId: winnerRow[5], // CHANGED: Discord ID is now column F (index 5)
        name: winnerRow[1] // CHANGED: Discord username is now column B (index 1)
      }
      const player2 = {
        discordId: loserRow[5], // CHANGED: Discord ID is now column F (index 5)
        name: loserRow[1] // CHANGED: Discord username is now column B (index 1)
      }
      // Set cooldown in Redis and remove challenge
      try {
        // Set cooldown between players
        await redisClient.setCooldown(player1, player2);
        console.log('Cooldown set successfully for match:', {
          winner: player1.discordId,
          loser: player2.discordId
        });
        
        // Remove the challenge from Redis
        await redisClient.removeChallenge(winnerRank, loserRank);
        console.log('Challenge removed from Redis successfully');
      } catch (cooldownError) {
        console.error('Error setting cooldown or removing challenge:', cooldownError);
        // Don't throw error here - continue with match reporting even if cooldown fails
      }
      
      // CHANGED: Updated embed with NvD theme and no spec/element
      const resultEmbed = new EmbedBuilder()
        .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
        .setTitle(':bone: ⚔️ Challenge Result Announced! ⚔️ :bear:')
        .setDescription(`**${winnerDetails.discordName}** ${victoryMessage}`)
        .addFields(
          {
            name: `${
              isDefense ? ':bone: 🛡️ Defender' : ':bone: 🏆 Victor'
            } (Rank #${winnerRank})`,
            value: `**${winnerDetails.discordName}**
<@${winnerDiscordId}>`,
            inline: true
          },
          {
            name: '⚔️',
            value: 'VS',
            inline: true
          },
          {
            name: `${
              isDefense ? ':bear: ⚔️ Challenger' : ':bear: 📉 Defeated'
            } (Rank #${loserRank})`,
            value: `**${loserDetails.discordName}**
<@${loserDiscordId}>`,
            inline: true
          }
        )
        .setFooter({
          text: `${
            isDefense
              ? 'Rank Successfully Defended!'
              : 'Ranks have been updated!'
          }`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp()
      // Send result to channel
      await interaction.channel.send({ embeds: [resultEmbed] })
      // Confirm to command user
      await interaction.editReply({
        content: `Successfully reported the match result! ${
          isDefense
            ? 'Defender maintained their position.'
            : 'Ranks have been swapped.'
        }`
      })
      console.log('└─ Command completed successfully')
    } catch (error) {
      console.error(`└─ Error: ${error.message}`)
      logError(
        `Error in nvd-reportwin command: ${error.message}\nStack: ${error.stack}` // CHANGED: Updated command name in error message
      )
      await interaction.editReply({
        content:
          'An error occurred while reporting the match result. Please try again later.'
      })
    }
  }
}