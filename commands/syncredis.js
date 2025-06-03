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

        console.log(`├─ Options: force=${force}, dry_run=${dryRun}`);

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

            // Find all active challenges
            const challengePlayers = rows.filter(row => 
                row[0] && row[1] && row[2] === 'Challenge' && row[4] && row[5]
            );

            console.log(`├─ Found ${challengePlayers.length} players in active challenges`);

            // Progress update
            await interaction.editReply({ content: `🔄 Found ${challengePlayers.length} players in challenges. Processing...` });

            if (challengePlayers.length === 0) {
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

                    // Set challenge in Redis
                    await redisClient.setChallenge(pair.challenger, pair.target, interaction.client);

                    // Set player locks
                    await redisClient.setPlayerLock(pair.challenger.discordId, challengeKey);
                    await redisClient.setPlayerLock(pair.target.discordId, challengeKey);

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
                .setTitle(`${dryRun ? '🔍 Redis Sync Preview' : '✅ Redis Sync Complete'}`)
                .setDescription(
                    dryRun 
                        ? `Preview of what would be synced to Redis:`
                        : `Sync operation completed successfully!`
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

            // Verification info
            if (!dryRun && syncedCount > 0) {
                const allLocks = await redisClient.listAllPlayerLocks();
                const allChallenges = await redisClient.listAllChallenges();
                
                embed.addFields({
                    name: '🔍 Verification',
                    value: `• Total player locks in Redis: **${allLocks.length}**\n• Total challenges in Redis: **${allChallenges.length}**`,
                    inline: false
                });
            }

            console.log(`└─ Sync command completed: ${syncedCount} synced, ${existingCount} existed, ${skippedCount} errors`);

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error(`└─ Error in sync command: ${error.message}`);
            console.error(`└─ Full error:`, error);
            logError(`SyncRedis command error: ${error.message}\nStack: ${error.stack}`);

            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Redis Sync Failed')
                .setDescription(`An error occurred during the sync operation: ${error.message}`)
                .setTimestamp();

            await interaction.editReply({ embeds: [errorEmbed] });
        }
    },
};