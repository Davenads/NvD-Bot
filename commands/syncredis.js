require('dotenv').config();
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { google } = require('googleapis');
const { logError } = require('../logger');
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

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'NvD Ladder';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-syncredis')
        .setDescription('Sync existing Google Sheets challenges to Redis (Admin only)')
        .addBooleanOption(option =>
            option.setName('force')
                .setDescription('Force sync even if challenges already exist in Redis')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('dry_run')
                .setDescription('Show what would be synced without making changes')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('cleanup_orphaned')
                .setDescription('Clean up stale Redis data (warning keys without challenges)')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('show_cooldowns')
                .setDescription('Display all current cooldowns for verification')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('clear_cooldowns')
                .setDescription('Clear all player cooldowns (use when reverting matches)')
                .setRequired(false)
        ),

    async execute(interaction) {
        const timestamp = new Date().toISOString();
        console.log(`\n[${timestamp}] SyncRedis Command Execution Started`);
        console.log(`├─ Invoked by: ${interaction.user.tag} (${interaction.user.id})`);

        // Check if the user has the 'NvD Admin' role
        const isAdmin = interaction.member.roles.cache.some(role => role.name === 'NvD Admin');
        if (!isAdmin) {
            console.log('└─ Error: User lacks NvD Admin role');
            return await interaction.reply({
                content: 'You do not have the required @NvD Admin role to use this command.',
                flags: MessageFlags.Ephemeral
            });
        }

        const force = interaction.options.getBoolean('force') || false;
        const dryRun = interaction.options.getBoolean('dry_run') || false;
        const cleanupOrphaned = interaction.options.getBoolean('cleanup_orphaned') || false;
        const showCooldowns = interaction.options.getBoolean('show_cooldowns') || false;
        const clearCooldowns = interaction.options.getBoolean('clear_cooldowns') || false;
        const validateRedis = false; // Disabled for stability
        const fixPlayerLock = null; // Disabled for stability

        console.log(`├─ Options: force=${force}, dry_run=${dryRun}, cleanup_orphaned=${cleanupOrphaned}, show_cooldowns=${showCooldowns}, clear_cooldowns=${clearCooldowns}`);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Send immediate status update
        await interaction.editReply({ content: '🔄 Starting Redis sync operation...' });

        try {
            console.log('├─ Testing connections...');
            
            // Test Redis connection
            await redisClient.client.ping();
            console.log('├─ Redis connection OK');
            
            // Update progress
            await interaction.editReply({ content: '🔄 Connections verified. Fetching ladder data...' });
            
            console.log('├─ Fetching current ladder data...');

            // Fetch data from Google Sheets
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A2:H`
            });

            const rows = result.data.values || [];
            console.log(`├─ Found ${rows.length} total rows in spreadsheet`);
            
            // Player lock fix disabled for stability
            if (false) {
                console.log(`├─ Fixing player lock for ${fixPlayerLock.tag} (${fixPlayerLock.id})...`);
                
                // Find the player in the spreadsheet
                const playerRow = rows.find(row => row[5] === fixPlayerLock.id); // Discord ID in column F
                
                if (!playerRow) {
                    return await interaction.editReply({
                        content: `❌ Player ${fixPlayerLock.tag} not found in the NvD ladder.`
                    });
                }
                
                const playerRank = playerRow[0];
                const playerStatus = playerRow[2]; // Status in column C
                const playerName = playerRow[1]; // Discord username in column B
                
                // Check current Redis state (simplified)
                const allChallenges = await redisClient.getAllChallenges();
                const playerChallenges = allChallenges.filter(c => 
                    c.player1.discordId === fixPlayerLock.id || 
                    c.player2.discordId === fixPlayerLock.id
                );
                
                let fixResult = { fixed: [], issues: [] };
                
                console.log(`│  ├─ Player: ${playerName} (Rank #${playerRank}, Status: ${playerStatus})`);
                console.log(`│  ├─ Redis lock: ${playerLock.isLocked ? 'LOCKED' : 'NOT LOCKED'}`);
                console.log(`│  └─ Active challenges in Redis: ${playerChallenges.length}`);
                
                // If player is Available in sheets but locked in Redis, remove the lock
                if (playerStatus === 'Available' && playerLock.isLocked) {
                    console.log(`│  ├─ Removing orphaned Redis lock for ${playerName}...`);
                    await redisClient.removePlayerLock(fixPlayerLock.id);
                    fixResult.fixed.push(`Removed orphaned Redis lock for ${playerName}`);
                }
                
                // If player has challenges in Redis but is Available in sheets, clean them up
                if (playerStatus === 'Available' && playerChallenges.length > 0) {
                    console.log(`│  ├─ Cleaning up ${playerChallenges.length} orphaned challenges...`);
                    for (const challenge of playerChallenges) {
                        const cleanupResult = await redisClient.atomicChallengeCleanup(
                            challenge.challenger.rank,
                            challenge.target.rank,
                            challenge.challenger.discordId,
                            challenge.target.discordId
                        );
                        if (cleanupResult.success) {
                            fixResult.fixed.push(`Cleaned up challenge: ${challenge.challenger.rank} vs ${challenge.target.rank}`);
                        } else {
                            fixResult.issues.push(`Failed to clean challenge: ${challenge.challenger.rank} vs ${challenge.target.rank}`);
                        }
                    }
                }
                
                // If player is in Challenge status in sheets but has no Redis data, this might be okay
                if (playerStatus === 'Challenge' && !playerLock.isLocked && playerChallenges.length === 0) {
                    fixResult.issues.push(`Player shows as 'Challenge' in sheets but has no Redis data - may need manual sync`);
                }
                
                const fixEmbed = new EmbedBuilder()
                    .setColor(fixResult.issues.length > 0 ? '#FFA500' : '#00FF00')
                    .setTitle(`🔧 Player Lock Fix: ${playerName}`)
                    .setDescription(`Diagnosed and fixed Redis issues for ${fixPlayerLock.tag}`)
                    .addFields(
                        {
                            name: '📊 Player Status',
                            value: `• Rank: #${playerRank}\n• Sheet Status: ${playerStatus}\n• Redis Lock: ${playerLock.isLocked ? 'LOCKED' : 'NOT LOCKED'}\n• Active Challenges: ${playerChallenges.length}`,
                            inline: false
                        }
                    )
                    .setTimestamp();
                
                if (fixResult.fixed.length > 0) {
                    fixEmbed.addFields({
                        name: '✅ Fixes Applied',
                        value: fixResult.fixed.map(fix => `• ${fix}`).join('\n'),
                        inline: false
                    });
                }
                
                if (fixResult.issues.length > 0) {
                    fixEmbed.addFields({
                        name: '⚠️ Issues Found',
                        value: fixResult.issues.map(issue => `• ${issue}`).join('\n'),
                        inline: false
                    });
                }
                
                console.log(`└─ Player lock fix completed for ${playerName}: ${fixResult.fixed.length} fixes, ${fixResult.issues.length} issues`);
                
                // If only fixing player lock, return early
                if (!force && !showCooldowns && !clearCooldowns && !cleanupOrphaned && !validateRedis) {
                    return await interaction.editReply({ embeds: [fixEmbed] });
                }
                
                // Store fix embed for later
                interaction.fixEmbed = fixEmbed;
            }
            
            // Redis validation simplified
            if (false) {
                console.log('├─ Running comprehensive Redis validation...');
                const validationResult = await redisClient.validateAndRepairRedisData(rows);
                
                const validationEmbed = new EmbedBuilder()
                    .setColor(validationResult.success ? '#00FF00' : '#FF0000')
                    .setTitle('🔍 Redis Validation Results')
                    .setDescription(
                        validationResult.success 
                            ? 'Redis validation completed successfully!' 
                            : `Validation failed: ${validationResult.error}`
                    )
                    .addFields(
                        {
                            name: '📊 Summary',
                            value: validationResult.summary ? 
                                `• Challenges: ${validationResult.summary.challenges}\n• Player locks: ${validationResult.summary.playerLocks}\n• Cooldowns: ${validationResult.summary.cooldowns}\n• Issues found: ${validationResult.summary.issuesFound}\n• Repairs made: ${validationResult.summary.repairsMade}` :
                                'Validation data unavailable',
                            inline: false
                        }
                    )
                    .setTimestamp();
                
                if (validationResult.issues && validationResult.issues.length > 0) {
                    const issuesList = validationResult.issues
                        .slice(0, 10)
                        .map(issue => `• ${issue.type}: ${issue.challenge || issue.discordId || 'N/A'}`)
                        .join('\n');
                    
                    validationEmbed.addFields({
                        name: '⚠️ Issues Found',
                        value: issuesList + (validationResult.issues.length > 10 ? `\n... and ${validationResult.issues.length - 10} more` : ''),
                        inline: false
                    });
                }
                
                if (validationResult.repairs && validationResult.repairs.length > 0) {
                    const repairsList = validationResult.repairs
                        .slice(0, 10)
                        .map(repair => `• ${repair}`)
                        .join('\n');
                    
                    validationEmbed.addFields({
                        name: '🔧 Repairs Made',
                        value: repairsList + (validationResult.repairs.length > 10 ? `\n... and ${validationResult.repairs.length - 10} more` : ''),
                        inline: false
                    });
                }
                
                // If only validation was requested, return early
                if (!force && !showCooldowns && !clearCooldowns && !cleanupOrphaned) {
                    return await interaction.editReply({ embeds: [validationEmbed] });
                }
                
                // Store validation embed for later
                interaction.validationEmbed = validationEmbed;
            }

            // Find all active challenges
            const challengePlayers = rows.filter(row => 
                row[0] && row[1] && row[2] === 'Challenge' && row[4] && row[5]
            );

            console.log(`├─ Found ${challengePlayers.length} players in active challenges`);

            // Progress update
            await interaction.editReply({ content: `🔄 Found ${challengePlayers.length} players in challenges. Processing...` });

            // Handle cooldown operations first
            if (showCooldowns || clearCooldowns) {
                console.log('├─ Processing cooldown operations...');
                const allCooldowns = await redisClient.listAllCooldowns();
                
                if (clearCooldowns && !dryRun) {
                    console.log(`├─ Clearing ${allCooldowns.length} cooldowns...`);
                    const clearResult = await redisClient.clearAllCooldowns();
                    if (clearResult.success) {
                        console.log(`├─ Successfully cleared ${clearResult.count} cooldown entries`);
                    } else {
                        console.error(`├─ Error clearing cooldowns: ${clearResult.error}`);
                    }
                }

                if (showCooldowns || dryRun) {
                    const cooldownEmbed = new EmbedBuilder()
                        .setColor(clearCooldowns && !dryRun ? '#FF6B6B' : '#FFA500')
                        .setTitle(clearCooldowns && !dryRun ? '🗑️ Cooldowns Cleared' : '🕒 Current Cooldowns')
                        .setDescription(
                            clearCooldowns && !dryRun 
                                ? `Cleared ${allCooldowns.length} player cooldowns from Redis.`
                                : `Found ${allCooldowns.length} active cooldowns in Redis.`
                        )
                        .setTimestamp();

                    if (allCooldowns.length > 0 && showCooldowns) {
                        const cooldownList = allCooldowns
                            .slice(0, 15) // Limit to avoid embed length issues
                            .map(cd => {
                                const hours = Math.floor(cd.remainingTime / 3600);
                                const minutes = Math.floor((cd.remainingTime % 3600) / 60);
                                return `• ${cd.player1.name} ↔ ${cd.player2.name} (${hours}h ${minutes}m)`;
                            })
                            .join('\n');

                        cooldownEmbed.addFields({
                            name: '🔒 Active Cooldowns',
                            value: cooldownList + (allCooldowns.length > 15 ? `\n... and ${allCooldowns.length - 15} more` : ''),
                            inline: false
                        });
                    }

                    // If only showing/clearing cooldowns, return early
                    if (!force && challengePlayers.length === 0) {
                        return await interaction.editReply({ embeds: [cooldownEmbed] });
                    }

                    // Add cooldown info to main response later
                    interaction.cooldownEmbed = cooldownEmbed;
                }
            }

            if (challengePlayers.length === 0 && !showCooldowns && !clearCooldowns) {
                const embed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('✅ Redis Sync Complete')
                    .setDescription('No active challenges found in Google Sheets to sync.')
                    .setTimestamp();

                return await interaction.editReply({ embeds: [embed] });
            }

            // Group into challenge pairs
            const activePartners = new Map(); // rank -> opponent rank
            const challengePairs = [];
            const processedPairs = new Set();

            challengePlayers.forEach(player => {
                activePartners.set(player[0], player[4]);
            });

            for (const player of challengePlayers) {
                const rank = player[0];
                const opponentRank = player[4];
                const pairKey = [rank, opponentRank].sort().join('-');

                if (processedPairs.has(pairKey)) continue;

                // Find the opponent
                const opponent = challengePlayers.find(p => p[0] === opponentRank);

                if (!opponent) {
                    console.log(`├─ WARNING: Could not find opponent for rank ${rank} vs ${opponentRank}`);
                    continue;
                }

                // Verify bidirectional challenge
                if (opponent[4] !== rank) {
                    console.log(`├─ WARNING: Challenge mismatch for ranks ${rank} and ${opponentRank}`);
                    continue;
                }

                processedPairs.add(pairKey);

                challengePairs.push({
                    challenger: {
                        rank: rank,
                        discordName: player[1],
                        discordId: player[5],
                        challengeDate: player[3]
                    },
                    target: {
                        rank: opponentRank,
                        discordName: opponent[1],
                        discordId: opponent[5],
                        challengeDate: opponent[3]
                    }
                });
            }

            console.log(`├─ Identified ${challengePairs.length} valid challenge pairs`);

            // For large datasets, process in background and send immediate response
            if (challengePairs.length > 10 && !dryRun) {
                // Start background processing
                setImmediate(async () => {
                    try {
                        await processChallengePairsAsync(challengePairs, force, interaction.client);
                        console.log(`└─ Background sync completed for ${challengePairs.length} pairs`);
                    } catch (bgError) {
                        console.error('Background sync error:', bgError);
                    }
                });

                // Send immediate response
                const quickEmbed = new EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('⚡ Redis Sync Started')
                    .setDescription(`Found ${challengePairs.length} challenge pairs. Sync is running in background.`)
                    .addFields({
                        name: '📝 Note',
                        value: 'Large sync operation detected. Processing in background to avoid timeout.',
                        inline: false
                    })
                    .setTimestamp();

                return await interaction.editReply({ embeds: [quickEmbed] });
            }

            // Check existing Redis entries
            let existingCount = 0;
            let syncedCount = 0;
            let skippedCount = 0;
            const syncResults = [];

            for (const pair of challengePairs) {
                const challengeKey = `nvd:challenge:${pair.challenger.rank}:${pair.target.rank}`;
                
                // Check if challenge already exists in Redis
                const existingChallenge = await redisClient.client.get(challengeKey);
                const challengerLock = await redisClient.checkPlayerLock(pair.challenger.discordId);
                const targetLock = await redisClient.checkPlayerLock(pair.target.discordId);

                if ((existingChallenge || challengerLock.isLocked || targetLock.isLocked) && !force) {
                    console.log(`├─ SKIP: Challenge ${pair.challenger.rank} vs ${pair.target.rank} already exists in Redis`);
                    existingCount++;
                    syncResults.push({
                        status: 'skipped',
                        challenger: pair.challenger.discordName,
                        challengerRank: pair.challenger.rank,
                        target: pair.target.discordName,
                        targetRank: pair.target.rank,
                        reason: 'Already exists'
                    });
                    continue;
                }

                if (dryRun) {
                    console.log(`├─ DRY RUN: Would sync challenge ${pair.challenger.rank} vs ${pair.target.rank}`);
                    syncResults.push({
                        status: 'would_sync',
                        challenger: pair.challenger.discordName,
                        challengerRank: pair.challenger.rank,
                        target: pair.target.discordName,
                        targetRank: pair.target.rank,
                        reason: 'Ready to sync'
                    });
                    syncedCount++;
                    continue;
                }

                // Actually sync to Redis
                try {
                    console.log(`├─ SYNC: Creating Redis entries for ${pair.challenger.rank} vs ${pair.target.rank}`);

                    // Calculate remaining time from original challenge date
                    let customTTL = null;
                    if (pair.challenger.challengeDate) {
                        const moment = require('moment-timezone');
                        const dateFormat = 'M/D, h:mm A';
                        
                        // Extract timezone from the date string
                        const timezoneMatch = pair.challenger.challengeDate.match(/\s+(EST|EDT)$/i);
                        const detectedTZ = timezoneMatch ? timezoneMatch[1].toUpperCase() : null;
                        const cleanDateStr = pair.challenger.challengeDate.replace(/\s+(EST|EDT)$/i, '').trim();
                        
                        // Parse in the correct timezone context
                        let challengeStart;
                        if (detectedTZ === 'EDT') {
                            // EDT is UTC-4, parse as Eastern Daylight Time
                            challengeStart = moment.tz(cleanDateStr, dateFormat, 'America/New_York');
                        } else if (detectedTZ === 'EST') {
                            // EST is UTC-5, parse as Eastern Standard Time
                            challengeStart = moment.tz(cleanDateStr, dateFormat, 'America/New_York');
                        } else {
                            // No timezone specified, assume current NY timezone
                            challengeStart = moment.tz(cleanDateStr, dateFormat, 'America/New_York');
                        }
                        
                        console.log(`├─ Parsing date: "${pair.challenger.challengeDate}" -> detected TZ: ${detectedTZ || 'none'} -> parsed: ${challengeStart.format()}`);
                        
                        if (challengeStart.isValid()) {
                            const now = moment().tz('America/New_York');
                            const currentYear = now.year();
                            
                            // Handle year assignment
                            if (challengeStart.month() > now.month() || 
                                (challengeStart.month() === now.month() && challengeStart.date() > now.date())) {
                                challengeStart.year(currentYear - 1);
                            } else {
                                challengeStart.year(currentYear);
                            }
                            
                            const elapsedHours = now.diff(challengeStart, 'hours');
                            const remainingHours = Math.max(0, (3 * 24) - elapsedHours); // 3 days = 72 hours
                            
                            if (remainingHours > 0) {
                                customTTL = Math.ceil(remainingHours * 3600); // Convert to seconds
                                console.log(`├─ Custom TTL: ${remainingHours.toFixed(1)} hours remaining (${customTTL}s)`);
                            } else {
                                console.log(`├─ WARNING: Challenge is expired (${(-remainingHours).toFixed(1)} hours overdue)`);
                                // Still sync but with short TTL for cleanup
                                customTTL = 300; // 5 minutes
                            }
                        }
                    }

                    // Set challenge in Redis with calculated TTL based on cDate
                    await redisClient.setChallenge(pair.challenger, pair.target, pair.challenger.challengeDate || '', customTTL);
                    
                    // Player locks removed for simplified approach (matching SvS-Bot-2)

                    syncedCount++;
                    syncResults.push({
                        status: 'synced',
                        challenger: pair.challenger.discordName,
                        challengerRank: pair.challenger.rank,
                        target: pair.target.discordName,
                        targetRank: pair.target.rank,
                        reason: 'Successfully synced'
                    });

                    console.log(`├─ SUCCESS: Synced ${pair.challenger.discordName} vs ${pair.target.discordName}`);

                } catch (syncError) {
                    console.error(`├─ ERROR: Failed to sync ${pair.challenger.rank} vs ${pair.target.rank}:`, syncError);
                    skippedCount++;
                    syncResults.push({
                        status: 'error',
                        challenger: pair.challenger.discordName,
                        challengerRank: pair.challenger.rank,
                        target: pair.target.discordName,
                        targetRank: pair.target.rank,
                        reason: `Error: ${syncError.message}`
                    });
                }
            }

            // Create response embed
            const embed = new EmbedBuilder()
                .setColor(dryRun ? '#FFA500' : (syncedCount > 0 ? '#00FF00' : '#FFFF00'))
                .setTitle(`${dryRun ? '🔍 Redis Sync Preview' : '✅ Redis Sync Complete'}${showCooldowns || clearCooldowns ? ' + Cooldowns' : ''}`)
                .setDescription(
                    dryRun 
                        ? `Preview of what would be synced to Redis:${showCooldowns || clearCooldowns ? ' (including cooldown operations)' : ''}`
                        : `Sync operation completed successfully!${showCooldowns || clearCooldowns ? ' (including cooldown operations)' : ''}`
                )
                .addFields(
                    { name: '📊 Statistics', value: 
                        `• Challenge pairs found: **${challengePairs.length}**\n` +
                        `• ${dryRun ? 'Would sync' : 'Successfully synced'}: **${syncedCount}**\n` +
                        `• Already existed: **${existingCount}**\n` +
                        `• Errors/Skipped: **${skippedCount}**`,
                        inline: false
                    }
                )
                .setTimestamp()
                .setFooter({ 
                    text: dryRun ? 'Run without dry_run to actually sync' : 'NvD Redis Sync',
                    iconURL: interaction.client.user.displayAvatarURL() 
                });

            // Add details if there are results to show
            if (syncResults.length > 0) {
                const detailsText = syncResults
                    .slice(0, 10) // Limit to 10 results to avoid embed length limits
                    .map(r => {
                        const statusEmoji = {
                            'synced': '✅',
                            'would_sync': '🔄',
                            'skipped': '⏭️',
                            'error': '❌'
                        }[r.status] || '❓';
                        
                        return `${statusEmoji} Rank #${r.challengerRank} ${r.challenger} vs Rank #${r.targetRank} ${r.target}`;
                    })
                    .join('\n');

                embed.addFields({
                    name: '📋 Details',
                    value: detailsText + (syncResults.length > 10 ? `\n... and ${syncResults.length - 10} more` : ''),
                    inline: false
                });
            }

            // Cleanup orphaned data if requested
            let cleanupStats = {
                orphanedPlayerLocks: 0,
                orphanedProcessingLocks: 0,
                staleData: 0
            };

            if (cleanupOrphaned && !dryRun) {
                console.log('├─ Performing orphaned data cleanup...');
                
                // Clean up orphaned player locks
                cleanupStats.orphanedPlayerLocks = await redisClient.cleanupOrphanedPlayerLocks();
                
                // Clean up any orphaned processing locks (they're temporary anyway)
                const processingKeys = await redisClient.client.keys('nvd:processing:lock:*');
                if (processingKeys.length > 0) {
                    await redisClient.client.del(...processingKeys);
                    cleanupStats.orphanedProcessingLocks = processingKeys.length;
                    console.log(`├─ Cleaned ${processingKeys.length} orphaned processing locks`);
                }
                
                // Check for challenges without corresponding player locks and vice versa
                const allChallenges = await redisClient.getAllChallenges();
                
                console.log(`├─ Challenge verification: ${allChallenges.length} active challenges found`);
            }

            // Verification info
            if (!dryRun) {
                const allChallenges = await redisClient.getAllChallenges();
                const allCooldowns = await redisClient.listAllCooldowns();
                
                // Get fresh cooldown count after potential clearing
                const finalCooldowns = clearCooldowns ? await redisClient.listAllCooldowns() : allCooldowns;
                
                let verificationText = `• Total challenges in Redis: **${allChallenges.length}**\n• Total cooldowns in Redis: **${finalCooldowns.length}**`;
                
                if (cleanupOrphaned) {
                    verificationText += `\n• Orphaned player locks cleaned: **${cleanupStats.orphanedPlayerLocks}**\n• Processing locks cleaned: **${cleanupStats.orphanedProcessingLocks}**`;
                }
                
                if (clearCooldowns) {
                    const clearedCount = allCooldowns.length - finalCooldowns.length;
                    verificationText += `\n• Cooldowns cleared: **${clearedCount}**`;
                }
                
                embed.addFields({
                    name: '🔍 Verification',
                    value: verificationText,
                    inline: false
                });
            }

            console.log(`└─ Sync command completed: ${syncedCount} synced, ${existingCount} existed, ${skippedCount} errors`);

            // Collect all embeds to send
            const embeds = [embed];
            if (interaction.cooldownEmbed) embeds.push(interaction.cooldownEmbed);
            if (interaction.validationEmbed) embeds.push(interaction.validationEmbed);
            if (interaction.fixEmbed) embeds.push(interaction.fixEmbed);
            
            await interaction.editReply({ embeds: embeds });

        } catch (error) {
            console.error(`└─ Error in sync command: ${error.message}`);
            logError('SyncRedis command error', error);

            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Redis Sync Failed')
                .setDescription(`An error occurred during the sync operation: ${error.message}`)
                .setTimestamp();

            await interaction.editReply({ embeds: [errorEmbed] });
        }
    },
};