const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { google } = require('googleapis');
const moment = require('moment-timezone');  // Use moment-timezone for better timezone handling
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
const sheetId = 0; // CHANGED: Numeric sheetId for 'NvD Ladder' tab
const DEFAULT_TIMEZONE = 'America/New_York'; // The timezone used for challenge dates
const MAX_CHALLENGE_DAYS = 3; // Maximum number of days a challenge can be active
module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-nullchallenges') // CHANGED: Added nvd- prefix
        .setDescription('Nullify challenges older than 3 days on the NvD ladder'), // CHANGED: Updated description
    
    async execute(interaction) {
        const timestamp = new Date().toISOString();
        console.log(`\n[${timestamp}] NullChallenges Command Execution Started`);
        console.log(`├─ Invoked by: ${interaction.user.tag} (${interaction.user.id})`);
        
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            // CHANGED: Check if the user has the '@NvD Admin' role
            const managerRole = interaction.guild.roles.cache.find(role => role.name === 'NvD Admin');
            if (!managerRole || !interaction.member.roles.cache.has(managerRole.id)) {
                console.log('└─ Error: User lacks NvD Admin role');
                return await interaction.editReply({
                    content: 'You do not have the required @NvD Admin role to use this command.',
                });
            }
            
            console.log('├─ Fetching data from Google Sheets...');
            // Fetch data from the Google Sheet
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `NvD Ladder!A2:H`, // CHANGED: Updated sheet name and range
            });
            const rows = result.data.values;
            if (!rows?.length) {
                console.log('└─ Error: No data found in the leaderboard');
                return await interaction.editReply({ 
                    content: 'No data available on the leaderboard.' 
                });
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
                const discUser = row[1]; // CHANGED: Discord username is now column B (index 1)
                const status = row[2]; // CHANGED: Status is now column C (index 2)
                const challengeDateStr = row[3]; // CHANGED: cDate is now column D (index 3)
                const opponent = row[4]; // CHANGED: Opp# is now column E (index 4)
                
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
                                startColumnIndex: 2, // CHANGED: Column C (Status) is index 2
                                endColumnIndex: 5 // CHANGED: Through Column E (Opp#) is index 4
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
                                    startColumnIndex: 2, // CHANGED: Column C (Status) is index 2
                                    endColumnIndex: 5 // CHANGED: Through Column E (Opp#) is index 4
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
                    // Store challenge details for the embed message
                    const opponentName = rows.find(r => r[0] === challenge.opponent)?.[1] || 'Unknown'; // CHANGED: Discord username is index 1
                    
                    // NEW: Also get Discord IDs for player lock cleanup
                    const playerDiscordId = rows.find(r => r[0] === challenge.playerRank)?.[5]; // Discord ID column F
                    const opponentDiscordId = rows.find(r => r[0] === challenge.opponent)?.[5]; // Discord ID column F
                    
                    nullifiedChallenges.push({
                        player: challenge.playerName,
                        playerRank: challenge.playerRank,
                        playerDiscordId: playerDiscordId,
                        opponent: opponentName,
                        opponentRank: challenge.opponent,
                        opponentDiscordId: opponentDiscordId,
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

                // Simple Redis cleanup aligned with SvS approach
                console.log('├─ Performing Redis cleanup...');
                const redisClient = require('../redis-client');
                let successfulCleanups = 0;
                let failedCleanups = [];
                
                for (const challenge of nullifiedChallenges) {
                    try {
                        await redisClient.removeChallenge(challenge.playerDiscordId, challenge.opponentDiscordId);
                        successfulCleanups++;
                        console.log(`│  ├─ ✅ Redis cleanup successful for ${challenge.player} vs ${challenge.opponent}`);
                    } catch (cleanupError) {
                        failedCleanups.push({
                            challenge: `${challenge.playerRank} vs ${challenge.opponentRank}`,
                            error: cleanupError.message
                        });
                        console.error(`│  ├─ ❌ Redis cleanup failed for ${challenge.playerRank} vs ${challenge.opponentRank}:`, cleanupError);
                    }
                }
                
                console.log(`├─ Redis cleanup completed: ${successfulCleanups}/${nullifiedChallenges.length} successful`);
                if (failedCleanups.length > 0) {
                    console.warn(`├─ ${failedCleanups.length} Redis cleanups failed:`, failedCleanups);
                }
                // Create embed message
                const embed = new EmbedBuilder()
                    .setTitle('🛡️ Nullified Old Challenges 🛡️')
                    .setDescription(`✨ Success! Nullified ${nullifiedChallenges.length} challenge pairs older than ${MAX_CHALLENGE_DAYS} days! ✨`)
                    .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
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
                    text: 'Challenges nullified successfully! Players can now issue new challenges.',
                    iconURL: interaction.client.user.displayAvatarURL()
                });
                // Send the public embed message
                console.log('├─ Sending embed message to channel...');
                await interaction.channel.send({ embeds: [embed] });
                // Update the deferred reply
                await interaction.editReply({ 
                    content: `Successfully nullified ${nullifiedChallenges.length} challenge pairs.` 
                });
                
                console.log(`└─ Command executed successfully: ${nullifiedChallenges.length} challenge pairs nullified`);
            } else {
                console.log('└─ No challenges to nullify found');
                await interaction.editReply({ 
                    content: `No challenges older than ${MAX_CHALLENGE_DAYS} days found.` 
                });
            }
        } catch (error) {
            console.error(`└─ Error executing nvd-nullchallenges command`); // CHANGED: Updated command name
            logError('NvD nullchallenges command error', error); // CHANGED: Updated error logging prefix
            
            await interaction.editReply({
                content: 'An error occurred while processing the command. Please try again later.'
            });
        }
    },
};