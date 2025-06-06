require('dotenv').config()
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js')
const { google } = require('googleapis')
const { logError } = require('../logger')
const redisClient = require('../redis-client');

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
const SHEET_NAME = 'NvD Ladder' // CHANGED: Updated sheet name
const TOP_10_MAX_JUMP = 2
const REGULAR_MAX_JUMP = 3
const TOP_10_THRESHOLD = 10

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-challenge') // CHANGED: Added nvd- prefix
    .setDescription('Challenge a player on the NvD leaderboard') // CHANGED: Updated description
    .addIntegerOption(option =>
      option
        .setName('challenger_rank')
        .setDescription('Your rank on the leaderboard')
        .setRequired(true)
        .setMinValue(1)
    )
    .addIntegerOption(option =>
      option
        .setName('target_rank')
        .setDescription('The rank of the player you want to challenge')
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute (interaction) {
    if (interaction.channelId !== '1144011555378298910') { // CHANGED: Updated channel ID
      return await interaction.reply({
        content: 'This command can only be used in the #nvd-challenges channel.', // CHANGED: Updated channel name
        flags: MessageFlags.Ephemeral
      })
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const timestamp = new Date().toISOString()
    console.log(`\n[${timestamp}] Challenge Command Execution Started`)
    console.log(
      `├─ Invoked by: ${interaction.user.tag} (${interaction.user.id})`
    )
    try {
      const challengerRank = interaction.options.getInteger('challenger_rank')
      const targetRank = interaction.options.getInteger('target_rank')
      const userId = interaction.user.id
      const memberRoles = interaction.member.roles.cache

      console.log(`├─ Challenge Request:`)
      console.log(`│  ├─ Challenger Rank: #${challengerRank}`)
      console.log(`│  └─ Target Rank: #${targetRank}`)

      // Prevent challenging downward in the ladder
      if (challengerRank <= targetRank) {
        console.log('└─ Rejected: Attempted to challenge downward')
        return await interaction.editReply({
          content: `You cannot challenge players ranked below you.`
        })
      }

      // Fetch ladder data
      console.log('├─ Fetching ladder data...')
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A2:F` // CHANGED: Updated column range (A to F)
      })

      const rows = result.data.values
      if (!rows?.length) {
        console.log('└─ Error: No data available on the leaderboard')
        logError('No data available on the leaderboard.')
        return await interaction.editReply({
          content: 'Unable to access leaderboard data. Please try again later.'
        })
      }

      // Get available players between target and challenger
      const playersBetween = rows.filter(row => {
        const rank = parseInt(row[0])
        return rank > targetRank && rank < challengerRank
      })

      // Filter out vacation players
      const availablePlayersBetween = playersBetween.filter(
        row => row[2] !== 'Vacation' // CHANGED: Status is now column C (index 2)
      )
      const availableJumpSize = availablePlayersBetween.length + 1

      console.log(`├─ Challenge Analysis:`)
      console.log(`│  ├─ Players between: ${playersBetween.length}`)
      console.log(
        `│  ├─ Available players between: ${availablePlayersBetween.length}`
      )
      console.log(`│  └─ Effective jump size: ${availableJumpSize}`)

      // Special restriction for challenging top 10 players
      if (targetRank <= TOP_10_THRESHOLD && challengerRank > TOP_10_THRESHOLD) {
        if (availableJumpSize > TOP_10_MAX_JUMP) {
          console.log(
            '└─ Rejected: Non-top 10 player attempting to challenge top 10 beyond limit'
          )
          const maxAllowedRank = challengerRank - TOP_10_MAX_JUMP
          return await interaction.editReply({
            content: `Players outside top 10 can only challenge up to ${TOP_10_MAX_JUMP} ranks ahead when targeting top 10 players. The highest rank you can challenge is ${maxAllowedRank}.`
          })
        }
      } else if (challengerRank <= TOP_10_THRESHOLD) {
        // Top 10 restriction
        if (availableJumpSize > TOP_10_MAX_JUMP) {
          console.log('└─ Rejected: Top 10 player exceeding max jump')
          const maxTarget = rows.find(
            row =>
              parseInt(row[0]) === challengerRank - TOP_10_MAX_JUMP &&
              row[2] !== 'Vacation' // CHANGED: Status is now column C (index 2)
          )
          return await interaction.editReply({
            content: `Top 10 players can only challenge up to ${TOP_10_MAX_JUMP} ranks ahead. The highest rank you can challenge is ${
              maxTarget ? maxTarget[0] : challengerRank - TOP_10_MAX_JUMP
            }.`
          })
        }
      } else {
        // Regular player restriction
        if (availableJumpSize > REGULAR_MAX_JUMP) {
          console.log('└─ Rejected: Regular player exceeding max jump')
          const maxTarget = rows.find(
            row =>
              parseInt(row[0]) === challengerRank - REGULAR_MAX_JUMP &&
              row[2] !== 'Vacation' // CHANGED: Status is now column C (index 2)
          )
          const skippedRanks = availablePlayersBetween
            .map(row => row[0])
            .join(', ')
          return await interaction.editReply({
            content: `Players outside top 10 can only challenge up to ${REGULAR_MAX_JUMP} ranks ahead (excluding players on vacation). You're trying to skip ranks: ${skippedRanks}`
          })
        }
      }

      // Validate challenger and target
      console.log('├─ Validating challenger and target...')
      const challengerRow = rows.find(
        row => parseInt(row[0]) === challengerRank
      )
      const targetRow = rows.find(row => parseInt(row[0]) === targetRank)

      if (!challengerRow || !targetRow) {
        console.log('└─ Rejected: Invalid ranks provided')
        return await interaction.editReply({
          content: 'One or both ranks were not found on the leaderboard.'
        })
      }

      // Verify challenger identity
      if (
        challengerRow[5] !== userId && // CHANGED: Discord ID is now column F (index 5)
        !memberRoles.some(role => role.name === 'NvD Admin') // CHANGED: Updated role name
      ) {
        console.log('└─ Rejected: Unauthorized challenger')
        return await interaction.editReply({
          content: 'You can only initiate challenges for your own rank.'
        })
      }

      // NEW: Check for cooldown between players
      const player1 = {
        discordId: challengerRow[5], // CHANGED: Discord ID is now column F (index 5)
        name: challengerRow[1] // CHANGED: Discord username is now column B (index 1)
      }

      const player2 = {
        discordId: targetRow[5], // CHANGED: Discord ID is now column F (index 5)
        name: targetRow[1] // CHANGED: Discord username is now column B (index 1)
      }

      const cooldownCheck = await redisClient.checkCooldown(player1, player2)

      if (cooldownCheck.onCooldown) {
        const remainingHours = Math.ceil(cooldownCheck.remainingTime / 3600)
        return await interaction.editReply({
          content: `You cannot challenge this player yet. Cooldown remains for ${remainingHours} hours.`
        })
      }

      // Check for existing challenge between these players
      console.log('├─ Checking for existing challenge in Redis...')
      const existingChallenge = await redisClient.checkChallenge(challengerRank, targetRank);
      
      if (existingChallenge.active) {
        const hoursRemaining = Math.floor(existingChallenge.remainingTime / 3600);
        console.log(`└─ Rejected: Challenge already exists (${hoursRemaining}h remaining)`);
        return await interaction.editReply({
          content: 'A challenge already exists between these players.'
        })
      }
      // Check availability
      if (challengerRow[2] !== 'Available' || targetRow[2] !== 'Available') { // CHANGED: Status is now column C (index 2)
        console.log('└─ Rejected: Player(s) not available')
        return await interaction.editReply({
          content: `Challenge failed: ${
            challengerRow[2] !== 'Available' ? 'You are' : 'Your target is'
          } not available for challenges.`
        })
      }

      // NEW: Check if challenger is already someone else's opponent
      const challengerAlreadyOpponent = rows.some(row => 
        row[4] === String(challengerRank) && // Challenger rank appears in opponent column
        parseInt(row[0]) !== targetRank && // But not with current target
        row[2] === 'Challenge' // And that row is in challenge status
      );

      if (challengerAlreadyOpponent) {
        console.log('└─ Rejected: Challenger is already being challenged by someone else')
        return await interaction.editReply({
          content: 'You cannot issue a challenge while you are already being challenged by someone else.'
        })
      }

      // NEW: Check if target is already someone else's opponent  
      const targetAlreadyOpponent = rows.some(row => 
        row[4] === String(targetRank) && // Target rank appears in opponent column
        parseInt(row[0]) !== challengerRank && // But not with current challenger
        row[2] === 'Challenge' // And that row is in challenge status
      );

      if (targetAlreadyOpponent) {
        console.log('└─ Rejected: Target is already being challenged by someone else')
        return await interaction.editReply({
          content: 'Target player is already being challenged by someone else.'
        })
      }

      // Format challenge date
      const challengeDate = new Date().toLocaleString('en-US', {
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: true,
        timeZone: 'America/New_York',
        timeZoneName: 'short'
      })

      console.log('├─ Updating challenge status...')

      // Update both players' status
      const challengerRowIndex =
        rows.findIndex(row => parseInt(row[0]) === challengerRank) + 2
      const targetRowIndex =
        rows.findIndex(row => parseInt(row[0]) === targetRank) + 2

      const updatePromises = [
        sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!C${challengerRowIndex}:E${challengerRowIndex}`, // CHANGED: Updated column range
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['Challenge', challengeDate, targetRank]] }
        }),
        sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!C${targetRowIndex}:E${targetRowIndex}`, // CHANGED: Updated column range
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['Challenge', challengeDate, challengerRank]] }
        })
      ]

      await Promise.all(updatePromises)
      console.log('├─ Challenge status updated successfully')

      // CHANGED: Create and send announcement embed with NvD theme (no spec/element)
      const challengeEmbed = new EmbedBuilder()
        .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
        .setTitle(':bone: ⚔️ :bear: New Challenge Initiated!')
        .addFields(
          {
            name: ':bone: Challenger',
            value: `Rank #${challengerRank} (<@${challengerRow[5]}>)`, // CHANGED: Discord ID is now column F (index 5)
            inline: true
          },
          {
            name: '​',
            value: 'VS',
            inline: true
          },
          {
            name: ':bear: Challenged',
            value: `Rank #${targetRank} (<@${targetRow[5]}>)`, // CHANGED: Discord ID is now column F (index 5)
            inline: true
          }
        )
        .setTimestamp()
        .setFooter({
          text: 'May the best player win!',
          iconURL: interaction.client.user.displayAvatarURL()
        })

      await interaction.channel.send({ embeds: [challengeEmbed] })
      
      // Send notification to target player (player who didn't initiate the challenge)
      if (targetRow[5] !== interaction.user.id) {
        try {
          // Send ephemeral message that will trigger a notification
          await interaction.followUp({
            content: `<@${targetRow[5]}> You have been challenged by Rank #${challengerRank}!`,
            ephemeral: false
          });
        } catch (error) {
          console.log(`├─ Could not send notification to target: ${error.message}`);
        }
      }
      
      // Add challenge to Redis for auto-nulling 
      console.log('├─ Storing challenge in Redis for auto-nulling...');
      const challenger = {
        discordId: challengerRow[5], // Discord ID
        discordName: challengerRow[1], // Discord username
        rank: challengerRank
      };
      
      const target = {
        discordId: targetRow[5], // Discord ID
        discordName: targetRow[1], // Discord username
        rank: targetRank
      };
      
      // Store challenge in Redis (simplified like SvS-Bot-2)
      console.log(`├─ Storing challenge in Redis: ${challenger.discordName} (${challengerRank}) vs ${target.discordName} (${targetRank})`);
      await redisClient.setChallenge(challenger, target, challengeDate);
      console.log('├─ Challenge stored in Redis successfully');
      
      await interaction.editReply({
        content: 'Challenge successfully initiated!'
      })
      console.log('└─ Challenge command completed successfully')
    } catch (error) {
      console.log(`└─ Error executing challenge command: ${error.message}`)
      logError(
        `Challenge command error: ${error.message}\nStack: ${error.stack}`
      )
      await interaction.editReply({
        content:
          'An error occurred while processing your challenge. Please try again later.'
      })
    }
  }
}