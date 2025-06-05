const cron = require('node-cron');
const { google } = require('googleapis');
const moment = require('moment-timezone');
const { logError } = require('./logger');

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
const sheetId = 0; // Numeric sheetId for 'NvD Ladder' tab
const DEFAULT_TIMEZONE = 'America/New_York';
const MAX_CHALLENGE_DAYS = 3; // Maximum number of days a challenge can be active

/**
 * Automatically nullify challenges that are older than MAX_CHALLENGE_DAYS
 */
async function autoNullChallenges(client) {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Scheduled Auto-Null Challenges Task Started (Sheet-based backup check)`);
  
  try {
    console.log('├─ Fetching data from Google Sheets...');
    // Fetch data from the Google Sheet
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `NvD Ladder!A2:H`,
    });
    
    const rows = result.data.values;
    if (!rows?.length) {
      console.log('└─ Error: No data found in the leaderboard');
      return;
    }
    
    console.log(`├─ Processing ${rows.length} rows from the leaderboard...`);
    // Current time in the specified timezone
    const now = moment().tz(DEFAULT_TIMEZONE);
    
    let requests = [];
    const processedChallenges = new Set();
    const nullifiedChallenges = [];
    const validChallengesFound = [];
    const challengesWithDateParsingIssues = [];
    
    // First pass: Identify all challenges that need to be nullified
    console.log('├─ Identifying challenges to nullify...');
    rows.forEach((row, index) => {
      if (!row[0] || !row[1]) return; // Skip rows without rank or name
      
      const playerRank = row[0]; // Player Rank
      const discUser = row[1]; // Discord username is in column B
      const status = row[2]; // Status is in column C
      const challengeDateStr = row[3]; // cDate is in column D
      const opponent = row[4]; // Opp# is in column E
      
      // Skip non-challenge rows or incomplete challenges
      if (status !== 'Challenge' || !challengeDateStr || !opponent) return;
      
      // Handle specific date format: M/D, h:mm AM/PM EST/EDT
      let challengeDate;
      const dateFormat = 'M/D, h:mm A';
      
      // Extract timezone from the date string
      const timezoneMatch = challengeDateStr.match(/\s+(EST|EDT)$/i);
      const detectedTZ = timezoneMatch ? timezoneMatch[1].toUpperCase() : null;
      const cleanDateStr = challengeDateStr.replace(/\s+(EST|EDT)$/i, '').trim();
      
      // Parse in the correct timezone context
      const parsed = moment.tz(cleanDateStr, dateFormat, DEFAULT_TIMEZONE);
      console.log(`├─ Parsing challenge date: "${challengeDateStr}" -> detected TZ: ${detectedTZ || 'none'} -> parsed: ${parsed.format()}`);
      if (parsed.isValid()) {
        // Handle year for dates (add current year, but handle year boundary cases)
        const currentYear = now.year();
        if (parsed.month() > now.month() || 
          (parsed.month() === now.month() && parsed.date() > now.date())) {
          parsed.year(currentYear - 1);
        } else {
          parsed.year(currentYear);
        }
        challengeDate = parsed;
        // Check if challenge is old enough to be nullified
        const hoursDiff = now.diff(challengeDate, 'hours');
        const daysDiff = hoursDiff / 24;
        
        if (daysDiff > MAX_CHALLENGE_DAYS) {
          // Create a consistent key regardless of order
          const challengeKey = [String(playerRank), String(opponent)].sort().join('-');
          
          if (!processedChallenges.has(challengeKey)) {
            processedChallenges.add(challengeKey);
            console.log(`│  ├─ Nullifying: Rank #${playerRank} (${discUser}) vs Rank #${opponent}`);
            console.log(`│  │  ├─ Challenge date: ${challengeDateStr}`);
            console.log(`│  │  └─ Age: ${daysDiff.toFixed(2)} days (${hoursDiff} hours)`);
            
            validChallengesFound.push({
              rowIndex: index,
              playerRank: playerRank,
              playerName: discUser,
              opponent: opponent,
              challengeDate: challengeDateStr,
              daysDiff: daysDiff
            });
          }
        }
      } else {
        console.log(`│  ├─ WARNING: Could not parse date "${challengeDateStr}" for player ${discUser} (Rank ${playerRank})`);
        challengesWithDateParsingIssues.push({
          playerName: discUser,
          playerRank,
          challengeDateStr
        });
      }
    });
    
    console.log(`├─ Found ${validChallengesFound.length} challenges that need nullification`);
    if (challengesWithDateParsingIssues.length > 0) {
      console.log(`├─ ${challengesWithDateParsingIssues.length} challenges had date parsing issues`);
    }
    
    // Second pass: Create update requests for each challenge to nullify
    if (validChallengesFound.length > 0) {
      console.log('├─ Creating update requests...');
      for (const challenge of validChallengesFound) {
        // Update the challenger's row
        requests.push({
          updateCells: {
            range: {
              sheetId: sheetId,
              startRowIndex: challenge.rowIndex + 1,
              endRowIndex: challenge.rowIndex + 2,
              startColumnIndex: 2, // Column C (Status) is index 2
              endColumnIndex: 5 // Through Column E (Opp#) is index 4
            },
            rows: [{
              values: [
                { userEnteredValue: { stringValue: 'Available' } },
                { userEnteredValue: { stringValue: '' } },
                { userEnteredValue: { stringValue: '' } }
              ]
            }],
            fields: 'userEnteredValue'
          }
        });
        
        // Find and update the opponent's row
        const opponentRowIndex = rows.findIndex(row => row[0] === challenge.opponent);
        if (opponentRowIndex !== -1) {
          requests.push({
            updateCells: {
              range: {
                sheetId: sheetId,
                startRowIndex: opponentRowIndex + 1,
                endRowIndex: opponentRowIndex + 2,
                startColumnIndex: 2, // Column C (Status) is index 2
                endColumnIndex: 5 // Through Column E (Opp#) is index 4
              },
              rows: [{
                values: [
                  { userEnteredValue: { stringValue: 'Available' } },
                  { userEnteredValue: { stringValue: '' } },
                  { userEnteredValue: { stringValue: '' } }
                ]
              }],
              fields: 'userEnteredValue'
            }
          });
        } else {
          console.log(`│  ├─ WARNING: Could not find opponent row with rank ${challenge.opponent}`);
        }
        
        // Store challenge details for notification
        const opponentName = rows.find(r => r[0] === challenge.opponent)?.[1] || 'Unknown';
        nullifiedChallenges.push({
          player: challenge.playerName,
          playerRank: challenge.playerRank,
          opponent: opponentName,
          opponentRank: challenge.opponent,
          date: challenge.challengeDateStr,
          daysPast: Math.floor(challenge.daysDiff)
        });
      }
      
      // Execute all updates
      console.log(`├─ Executing batch update for ${requests.length} requests...`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests }
      });
      console.log(`├─ Batch update completed successfully`);
      
      // NEW: Use atomic cleanup for Redis operations with distributed locking
      console.log('├─ Performing atomic Redis cleanup...');
      const redisClient = require('./redis-client');
      let successfulCleanups = 0;
      let failedCleanups = [];
      
      for (const challenge of validChallengesFound) {
        try {
          // Get Discord IDs for atomic cleanup
          const playerDiscordId = rows.find(r => r[0] === challenge.playerRank)?.[5]; // Discord ID column F
          const opponentDiscordId = rows.find(r => r[0] === challenge.opponent)?.[5]; // Discord ID column F
          
          const cleanupResult = await redisClient.atomicChallengeCleanup(
            challenge.playerRank,
            challenge.opponent, 
            playerDiscordId,
            opponentDiscordId
          );
          
          if (cleanupResult.success) {
            successfulCleanups++;
            console.log(`│  ├─ ✅ Redis cleanup successful for ${challenge.playerRank} vs ${challenge.opponent}`);
          } else if (cleanupResult.alreadyProcessing) {
            console.log(`│  ├─ ⏭️ Challenge ${challenge.playerRank} vs ${challenge.opponent} already being processed`);
            successfulCleanups++; // Count as successful since it's being handled
          } else {
            failedCleanups.push({
              challenge: `${challenge.playerRank} vs ${challenge.opponent}`,
              errors: cleanupResult.errors
            });
            console.warn(`│  ├─ ⚠️ Redis cleanup had issues for ${challenge.playerRank} vs ${challenge.opponent}:`, cleanupResult.errors);
          }
        } catch (cleanupError) {
          failedCleanups.push({
            challenge: `${challenge.playerRank} vs ${challenge.opponent}`,
            errors: [cleanupError.message]
          });
          console.error(`│  ├─ ❌ Redis cleanup failed for ${challenge.playerRank} vs ${challenge.opponent}:`, cleanupError);
        }
      }
      
      console.log(`├─ Redis cleanup completed: ${successfulCleanups}/${validChallengesFound.length} successful`);
      if (failedCleanups.length > 0) {
        console.warn(`├─ ${failedCleanups.length} Redis cleanups had issues:`, failedCleanups);
      }
      
      // Find a suitable announcements channel to post to
      if (client && nullifiedChallenges.length > 0) {
        // Try to find the NVD challenges channel (ID: 1144011555378298910)
        const announcementChannel = client.channels.cache.get('1144011555378298910');
        if (announcementChannel) {
          // Get the Discord.js module to create an embed 
          const { EmbedBuilder } = require('discord.js');
          
          const embed = new EmbedBuilder()
            .setTitle('🤖 Auto-Nullified Old Challenges 🤖')
            .setDescription(`✨ Auto-nullified ${nullifiedChallenges.length} challenge pairs older than ${MAX_CHALLENGE_DAYS} days! ✨`)
            .setColor('#8A2BE2')
            .setTimestamp();
            
          // Add nullified challenges details
          if (nullifiedChallenges.length > 0) {
            const challengesList = nullifiedChallenges
              .map(c => `Rank #${c.playerRank} ${c.player} vs Rank #${c.opponentRank} ${c.opponent} - ${c.daysPast} days old`)
              .join('\n');
            
            if (challengesList.length <= 1024) {
              embed.addFields({
                name: 'Nullified Challenges',
                value: challengesList
              });
            } else {
              // Split into multiple fields if too long
              const chunks = challengesList.match(/.{1,1024}/g) || [];
              chunks.forEach((chunk, index) => {
                embed.addFields({
                  name: index === 0 ? 'Nullified Challenges' : '⠀', // Empty character for subsequent fields
                  value: chunk
                });
              });
            }
          }
          
          // Add date parsing issues if any
          if (challengesWithDateParsingIssues.length > 0) {
            const issuesList = challengesWithDateParsingIssues
              .map(c => `Rank #${c.playerRank} ${c.playerName}: date "${c.challengeDateStr}" could not be parsed`)
              .join('\n');
            
            if (issuesList.length <= 1024) {
              embed.addFields({
                name: '⚠️ Date Parsing Issues (Manual Review Required)',
                value: issuesList
              });
            }
          }
          
          embed.setFooter({ 
            text: 'Auto-nullified by NvD Bot - Players can now issue new challenges',
            iconURL: client.user.displayAvatarURL()
          });
          
          // Send the public embed message
          console.log('├─ Sending embed message to channel...');
          await announcementChannel.send({ embeds: [embed] });
        } else {
          console.log('├─ Could not find announcement channel for auto-null notification');
        }
      }
      
      console.log(`└─ Auto-null task completed: ${nullifiedChallenges.length} challenge pairs nullified`);
    } else {
      console.log('└─ No challenges to nullify found');
    }
  } catch (error) {
    console.error(`└─ Error executing auto-null task: ${error.message}`);
    console.error(error.stack);
    logError(`Auto-null challenges task error: ${error.message}\nStack: ${error.stack}`);
  }
}

/**
 * Initialize all scheduled tasks
 * @param {Client} client - Discord.js client instance
 */
function initScheduledTasks(client) {
  console.log('Initializing scheduled tasks...');

  // DISABLED: Daily scheduled auto-null to prevent race conditions with Redis TTL system
  // The Redis TTL expiry system handles challenge auto-nullification automatically
  console.log('⚠️ Daily scheduled auto-null task is DISABLED to prevent race conditions');
  console.log('   Auto-nullification is handled by Redis TTL expiry system');

  // DISABLED: Initial startup check to prevent race conditions
  // The startup sync in index.js now handles existing challenges properly
  console.log('⚠️ Initial startup auto-null check is DISABLED');
  console.log('   Startup sync in index.js handles existing challenges');
  
  console.log('All scheduled tasks initialized (auto-null tasks disabled)');
}

module.exports = {
  initScheduledTasks
};