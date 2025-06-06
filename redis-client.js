// redis-client.js
const Redis = require('ioredis');
const { logError } = require('./logger');
const { google } = require('googleapis');
const { EmbedBuilder } = require('discord.js');

// Constants for Redis keys - keep nvd: prefix for namespace separation but simplify structure
const CHALLENGE_KEY_PREFIX = 'nvd:challenge:';
const WARNING_KEY_PREFIX = 'nvd:challenge-warning:';
const COOLDOWN_KEY_PREFIX = 'nvd:cooldown:';
const CHALLENGE_EXPIRY_TIME = 60 * 60 * 24 * 3; // 3 days in seconds
const WARNING_EXPIRY_TIME = 60 * 60 * 24 * 2; // 2 days in seconds (warning at 24 hours left)
const PLAYER_LOCK_EXPIRY_TIME = 60 * 60 * 24 * 3; // 3 days in seconds (same as challenge)
const PROCESSING_LOCK_EXPIRY_TIME = 60 * 5; // 5 minutes for processing operations
const NOTIFICATION_CHANNEL_ID = '1144011555378298910'; // NvD challenges channel

class RedisClient {
    constructor() {
        let redisConfig = {};

        // Parse Redis Cloud URL if available
        if (process.env.REDISCLOUD_URL) {
            const redisUrl = new URL(process.env.REDISCLOUD_URL);
            redisConfig = {
                host: redisUrl.hostname,
                port: redisUrl.port,
                password: redisUrl.password ? redisUrl.password : undefined,
                username: redisUrl.username === 'default' ? undefined : redisUrl.username,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            };
        } else {
            // Fallback to individual environment variables
            redisConfig = {
                host: process.env.REDIS_HOST || 'localhost',
                port: process.env.REDIS_PORT || 6379,
                password: process.env.REDIS_PASSWORD,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            };
        }

        // Use the config
        this.client = new Redis(redisConfig);

        this.client.on('error', (err) => {
            console.error('❌ Redis Client Error:', err.message);
            logError(`Redis Client Error: ${err.message}\nStack: ${err.stack}`);
        });

        this.client.on('connect', () => {
            console.log('✅ Redis Client Connected');
        });
        
        this.client.on('reconnecting', (delay) => {
            console.log(`🔄 Redis reconnecting in ${delay}ms...`);
        });
        
        this.client.on('end', () => {
            console.log('🔌 Redis connection ended');
        });
        
        // Set up the expiry event listener if not already configured
        this.setupExpiryListener();
    }
    
    // Configure Redis to notify on key expirations
    async setupExpiryListener() {
        try {
            // Check if notifications are already enabled
            const config = await this.client.config('GET', 'notify-keyspace-events');
            const currentConfig = config[1];
            
            // Configure Redis to notify of expired events if not already enabled
            // 'Ex' means we want to be notified when a key expires
            if (!currentConfig.includes('E') || !currentConfig.includes('x')) {
                let newConfig = currentConfig;
                if (!newConfig.includes('E')) newConfig += 'E';
                if (!newConfig.includes('x')) newConfig += 'x';
                await this.client.config('SET', 'notify-keyspace-events', newConfig);
                console.log('Redis configured for key expiry notifications');
            }
            
            // Create a separate subscription client (Redis requires a dedicated connection for pub/sub)
            let subRedisConfig = {};

            // Parse Redis Cloud URL if available
            if (process.env.REDISCLOUD_URL) {
                const redisUrl = new URL(process.env.REDISCLOUD_URL);
                subRedisConfig = {
                    host: redisUrl.hostname,
                    port: redisUrl.port,
                    password: redisUrl.password ? redisUrl.password : undefined,
                    username: redisUrl.username === 'default' ? undefined : redisUrl.username,
                    retryStrategy: (times) => {
                        return Math.min(times * 50, 2000);
                    }
                };
            } else {
                // Fallback to individual environment variables
                subRedisConfig = {
                    host: process.env.REDIS_HOST || 'localhost',
                    port: process.env.REDIS_PORT || 6379,
                    password: process.env.REDIS_PASSWORD,
                    retryStrategy: (times) => {
                        return Math.min(times * 50, 2000);
                    }
                };
            }

            this.subClient = new Redis(subRedisConfig);
            
            // Subscribe to expiry events
            this.subClient.subscribe('__keyevent@0__:expired');
            console.log('Redis subscribed to expiry events');
            
            // Set up handler for expiry events
            this.subClient.on('message', async (channel, key) => {
                console.log(`Received expiry event for key: ${key}`);
                
                // Handle challenge expiry - only process nvd challenge keys
                if (key.startsWith(CHALLENGE_KEY_PREFIX)) {
                    // Add small delay to ensure the key has fully expired
                    setTimeout(async () => {
                        await this.handleChallengeExpiry(key);
                    }, 100);
                }
                
                // Handle warning expiry (time to send warning)
                if (key.startsWith(WARNING_KEY_PREFIX)) {
                    // Add small delay to ensure the key has fully expired
                    setTimeout(async () => {
                        await this.handleWarningExpiry(key);
                    }, 100);
                }
            });
            
        } catch (error) {
            console.error('Error setting up Redis expiry listener:', error);
            logError(`Error setting up Redis expiry listener: ${error.message}\nStack: ${error.stack}`);
        }
    }
    
