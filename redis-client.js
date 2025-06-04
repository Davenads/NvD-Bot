// redis-client.js
const Redis = require('ioredis');
const { logError } = require('./logger');
const { google } = require('googleapis');
const { EmbedBuilder } = require('discord.js');

// Constants for Redis keys
const CHALLENGE_KEY_PREFIX = 'nvd:challenge:';
const WARNING_KEY_PREFIX = 'nvd:challenge:warning:';
const COOLDOWN_KEY_PREFIX = 'nvd:cooldown:';
const PLAYER_LOCK_KEY_PREFIX = 'nvd:player:lock:';
const PROCESSING_LOCK_KEY_PREFIX = 'nvd:processing:lock:';
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
            console.error('Redis Client Error:', err);
            logError(`Redis Client Error: ${err.message}\nStack: ${err.stack}`);
        });

        this.client.on('connect', () => {
            console.log('Redis Client Connected');
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
                
                // Handle challenge expiry
                if (key.startsWith(CHALLENGE_KEY_PREFIX) && !key.includes('warning')) {
                    await this.handleChallengeExpiry(key);
                }
                
                // Handle warning expiry (time to send warning)
                if (key.includes('warning')) {
                    await this.handleWarningExpiry(key);
                }
            });
            
        } catch (error) {
            console.error('Error setting up Redis expiry listener:', error);
            logError(`Error setting up Redis expiry listener: ${error.message}\nStack: ${error.stack}`);
        }
    }
    
    // Store challenge in Redis when created
    async setChallenge(challenger, target, discordClient) {
        return this.setChallengeWithTTL(challenger, target, discordClient, CHALLENGE_EXPIRY_TIME);
    }

    // Store challenge in Redis with custom TTL
    async setChallengeWithTTL(challenger, target, discordClient, customTTL) {
        try {
            // Create challenge key
            const challengeKey = `${CHALLENGE_KEY_PREFIX}${challenger.rank}:${target.rank}`;
            
            // Challenge data to store
            const challengeData = JSON.stringify({
                challenger: {
                    discordId: challenger.discordId,
                    name: challenger.discordName,
                    rank: challenger.rank
                },
                target: {
                    discordId: target.discordId,
                    name: target.discordName,
                    rank: target.rank
                },
                startTime: Date.now(),
                expiryTime: Date.now() + (CHALLENGE_EXPIRY_TIME * 1000)
            });
            
            // Store challenge with custom expiry
            await this.client.setex(challengeKey, customTTL, challengeData);
            console.log(`Set challenge ${challengeKey} with expiry ${customTTL}s`);
            
            // Create warning key to trigger 24 hours before expiry (if TTL > 24 hours)
            const warningKey = `${WARNING_KEY_PREFIX}${challenger.rank}:${target.rank}`;
            const warningTTL = Math.max(0, customTTL - (24 * 60 * 60)); // 24 hours before expiry
            if (warningTTL > 0) {
                await this.client.setex(warningKey, warningTTL, challengeData);
                console.log(`Set warning ${warningKey} with expiry ${warningTTL}s`);
            } else {
                console.log(`Skipping warning key - TTL too short (${customTTL}s)`);
            }
            
            return true;
        } catch (error) {
            console.error('Error setting challenge:', error);
            logError(`Error setting challenge: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }
    
    // Remove challenge from Redis (used when a challenge is completed or manually cancelled)
    async removeChallenge(challengerRank, targetRank) {
        try {
            const challengeKey = `${CHALLENGE_KEY_PREFIX}${challengerRank}:${targetRank}`;
            const warningKey = `${WARNING_KEY_PREFIX}${challengerRank}:${targetRank}`;
            
            await this.client.del(challengeKey);
            await this.client.del(warningKey);
            console.log(`Removed challenge keys: ${challengeKey}, ${warningKey}`);
            return true;
        } catch (error) {
            console.error('Error removing challenge:', error);
            logError(`Error removing challenge: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }
    
    // Handle warning expiry (send notification message)
    async handleWarningExpiry(key) {
        try {
            console.log(`Processing warning expiry for key: ${key}`);
            
            // Extract ranks from the key
            const keyParts = key.replace(WARNING_KEY_PREFIX, '').split(':');
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
            const challengeKey = `${CHALLENGE_KEY_PREFIX}${challengerRank}:${targetRank}`;
            const challengeData = await this.client.get(challengeKey);
            
            if (!challengeData) {
                console.log('Challenge no longer exists, skipping warning');
                return;
            }
            
            const challenge = JSON.parse(challengeData);
            
            // Find the notification channel
            const channel = discordClient.channels.cache.get(NOTIFICATION_CHANNEL_ID);
            if (!channel) {
                console.error('Could not find notification channel');
                return;
            }
            
            // Send warning message (direct mention, not embed)
            await channel.send(
                `⚠️ **Challenge Expiry Warning** ⚠️\n` +
                `<@${challenge.challenger.discordId}> and <@${challenge.target.discordId}>, your challenge will automatically expire in 24 hours! ` +
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
            
            // Extract ranks from the key
            const keyParts = key.replace(CHALLENGE_KEY_PREFIX, '').split(':');
            const challengerRank = keyParts[0];
            const targetRank = keyParts[1];
            const challengeKey = `${challengerRank}:${targetRank}`;
            
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
                
                // Fetch data from Google Sheets
                const result = await sheets.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${SHEET_NAME}!A2:F`
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
                        challenger: {
                            name: challengerRow[1], // Discord username in column B
                            discordId: challengerRow[5], // Discord ID in column F
                            rank: challengerRow[0]
                        },
                        target: {
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
                
                // Use atomic cleanup for Redis
                const cleanupResult = await this.atomicChallengeCleanup(
                    challengerRank, 
                    targetRank, 
                    challenge.challenger.discordId, 
                    challenge.target.discordId
                );
                
                if (!cleanupResult.success) {
                    console.warn('Redis cleanup had issues during auto-expiry:', cleanupResult.errors);
                } else {
                    console.log('✅ Redis cleanup completed successfully during auto-expiry');
                }
                
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
                                    value: `Rank #${challenge.challenger.rank} (<@${challenge.challenger.discordId}>)`,
                                    inline: true
                                },
                                {
                                    name: '​',
                                    value: 'VS',
                                    inline: true
                                },
                                {
                                    name: ':bear: Challenged',
                                    value: `Rank #${challenge.target.rank} (<@${challenge.target.discordId}>)`,
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

    // CHANGED: Updated key format: `nvd:cooldown:${discordId1}:${discordId2}`
    generateCooldownKey(player1, player2) {
        const pair = [
            `${player1.discordId}`,
            `${player2.discordId}`
        ].sort(); // Sort to ensure consistent key regardless of order
        return `${COOLDOWN_KEY_PREFIX}${pair[0]}:${pair[1]}`;
    }

    async setCooldown(player1, player2) {
        const key = this.generateCooldownKey(player1, player2);
        const expiryTime = 24 * 60 * 60; // 24 hours in seconds
        const cooldownData = JSON.stringify({
            player1: {
                discordId: player1.discordId,
                name: player1.name
                // CHANGED: Removed element property
            },
            player2: {
                discordId: player2.discordId,
                name: player2.name
                // CHANGED: Removed element property
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
                return {
                    onCooldown: true,
                    remainingTime: ttl,
                    details: data
                };
            }
            return {
                onCooldown: false,
                remainingTime: 0,
                details: null
            };
        } catch (error) {
            console.error('Error checking cooldown:', error);
            logError(`Error checking cooldown: ${error.message}\nStack: ${error.stack}`);
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
    
    // List all active challenges
    async listAllChallenges() {
        try {
            const keys = await this.client.keys(`${CHALLENGE_KEY_PREFIX}*`);
            const challenges = [];
            
            for (const key of keys) {
                // Skip warning keys
                if (key.includes('warning')) continue;
                
                const challengeData = await this.client.get(key);
                const ttl = await this.client.ttl(key);
                
                if (challengeData) {
                    const data = JSON.parse(challengeData);
                    challenges.push({
                        challenger: data.challenger,
                        target: data.target,
                        remainingTime: ttl,
                        key: key
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

    // Player Lock Management Methods
    // Set a lock for a player involved in a challenge
    async setPlayerLock(discordId, challengeKey) {
        return this.setPlayerLockWithTTL(discordId, challengeKey, PLAYER_LOCK_EXPIRY_TIME);
    }

    // Set a player lock with custom TTL
    async setPlayerLockWithTTL(discordId, challengeKey, customTTL) {
        try {
            const lockKey = `${PLAYER_LOCK_KEY_PREFIX}${discordId}`;
            const lockData = JSON.stringify({
                challengeKey: challengeKey,
                timestamp: Date.now(),
                expiryTime: Date.now() + (PLAYER_LOCK_EXPIRY_TIME * 1000)
            });
            
            await this.client.setex(lockKey, customTTL, lockData);
            console.log(`Set player lock for ${discordId} with challenge ${challengeKey} (TTL: ${customTTL}s)`);
            return true;
        } catch (error) {
            console.error('Error setting player lock:', error);
            logError(`Error setting player lock: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }

    // Remove a player lock
    async removePlayerLock(discordId) {
        try {
            const lockKey = `${PLAYER_LOCK_KEY_PREFIX}${discordId}`;
            await this.client.del(lockKey);
            console.log(`Removed player lock for ${discordId}`);
            return true;
        } catch (error) {
            console.error('Error removing player lock:', error);
            logError(`Error removing player lock: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }

    // Check if a player is locked (involved in a challenge)
    async checkPlayerLock(discordId) {
        try {
            const lockKey = `${PLAYER_LOCK_KEY_PREFIX}${discordId}`;
            const lockData = await this.client.get(lockKey);
            
            if (lockData) {
                const data = JSON.parse(lockData);
                const ttl = await this.client.ttl(lockKey);
                return {
                    isLocked: true,
                    challengeKey: data.challengeKey,
                    remainingTime: ttl,
                    lockData: data
                };
            }
            
            return {
                isLocked: false,
                challengeKey: null,
                remainingTime: 0,
                lockData: null
            };
        } catch (error) {
            console.error('Error checking player lock:', error);
            logError(`Error checking player lock: ${error.message}\nStack: ${error.stack}`);
            return {
                isLocked: false,
                challengeKey: null,
                remainingTime: 0,
                lockData: null,
                error: true
            };
        }
    }

    // Get all active player locks (for debugging)
    async listAllPlayerLocks() {
        try {
            const keys = await this.client.keys(`${PLAYER_LOCK_KEY_PREFIX}*`);
            const locks = [];
            
            for (const key of keys) {
                const lockData = await this.client.get(key);
                const ttl = await this.client.ttl(key);
                
                if (lockData) {
                    const data = JSON.parse(lockData);
                    const discordId = key.replace(PLAYER_LOCK_KEY_PREFIX, '');
                    locks.push({
                        discordId: discordId,
                        challengeKey: data.challengeKey,
                        remainingTime: ttl,
                        timestamp: data.timestamp
                    });
                }
            }
            
            return locks;
        } catch (error) {
            console.error('Error listing player locks:', error);
            logError(`Error listing player locks: ${error.message}\nStack: ${error.stack}`);
            return [];
        }
    }

    // Clean up orphaned player locks (utility method)
    async cleanupOrphanedPlayerLocks() {
        try {
            const playerLocks = await this.listAllPlayerLocks();
            const challengeKeys = await this.client.keys(`${CHALLENGE_KEY_PREFIX}*`);
            
            // Filter out warning keys to get actual challenge keys
            const activeChallengeKeys = challengeKeys.filter(key => !key.includes('warning'));
            
            let cleanedCount = 0;
            for (const lock of playerLocks) {
                // Check if the challenge this lock references still exists
                if (!activeChallengeKeys.includes(lock.challengeKey)) {
                    await this.removePlayerLock(lock.discordId);
                    cleanedCount++;
                    console.log(`Cleaned orphaned lock for player ${lock.discordId}`);
                }
            }
            
            console.log(`Cleaned ${cleanedCount} orphaned player locks`);
            return cleanedCount;
        } catch (error) {
            console.error('Error cleaning orphaned player locks:', error);
            logError(`Error cleaning orphaned player locks: ${error.message}\nStack: ${error.stack}`);
            return 0;
        }
    }

    // Distributed locking for processing operations
    async acquireProcessingLock(challengeKey) {
        try {
            const lockKey = `${PROCESSING_LOCK_KEY_PREFIX}${challengeKey}`;
            const lockValue = `${Date.now()}_${Math.random()}`;
            
            // Use SET with NX (only set if key doesn't exist) and EX (expiry)
            const result = await this.client.set(lockKey, lockValue, 'EX', PROCESSING_LOCK_EXPIRY_TIME, 'NX');
            
            if (result === 'OK') {
                console.log(`Acquired processing lock for ${challengeKey}`);
                return { acquired: true, lockKey, lockValue };
            } else {
                console.log(`Failed to acquire processing lock for ${challengeKey} - already locked`);
                return { acquired: false, lockKey: null, lockValue: null };
            }
        } catch (error) {
            console.error('Error acquiring processing lock:', error);
            logError(`Error acquiring processing lock: ${error.message}\nStack: ${error.stack}`);
            return { acquired: false, lockKey: null, lockValue: null, error: true };
        }
    }

    async releaseProcessingLock(lockKey, lockValue) {
        try {
            // Use Lua script to atomically check value and delete
            const luaScript = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            
            const result = await this.client.eval(luaScript, 1, lockKey, lockValue);
            
            if (result === 1) {
                console.log(`Released processing lock for ${lockKey}`);
                return true;
            } else {
                console.log(`Could not release processing lock for ${lockKey} - value mismatch or already released`);
                return false;
            }
        } catch (error) {
            console.error('Error releasing processing lock:', error);
            logError(`Error releasing processing lock: ${error.message}\nStack: ${error.stack}`);
            return false;
        }
    }

    // Atomic challenge cleanup with distributed locking
    async atomicChallengeCleanup(challengerRank, targetRank, challengerDiscordId, targetDiscordId) {
        const challengeKey = `${challengerRank}:${targetRank}`;
        const lock = await this.acquireProcessingLock(challengeKey);
        
        if (!lock.acquired) {
            return { 
                success: false, 
                error: 'Could not acquire processing lock - operation may already be in progress',
                alreadyProcessing: true 
            };
        }

        try {
            // Collect all operations to perform
            const operations = [];
            const errors = [];

            // 1. Remove challenge
            try {
                await this.removeChallenge(challengerRank, targetRank);
                console.log(`✓ Removed challenge ${challengerRank} vs ${targetRank}`);
            } catch (error) {
                errors.push(`Failed to remove challenge: ${error.message}`);
            }

            // 2. Remove challenger lock
            if (challengerDiscordId) {
                try {
                    await this.removePlayerLock(challengerDiscordId);
                    console.log(`✓ Removed challenger lock for ${challengerDiscordId}`);
                } catch (error) {
                    errors.push(`Failed to remove challenger lock: ${error.message}`);
                }
            }

            // 3. Remove target lock
            if (targetDiscordId) {
                try {
                    await this.removePlayerLock(targetDiscordId);
                    console.log(`✓ Removed target lock for ${targetDiscordId}`);
                } catch (error) {
                    errors.push(`Failed to remove target lock: ${error.message}`);
                }
            }

            // Verify cleanup was successful
            const verification = await this.verifyCleanupComplete(challengerRank, targetRank, challengerDiscordId, targetDiscordId);
            
            const result = {
                success: errors.length === 0 && verification.isClean,
                errors: errors,
                verification: verification
            };

            if (result.success) {
                console.log(`✅ Atomic cleanup completed successfully for ${challengeKey}`);
            } else {
                console.warn(`⚠️ Atomic cleanup had issues for ${challengeKey}:`, errors);
            }

            return result;

        } finally {
            // Always release the lock
            await this.releaseProcessingLock(lock.lockKey, lock.lockValue);
        }
    }

    // Verify that cleanup was completed successfully
    async verifyCleanupComplete(challengerRank, targetRank, challengerDiscordId, targetDiscordId) {
        try {
            const results = {};
            
            // Check if challenge still exists
            const challengeKey = `${CHALLENGE_KEY_PREFIX}${challengerRank}:${targetRank}`;
            const warningKey = `${WARNING_KEY_PREFIX}${challengerRank}:${targetRank}`;
            
            results.challengeExists = await this.client.exists(challengeKey) === 1;
            results.warningExists = await this.client.exists(warningKey) === 1;
            
            // Check if player locks still exist
            if (challengerDiscordId) {
                const challengerLock = await this.checkPlayerLock(challengerDiscordId);
                results.challengerLocked = challengerLock.isLocked;
            } else {
                results.challengerLocked = false;
            }
            
            if (targetDiscordId) {
                const targetLock = await this.checkPlayerLock(targetDiscordId);
                results.targetLocked = targetLock.isLocked;
            } else {
                results.targetLocked = false;
            }
            
            // Determine if cleanup is complete
            results.isClean = !results.challengeExists && 
                             !results.warningExists && 
                             !results.challengerLocked && 
                             !results.targetLocked;
            
            if (!results.isClean) {
                console.warn(`Cleanup verification failed for ${challengerRank} vs ${targetRank}:`, results);
            }
            
            return results;
            
        } catch (error) {
            console.error('Error verifying cleanup:', error);
            logError(`Error verifying cleanup: ${error.message}\nStack: ${error.stack}`);
            return {
                isClean: false,
                error: error.message,
                challengeExists: true, // Assume dirty state on error
                warningExists: true,
                challengerLocked: true,
                targetLocked: true
            };
        }
    }

    // Retry wrapper for critical operations
    async withRetry(operation, maxRetries = 3, backoffMs = 1000) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await operation();
                return { success: true, result, attempt };
            } catch (error) {
                console.warn(`Operation failed on attempt ${attempt}/${maxRetries}:`, error.message);
                
                if (attempt === maxRetries) {
                    return { success: false, error, attempt };
                }
                
                // Exponential backoff
                const delay = backoffMs * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // Clear all cooldowns (utility method for admin operations)
    async clearAllCooldowns() {
        try {
            const cooldownKeys = await this.client.keys(`${COOLDOWN_KEY_PREFIX}*`);
            if (cooldownKeys.length > 0) {
                await this.client.del(...cooldownKeys);
                console.log(`Cleared ${cooldownKeys.length} cooldown entries`);
                return { success: true, count: cooldownKeys.length };
            }
            console.log('No cooldowns to clear');
            return { success: true, count: 0 };
        } catch (error) {
            console.error('Error clearing all cooldowns:', error);
            logError(`Error clearing all cooldowns: ${error.message}\nStack: ${error.stack}`);
            return { success: false, error: error.message, count: 0 };
        }
    }
}

module.exports = new RedisClient();