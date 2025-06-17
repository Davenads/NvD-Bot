const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js')
const { google } = require('googleapis')
const { logError } = require('../logger')
const redisClient = require('../redis-client')
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
const MAIN_SHEET = 'NvD Ladder' // CHANGED: Updated sheet name
const VACATION_SHEET = 'Extended Vacation'
const sheetId = 0 // CHANGED: NvD Ladder tab
const farewellMessages = [
  'May your adventures continue beyond the ladder! 🌟',
  'Your legacy in the ladder will be remembered! ⚔️',
  'Until we meet again, brave warrior! 👋',
  'The ladder will miss your presence! 🎭',
  'Your chapter in our story may end, but your legend lives on! 📖',
  'Farewell, noble challenger! 🏰',
  'May your future battles be glorious! ⚔️',
  'Your name shall echo in the halls of the ladder! 🏛️'
]
module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-remove') // CHANGED: Added nvd- prefix
    .setDescription('Remove a player from the NvD ladder') // CHANGED: Updated description
    .addIntegerOption(option =>
      option
        .setName('rank')
        .setDescription('The rank number of the player to remove')
        .setRequired(true)
    ),
  async execute (interaction) {
    console.log(`\n[${new Date().toISOString()}] Remove Command`)
    console.log(`├─ Invoked by: ${interaction.user.tag}`)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    // CHANGED: Check if the user has the '@NvD Admin' role
    const managerRole = interaction.guild.roles.cache.find(
      role => role.name === 'NvD Admin'
    )
    if (!managerRole || !interaction.member.roles.cache.has(managerRole.id)) {
      return interaction.editReply({
        content:
          'You do not have the required @NvD Admin role to use this command.',
        flags: MessageFlags.Ephemeral
      })
    }
    try {
      const rankToRemove = interaction.options.getInteger('rank')
      // First, fetch data from both sheets
      const [mainResult, vacationResult] = await Promise.all([
        sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${MAIN_SHEET}!A2:H` // CHANGED: Updated column range
        }),
        sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${VACATION_SHEET}!A2:H` // CHANGED: Updated column range
        })
      ])
      const rows = mainResult.data.values
      if (!rows || !rows.length) {
        console.log('└─ Error: No data found in leaderboard')
        return interaction.editReply({
          content: 'No data available on the leaderboard.',
          flags: MessageFlags.Ephemeral
        })
      }
      // Find the row to remove
      const rowIndex = rows.findIndex(
        row => row[0] && parseInt(row[0]) === rankToRemove
      )
      if (rowIndex === -1) {
        console.log(`└─ Error: Rank ${rankToRemove} not found`)
        return interaction.editReply({
          content: 'Rank not found in the ladder.',
          flags: MessageFlags.Ephemeral
        })
      }
      // Store player details
      const playerData = rows[rowIndex]
      const discordUsername = playerData[1] // CHANGED: Discord username is now column B (index 1)
      const discordId = playerData[5] // CHANGED: Discord ID is now column F (index 5)
      console.log('├─ Removing Player:')
      console.log(`│  ├─ Rank: #${rankToRemove}`)
      console.log(`│  └─ Discord: ${discordUsername}`)
      // Find first empty row in Extended Vacation tab
      const vacationRows = vacationResult.data.values || []
      let emptyRowIndex = vacationRows.length + 2
      for (let i = 0; i < vacationRows.length; i++) {
        if (!vacationRows[i] || !vacationRows[i][1]) {
          emptyRowIndex = i + 2
          break
        }
      }
      console.log(`├─ Moving to Extended Vacation row ${emptyRowIndex}`)
      // Create batch update requests
      const requests = []
      // 1. Add row to Extended Vacation tab
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${VACATION_SHEET}!A${emptyRowIndex}:H${emptyRowIndex}`, // CHANGED: Updated column range
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [playerData]
        }
      })
      // 2. Handle active challenges affected by removal
      // First, check for any challenge pairs that span across the removed rank
      for (let i = 0; i < rows.length; i++) {
        const currentRow = rows[i]
        if (!currentRow[0] || !currentRow[4]) continue // CHANGED: Opp# is now column E (index 4)
        const currentRank = parseInt(currentRow[0])
        const oppRank = parseInt(currentRow[4]) // CHANGED: Opp# is now column E (index 4)
        // Check if this challenge pair spans across the removed rank
        if (
          currentRow[2] === 'Challenge' && // CHANGED: Status is now column C (index 2)
          ((currentRank < rankToRemove && oppRank > rankToRemove) ||
            (currentRank > rankToRemove && oppRank < rankToRemove))
        ) {
          console.log(
            `├─ Found spanning challenge pair: Rank ${currentRank} vs Rank ${oppRank}`
          )
          // For the player above the removed rank, update their Opp# to reflect their opponent's new rank
          if (currentRank < rankToRemove) {
            requests.push({
              updateCells: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: i + 1,
                  endRowIndex: i + 2,
                  startColumnIndex: 4, // CHANGED: Opp# is now column E (index 4)
                  endColumnIndex: 5
                },
                rows: [
                  {
                    values: [
                      {
                        userEnteredValue: {
                          stringValue: (oppRank - 1).toString()
                        },
                        userEnteredFormat: { horizontalAlignment: 'RIGHT' }
                      }
                    ]
                  }
                ],
                fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment'
              }
            })
          }
        }
      }
      // 3. Handle direct challenges with the removed player
      if (playerData[2] === 'Challenge' && playerData[4]) { // CHANGED: Status is column C (index 2), Opp# is column E (index 4)
        const opponentRank = parseInt(playerData[4]) // CHANGED: Opp# is column E (index 4)
        const opponentIndex = rows.findIndex(
          row => row[0] && parseInt(row[0]) === opponentRank
        )
        if (opponentIndex !== -1) {
          console.log(`├─ Clearing challenge with rank #${opponentRank}`)
          requests.push({
            updateCells: {
              range: {
                sheetId: sheetId,
                startRowIndex: opponentIndex + 1,
                endRowIndex: opponentIndex + 2,
                startColumnIndex: 2, // CHANGED: Status is column C (index 2)
                endColumnIndex: 5 // CHANGED: Through column E (Opp#) is index 4
              },
              rows: [
                {
                  values: [
                    { userEnteredValue: { stringValue: 'Available' } },
                    { userEnteredValue: { stringValue: '' } },
                    {
                      userEnteredValue: { stringValue: '' },
                      userEnteredFormat: { horizontalAlignment: 'RIGHT' }
                    }
                  ]
                }
              ],
              fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment'
            }
          })
        }
      }
      // 4. Delete the row from main ladder
      requests.push({
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex + 1,
            endIndex: rowIndex + 2
          }
        }
      })
      // 5. Update remaining ranks and opponent references
      let ranksUpdated = 0
      for (let i = rowIndex + 1; i < rows.length; i++) {
        const currentRow = rows[i]
        if (!currentRow[0]) continue
        const currentRank = parseInt(currentRow[0])
        const newRank = currentRank - 1
        ranksUpdated++
        // Update rank number
        requests.push({
          updateCells: {
            range: {
              sheetId: sheetId,
              startRowIndex: i,
              endRowIndex: i + 1,
              startColumnIndex: 0,
              endColumnIndex: 1
            },
            rows: [
              {
                values: [
                  {
                    userEnteredValue: { stringValue: newRank.toString() },
                    userEnteredFormat: { horizontalAlignment: 'RIGHT' }
                  }
                ]
              }
            ],
            fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment'
          }
        })
        // Update opponent references if needed
        if (currentRow[2] === 'Challenge' && currentRow[4]) { // CHANGED: Status is column C (index 2), Opp# is column E (index 4)
          const oppRank = parseInt(currentRow[4]) // CHANGED: Opp# is column E (index 4)
          if (oppRank > rankToRemove) {
            console.log(
              `├─ Updating opponent reference: Rank #${currentRank} -> #${newRank}`
            )
            requests.push({
              updateCells: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: i,
                  endRowIndex: i + 1,
                  startColumnIndex: 4, // CHANGED: Opp# is column E (index 4)
                  endColumnIndex: 5
                },
                rows: [
                  {
                    values: [
                      {
                        userEnteredValue: {
                          stringValue: (oppRank - 1).toString()
                        },
                        userEnteredFormat: { horizontalAlignment: 'RIGHT' }
                      }
                    ]
                  }
                ],
                fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment'
              }
            })
          } else if (oppRank === rankToRemove) {
            console.log(
              `├─ Resetting challenge status for rank #${currentRank}`
            )
            requests.push({
              updateCells: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: i,
                  endRowIndex: i + 1,
                  startColumnIndex: 2, // CHANGED: Status is column C (index 2)
                  endColumnIndex: 5 // CHANGED: Through column E (Opp#) is index 4
                },
                rows: [
                  {
                    values: [
                      { userEnteredValue: { stringValue: 'Available' } },
                      { userEnteredValue: { stringValue: '' } },
                      {
                        userEnteredValue: { stringValue: '' },
                        userEnteredFormat: { horizontalAlignment: 'RIGHT' }
                      }
                    ]
                  }
                ],
                fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment'
              }
            })
          }
        }
      }
      console.log(`├─ Updated ${ranksUpdated} ranks`)
      // Execute all updates
      if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          resource: { requests }
        })
      }

      // Redis cleanup and updates
      console.log('├─ Starting Redis cleanup and updates...')
      
      // 1. Clean up Redis data for the removed player
      if (playerData[2] === 'Challenge' && playerData[4]) { // CHANGED: Status is column C (index 2), Opp# is column E (index 4)
        const opponentRank = parseInt(playerData[4]) // CHANGED: Opp# is column E (index 4)
        console.log(`├─ Removing Redis challenge keys for ranks ${rankToRemove} and ${opponentRank}`)
        
        // Remove the challenge keys involving the removed player
        await redisClient.removeChallenge(rankToRemove, opponentRank)
        
        // Remove player locks for both players
        if (discordId) {
          await redisClient.removePlayerLock(discordId)
          console.log(`├─ Removed player lock for removed player: ${discordId}`)
        }
        
        // Find and remove opponent's player lock
        const opponentData = rows.find(row => parseInt(row[0]) === opponentRank)
        if (opponentData && opponentData[5]) { // CHANGED: Discord ID is column F (index 5)
          await redisClient.removePlayerLock(opponentData[5])
          console.log(`├─ Removed player lock for opponent: ${opponentData[5]}`)
        }
      }
      
      // 2. Update all Redis challenge keys affected by rank shifts
      console.log('├─ Updating Redis challenge keys for rank shifts...')
      
      // Get all active challenges from Redis
      const activeChallenges = await redisClient.listAllChallenges()
      
      // Process each challenge to see if ranks need updating
      for (const challenge of activeChallenges) {
        const challengerRank = parseInt(challenge.challenger.rank)
        const targetRank = parseInt(challenge.target.rank)
        
        let needsUpdate = false
        let newChallengerRank = challengerRank
        let newTargetRank = targetRank
        
        // Check if challenger rank needs updating (if they were below the removed player)
        if (challengerRank > rankToRemove) {
          newChallengerRank = challengerRank - 1
          needsUpdate = true
        }
        
        // Check if target rank needs updating (if they were below the removed player)  
        if (targetRank > rankToRemove) {
          newTargetRank = targetRank - 1
          needsUpdate = true
        }
        
        // If ranks changed, update the Redis keys
        if (needsUpdate) {
          console.log(`├─ Updating challenge: ${challengerRank}:${targetRank} → ${newChallengerRank}:${newTargetRank}`)
          
          // Get the current challenge data
          const oldChallengeKey = `nvd:challenge:${challengerRank}:${targetRank}`
          const challengeData = await redisClient.client.get(oldChallengeKey)
          
          if (challengeData) {
            // Parse and update the challenge data with new ranks
            const challenge = JSON.parse(challengeData)
            challenge.challenger.rank = newChallengerRank
            challenge.target.rank = newTargetRank
            
            // Calculate remaining TTL from the old key
            const remainingTTL = await redisClient.client.ttl(oldChallengeKey)
            
            // Remove old keys
            await redisClient.removeChallenge(challengerRank, targetRank)
            
            // Create new keys with updated ranks if TTL is still valid
            if (remainingTTL > 0) {
              await redisClient.setChallengeWithTTL(
                challenge.challenger,
                challenge.target,
                null, // Discord client not needed for this operation
                remainingTTL
              )
              
              // Update player locks with new challenge key
              const newChallengeKey = `nvd:challenge:${newChallengerRank}:${newTargetRank}`
              if (challenge.challenger.discordId) {
                await redisClient.setPlayerLockWithTTL(challenge.challenger.discordId, newChallengeKey, remainingTTL)
              }
              if (challenge.target.discordId) {
                await redisClient.setPlayerLockWithTTL(challenge.target.discordId, newChallengeKey, remainingTTL)
              }
              
              console.log(`├─ Successfully updated Redis challenge keys`)
            }
          }
        }
      }
      
      // 3. Clean up any orphaned player locks
      const cleanedLocks = await redisClient.cleanupOrphanedPlayerLocks()
      if (cleanedLocks > 0) {
        console.log(`├─ Cleaned ${cleanedLocks} orphaned player locks`)
      }
      
      console.log('└─ Redis cleanup and updates completed')
      // Verify ranks
      const verificationResult = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${MAIN_SHEET}!A2:A`
      })
      const updatedRanks = verificationResult.data.values
      let ranksAreCorrect = true
      let firstIncorrectRank = null
      if (updatedRanks) {
        for (let i = 0; i < updatedRanks.length; i++) {
          if (updatedRanks[i][0] && parseInt(updatedRanks[i][0]) !== i + 1) {
            ranksAreCorrect = false
            firstIncorrectRank = i + 1
            break
          }
        }
      }
      console.log(
        `└─ Rank verification: ${ranksAreCorrect ? 'Success' : 'Failed'}`
      )
      // CHANGED: Simplified farewell embed with no spec/element
      const farewellEmbed = new EmbedBuilder()
        .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
        .setTitle('👋 Farewell from the NvD Ladder!') // CHANGED: Updated title
        .setDescription(
          farewellMessages[Math.floor(Math.random() * farewellMessages.length)]
        )
        .addFields(
          {
            name: '👤 Discord User',
            value: discordId ? `<@${discordId}>` : discordUsername,
            inline: true
          },
          {
            name: '🏆 Rank',
            value: `#${rankToRemove}`,
            inline: true
          }
        )
        .setFooter({
          text: `Player moved to Extended Vacation. ${
            ranksAreCorrect
              ? 'All ladder ranks updated successfully!'
              : 'Rank verification needed.'
          }`,
          iconURL: interaction.client.user.displayAvatarURL()
        })
        .setTimestamp()
      // Send the embed to the channel
      await interaction.channel.send({ embeds: [farewellEmbed] })
      // Send confirmation to command issuer
      await interaction.editReply({
        content: `Successfully moved ${discordUsername} to Extended Vacation and updated all affected rankings, challenges, and Redis data.`,
        flags: MessageFlags.Ephemeral
      })
    } catch (error) {
      console.error(`└─ Error: ${error.message}`)
      logError('Error removing player', error)
      return interaction.editReply({
        content:
          'An error occurred while removing the player. Please try again later.',
        flags: MessageFlags.Ephemeral
      })
    }
  }
}