    // Key format: `nvd:challenge:${player1Rank}-${player2Rank}` (sorted order like SvS-Bot-2)
    generateChallengeKey(player1Rank, player2Rank) {
        const pair = [String(player1Rank), String(player2Rank)].sort();
        const key = `${CHALLENGE_KEY_PREFIX}${pair[0]}-${pair[1]}`;
        console.log(`Generated challenge key: ${key} (ranks: ${player1Rank} vs ${player2Rank})`);
        return key;
    }

    // Store challenge in Redis - matches SvS-Bot-2 pattern with nvd namespace
    async setChallenge(player1, player2, challengeDate) {
        const key = this.generateChallengeKey(player1.rank, player2.rank);
        // 3 days expiry (259,200 seconds)
        const expiryTime = 3 * 24 * 60 * 60;
        // 24 hours before expiration (for warning) - 2 days
        const warningTime = 2 * 24 * 60 * 60;
        
        const challengeData = JSON.stringify({
            player1: {
                discordId: player1.discordId,
                name: player1.discordName,
                rank: player1.rank
            },
            player2: {
                discordId: player2.discordId,
                name: player2.discordName,
                rank: player2.rank
            },
            challengeDate: challengeDate,
            startTime: Date.now(),
            expiryTime: Date.now() + (expiryTime * 1000)
        });
        
        try {
            // Set the main challenge with expiration
            await this.client.setex(key, expiryTime, challengeData);
            console.log(`Set challenge for ${key} with expiry ${expiryTime}s`);
            
            // Set a separate key for the warning (expires 24 hours before the main challenge)
            const warningKey = `${WARNING_KEY_PREFIX}${key.substring(13)}`; // Remove 'nvd:challenge:' prefix
            await this.client.setex(warningKey, warningTime, key);
            console.log(`Set warning for ${warningKey} with expiry ${warningTime}s`);
            
            return true;
        } catch (error) {
            console.error('Error setting challenge:', error);
            logError(`Error setting challenge: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }
    
    // Remove challenge from Redis (used when a challenge is completed or manually cancelled)
    async removeChallenge(player1Rank, player2Rank) {
        const key = this.generateChallengeKey(player1Rank, player2Rank);
        const warningKey = `${WARNING_KEY_PREFIX}${key.substring(13)}`; // Remove 'nvd:challenge:' prefix
        
        try {
            console.log(`Attempting to remove challenge keys for ${player1Rank} vs ${player2Rank}`);
            console.log(`  Challenge key: ${key}`);
            console.log(`  Warning key: ${warningKey}`);
            
            // Check if keys exist before deletion
            const challengeExists = await this.client.exists(key);
            const warningExists = await this.client.exists(warningKey);
            
            console.log(`  Challenge key exists: ${challengeExists ? 'Yes' : 'No'}`);
            console.log(`  Warning key exists: ${warningExists ? 'Yes' : 'No'}`);
            
            // Remove both the challenge key and warning key
            const challengeDeleted = await this.client.del(key);
            const warningDeleted = await this.client.del(warningKey);
            
            console.log(`  Challenge key deleted: ${challengeDeleted}`);
            console.log(`  Warning key deleted: ${warningDeleted}`);
            console.log(`✅ Successfully removed challenge and warning for ${key}`);
            
            return true;
        } catch (error) {
            console.error('❌ Error removing challenge:', error);
            logError(`Error removing challenge: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }
    
    // Handle warning expiry (send notification message)
    async handleWarningExpiry(key) {
        try {
            console.log(`Processing warning expiry for key: ${key}`);
            
            // Extract ranks from the key (format: nvd:challenge-warning:rank1-rank2)
            const keyParts = key.replace(WARNING_KEY_PREFIX, '').split('-');
            if (keyParts.length !== 2) {
                console.log(`Skipping malformed warning key: ${key}`);
                return;
            }
            
            const challengerRank = keyParts[0];
            const targetRank = keyParts[1];
            
            // Log the warning expiry
            console.log(`Challenge warning triggered for ${challengerRank} vs ${targetRank}`);
            
            // Get discord client (needs to be passed in from index.js)
            const discordClient = global.discordClient;
            if (!discordClient) {
                console.error('Discord client not available for sending warning');
                return;
            }
            
            // Get the challenge data from the main challenge key
            const challengeKey = this.generateChallengeKey(challengerRank, targetRank);
            const challengeData = await this.client.get(challengeKey);
            
            if (!challengeData) {
                console.log(`Challenge no longer exists for ${challengerRank} vs ${targetRank}, skipping warning`);
                return;
            }
            
            const challenge = JSON.parse(challengeData);
            
            // Double-check that the challenge key still exists with TTL
            const challengeTTL = await this.client.ttl(challengeKey);
            if (challengeTTL <= 0) {
                console.log(`Challenge key ${challengeKey} has no TTL or has expired, skipping warning`);
                return;
            }
            
            // Find the notification channel
            const channel = discordClient.channels.cache.get(NOTIFICATION_CHANNEL_ID);
            if (!channel) {
                console.error('Could not find notification channel');
                return;
            }
            
            console.log(`Sending warning for active challenge: ${challengerRank} vs ${targetRank} (TTL: ${challengeTTL}s)`);
            
            // Send warning message (direct mention, not embed)
            await channel.send(
                `⚠️ **Challenge Expiry Warning** ⚠️\n` +
                `<@${challenge.player1.discordId}> and <@${challenge.player2.discordId}>, your challenge will automatically expire in 24 hours! ` +
                `Please complete your match or use \`/nvd-extendchallenge\` if you need more time.`
            );
            
            console.log('Challenge expiry warning sent successfully');
            
        } catch (error) {
            console.error('Error handling warning expiry:', error);
            logError(`Error handling warning expiry: ${error.message}\nStack: ${error.stack}`);
        }
    }
    
    // Handle challenge expiry (auto-null the challenge)
    async handleChallengeExpiry(key) {
        try {
            console.log(`Processing challenge expiry for key: ${key}`);
            
            // First verify this key actually expired (prevent duplicate processing)
            const keyExists = await this.client.exists(key);
            if (keyExists === 1) {
                console.log(`Skipping challenge expiry for ${key} - key still exists (not actually expired)`);
                return;
            }
            
            // Extract ranks from the key (format: nvd:challenge:rank1-rank2)
            const keyParts = key.replace(CHALLENGE_KEY_PREFIX, '').split('-');
            if (keyParts.length !== 2) {
                console.log(`Skipping malformed challenge key: ${key}`);
                return;
            }
            
            const challengerRank = keyParts[0];
            const targetRank = keyParts[1];
            const challengeKey = `${challengerRank}-${targetRank}`;
            
            // Acquire distributed lock to prevent concurrent processing
            const lock = await this.acquireProcessingLock(`expiry:${challengeKey}`);
            if (!lock.acquired) {
                console.log(`Skipping challenge expiry for ${challengeKey} - already being processed`);
                return;
            }

            try {
                console.log(`🔒 Auto-nulling expired challenge: ${challengerRank} vs ${targetRank}`);
                
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
                const sheetId = 0; // Numeric sheetId for 'NvD Ladder' tab
                
                // Get the challenge data
                const challengeData = await this.client.getBuffer(key);
                let challenge;
                let challengerRowIndex = -1;
                let targetRowIndex = -1;
                
                // If we have the challenge data in cache, use it
                if (challengeData) {
                    challenge = JSON.parse(challengeData.toString());
                }
                
                // Fetch data from Google Sheets (NvD column structure)
                const result = await sheets.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${SHEET_NAME}!A2:H`
                });
                
                const rows = result.data.values;
                if (!rows?.length) {
                    console.error('No data found in spreadsheet');
                    return;
                }
                
                // Find the rows with matching ranks
                challengerRowIndex = rows.findIndex(row => parseInt(row[0]) === parseInt(challengerRank));
                targetRowIndex = rows.findIndex(row => parseInt(row[0]) === parseInt(targetRank));
                
                // Add 2 to row indices because our range starts from A2
                if (challengerRowIndex !== -1) challengerRowIndex += 2;
                if (targetRowIndex !== -1) targetRowIndex += 2;
                
                // If we couldn't get challenge data from Redis, construct it from spreadsheet
                if (!challenge && challengerRowIndex !== -1 && targetRowIndex !== -1) {
                    // Get player info from spreadsheet
                    const challengerRow = rows[challengerRowIndex - 2];
                    const targetRow = rows[targetRowIndex - 2];
                    
                    challenge = {
                        player1: {
                            name: challengerRow[1], // Discord username in column B
                            discordId: challengerRow[5], // Discord ID in column F
                            rank: challengerRow[0]
                        },
                        player2: {
                            name: targetRow[1], // Discord username in column B
                            discordId: targetRow[5], // Discord ID in column F
                            rank: targetRow[0]
                        }
                    };
                }
                
                // If we couldn't find the rows or challenge data, abort
                if (challengerRowIndex === -1 || targetRowIndex === -1 || !challenge) {
                    console.error('Could not find challenge rows in spreadsheet');
                    return;
                }
                
                // Update the spreadsheet - reset statuses to Available
                let requests = [];
                
                // Update challenger row
                requests.push({
                    updateCells: {
                        range: {
                            sheetId: sheetId,
                            startRowIndex: challengerRowIndex - 1,
                            endRowIndex: challengerRowIndex,
                            startColumnIndex: 2, // Column C (Status) is index 2
                            endColumnIndex: 5 // Through Column E (Opp#) is index 4
                        },
                        rows: [{
                            values: [
                                { userEnteredValue: { stringValue: 'Available' } }, // Status
                                { userEnteredValue: { stringValue: '' } }, // Challenge date
                                { userEnteredValue: { stringValue: '' } } // Opponent
                            ]
                        }],
                        fields: 'userEnteredValue'
                    }
                });
                
                // Update target row
                requests.push({
                    updateCells: {
                        range: {
                            sheetId: sheetId,
                            startRowIndex: targetRowIndex - 1,
                            endRowIndex: targetRowIndex,
                            startColumnIndex: 2, // Column C (Status) is index 2
                            endColumnIndex: 5 // Through Column E (Opp#) is index 4
                        },
                        rows: [{
                            values: [
                                { userEnteredValue: { stringValue: 'Available' } }, // Status
                                { userEnteredValue: { stringValue: '' } }, // Challenge date
                                { userEnteredValue: { stringValue: '' } } // Opponent
                            ]
                        }],
                        fields: 'userEnteredValue'
                    }
                });
                
                // Execute the updates
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: SPREADSHEET_ID,
                    resource: { requests }
                });
                
                console.log('Successfully reset challenge status in spreadsheet');
                
                // Simple cleanup like SvS-Bot-2 (no complex locking)
                await this.removeChallenge(challengerRank, targetRank);
                console.log('✅ Challenge cleanup completed successfully');
                
                // Send notification embed
                const discordClient = global.discordClient;
                if (discordClient) {
                    // Find the notification channel
                    const channel = discordClient.channels.cache.get(NOTIFICATION_CHANNEL_ID);
                    if (channel) {
                        // Create the embed
                        const embed = new EmbedBuilder()
                            .setColor('#8A2BE2')
                            .setTitle('🕒 Challenge Auto-Nullified')
                            .setDescription('The following challenge has been automatically nullified after 3 days:')
                            .addFields(
                                {
                                    name: ':bone: Challenger',
                                    value: `Rank #${challenge.player1.rank} (<@${challenge.player1.discordId}>)`,
                                    inline: true
                                },
                                {
                                    name: '​',
                                    value: 'VS',
                                    inline: true
                                },
                                {
                                    name: ':bear: Challenged',
                                    value: `Rank #${challenge.player2.rank} (<@${challenge.player2.discordId}>)`,
                                    inline: true
                                }
                            )
                            .setTimestamp()
                            .setFooter({
                                text: 'Players are now free to issue new challenges',
                                iconURL: discordClient.user.displayAvatarURL()
                            });
                        
                        await channel.send({ embeds: [embed] });
                        console.log('Auto-null notification sent successfully');
                    } else {
                        console.error('Could not find notification channel');
                    }
                } else {
                    console.error('Discord client not available for sending notification');
                }
                
            } finally {
                // Always release the processing lock
                await this.releaseProcessingLock(lock.lockKey, lock.lockValue);
            }
            
        } catch (error) {
            console.error('Error handling challenge expiry:', error);
            logError(`Error handling challenge expiry: ${error.message}\nStack: ${error.stack}`);
        }
    }

    // Key format: `nvd:cooldown:${discordId1}:${discordId2}` (sorted order, simplified from SvS element-based keys)
    generateCooldownKey(player1, player2) {
        const pair = [
            `${player1.discordId}`,
            `${player2.discordId}`
        ].sort(); // Sort to ensure consistent key regardless of order
        const key = `${COOLDOWN_KEY_PREFIX}${pair[0]}:${pair[1]}`;
        console.log(`Generated cooldown key: ${key}`);
        return key;
    }

    async setCooldown(player1, player2) {
        const key = this.generateCooldownKey(player1, player2);
        const expiryTime = 24 * 60 * 60; // 24 hours in seconds
        const cooldownData = JSON.stringify({
            player1: {
                discordId: player1.discordId,
                name: player1.name || 'Unknown' // Handle missing name like SvS
            },
            player2: {
                discordId: player2.discordId,
                name: player2.name || 'Unknown' // Handle missing name like SvS
            },
            startTime: Date.now(),
            expiryTime: Date.now() + (expiryTime * 1000)
        });
        
        try {
            await this.client.setex(key, expiryTime, cooldownData);
            console.log(`Set cooldown for ${key} with expiry ${expiryTime}s`);
            return true;
        } catch (error) {
            console.error('Error setting cooldown:', error);
            logError(`Error setting cooldown: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }

    async checkCooldown(player1, player2) {
        const key = this.generateCooldownKey(player1, player2);
        
        try {
            const cooldownData = await this.client.get(key);
            if (cooldownData) {
                const ttl = await this.client.ttl(key);
                const data = JSON.parse(cooldownData);
                const hoursRemaining = Math.floor(ttl / 3600);
                const minutesRemaining = Math.floor((ttl % 3600) / 60);
                console.log(`Cooldown active: ${key} | TTL: ${ttl}s (${hoursRemaining}h ${minutesRemaining}m)`);
                return {
                    onCooldown: true,
                    remainingTime: ttl,
                    details: data
                };
            }
            console.log(`No cooldown found for key: ${key}`);
            return {
                onCooldown: false,
                remainingTime: 0,
                details: null
            };
        } catch (error) {
            console.error(`Error checking cooldown ${key}:`, error);
            logError(`Error checking cooldown ${key}: ${error.message}\nStack: ${error.stack}`);
            return {
                onCooldown: false,
                remainingTime: 0,
                details: null,
                error: true
            };
        }
    }

    async removeCooldown(player1, player2) {
        const key = this.generateCooldownKey(player1, player2);
        
        try {
            await this.client.del(key);
            console.log(`Removed cooldown for ${key}`);
            return true;
        } catch (error) {
            console.error('Error removing cooldown:', error);
            logError(`Error removing cooldown: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }

    // Check if a challenge exists between two players - matches SvS-Bot-2
    async checkChallenge(player1Rank, player2Rank) {
        const key = this.generateChallengeKey(player1Rank, player2Rank);
        
        try {
            const challengeData = await this.client.get(key);
            if (challengeData) {
                const ttl = await this.client.ttl(key);
                const data = JSON.parse(challengeData);
                const hoursRemaining = Math.floor(ttl / 3600);
                const minutesRemaining = Math.floor((ttl % 3600) / 60);
                console.log(`Challenge found: ${key} | TTL: ${ttl}s (${hoursRemaining}h ${minutesRemaining}m)`);
                return {
                    active: true,
                    remainingTime: ttl,
                    details: data
                };
            }
            console.log(`No challenge found for key: ${key}`);
            return {
                active: false,
                remainingTime: 0,
                details: null
            };
        } catch (error) {
            console.error(`Error checking challenge ${key}:`, error);
            logError(`Error checking challenge ${key}: ${error.message}\nStack: ${error.stack}`);
            return {
                active: false,
                remainingTime: 0,
                details: null,
                error: true
            };
        }
    }

    // Debug method to list all active cooldowns
    async listAllCooldowns() {
        try {
            const keys = await this.client.keys(`${COOLDOWN_KEY_PREFIX}*`);
            const cooldowns = [];
            
            for (const key of keys) {
                const cooldownData = await this.client.get(key);
                const ttl = await this.client.ttl(key);
                
                if (cooldownData) {
                    const data = JSON.parse(cooldownData);
                    cooldowns.push({
                        player1: data.player1,
                        player2: data.player2,
                        remainingTime: ttl
                    });
                }
            }
            
            return cooldowns;
        } catch (error) {
            console.error('Error listing cooldowns:', error);
            logError(`Error listing cooldowns: ${error.message}\nStack: ${error.stack}`);
            return [];
        }
    }
    
    // List all active challenges - matches SvS-Bot-2 method name
    async getAllChallenges() {
        try {
            const keys = await this.client.keys(`${CHALLENGE_KEY_PREFIX}*`);
            const challenges = [];
            
            for (const key of keys) {
                const challengeData = await this.client.get(key);
                const ttl = await this.client.ttl(key);
                
                if (challengeData) {
                    const data = JSON.parse(challengeData);
                    challenges.push({
                        key: key,
                        player1: data.player1,
                        player2: data.player2,
                        challengeDate: data.challengeDate,
                        remainingTime: ttl
                    });
                }
            }
            
            return challenges;
        } catch (error) {
            console.error('Error listing challenges:', error);
            logError(`Error listing challenges: ${error.message}\nStack: ${error.stack}`);
            return [];
        }
    }

    // Helper method to get all cooldowns for a specific player's Discord ID
    async getPlayerCooldowns(discordId) {
        try {
            const keys = await this.client.keys(`${COOLDOWN_KEY_PREFIX}*`);
            const cooldowns = [];
            
            for (const key of keys) {
                const cooldownData = await this.client.get(key);
                if (cooldownData) {
                    const data = JSON.parse(cooldownData);
                    if (data.player1.discordId === discordId || data.player2.discordId === discordId) {
                        const ttl = await this.client.ttl(key);
                        cooldowns.push({
                            opponent: data.player1.discordId === discordId ? data.player2 : data.player1,
                            remainingTime: ttl
                        });
                    }
                }
            }
            
            return cooldowns;
        } catch (error) {
            console.error('Error getting player cooldowns:', error);
            logError(`Error getting player cooldowns: ${error.message}\nStack: ${error.stack}`);
            return [];
        }
    }

    // Utility method for debugging Redis state
    async logRedisStatus() {
        try {
            const challenges = await this.getAllChallenges();
            const cooldowns = await this.listAllCooldowns();
            const challengeKeys = await this.client.keys('nvd:challenge:*');
            const warningKeys = await this.client.keys('nvd:challenge-warning:*');
            const cooldownKeys = await this.client.keys('nvd:cooldown:*');
            
            console.log('📊 Redis Status Summary:');
            console.log(`  • Active challenges: ${challenges.length}`);
            console.log(`  • Challenge keys: ${challengeKeys.length}`);
            console.log(`  • Warning keys: ${warningKeys.length}`);
            console.log(`  • Active cooldowns: ${cooldowns.length}`);
            console.log(`  • Cooldown keys: ${cooldownKeys.length}`);
            
            return {
                challenges: challenges.length,
                challengeKeys: challengeKeys.length,
                warningKeys: warningKeys.length,
                cooldowns: cooldowns.length,
                cooldownKeys: cooldownKeys.length
            };
        } catch (error) {
            console.error('❌ Error getting Redis status:', error);
            return null;
        }
    }
}

module.exports = new RedisClient();