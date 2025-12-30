// redis-client.js
const Redis = require('ioredis');
const { logError } = require('./logger');
const { google } = require('googleapis');
const { EmbedBuilder } = require('discord.js');
const { EventEmitter } = require('events');

// Constants for Redis keys - keep nvd: prefix for namespace separation but simplify structure
const CHALLENGE_KEY_PREFIX = 'nvd:challenge:';
const WARNING_KEY_PREFIX = 'nvd:challenge-warning:';
const COOLDOWN_KEY_PREFIX = 'nvd:cooldown:';
const CHALLENGE_EXPIRY_TIME = 60 * 60 * 24 * 3; // 3 days in seconds
const WARNING_EXPIRY_TIME = 60 * 60 * 24 * 2; // 2 days in seconds (warning at 24 hours left)
const NOTIFICATION_CHANNEL_ID = '1144011555378298910'; // NvD challenges channel

class RedisClient extends EventEmitter {
    // Helper method to determine Redis configuration based on environment
    getRedisConfig() {
        // Check if running on Heroku with RedisCloud
        if (process.env.REDISCLOUD_URL) {
            // Parse the RedisCloud URL
            const redisUrl = new URL(process.env.REDISCLOUD_URL);
            return {
                host: redisUrl.hostname,
                port: parseInt(redisUrl.port),
                password: redisUrl.password ? redisUrl.password : null,
                tls: redisUrl.protocol === 'rediss:' ? {} : null,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            };
        } else {
            // Local or custom Redis configuration
            return {
                host: process.env.REDIS_HOST || 'localhost',
                port: process.env.REDIS_PORT || 6379,
                password: process.env.REDIS_PASSWORD,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            };
        }
    }

    constructor() {
        super();

        // Skip Redis connection if SKIP_REDIS flag is set (e.g., during command deployment)
        if (process.env.SKIP_REDIS === 'true') {
            console.log('Skipping Redis connection (SKIP_REDIS=true)');
            this.client = null;
            this.subClient = null;
            return;
        }

        // Configure Redis clients based on environment
        const redisConfig = this.getRedisConfig();

        // Main client for regular operations
        this.client = new Redis(redisConfig);

        // Separate subscription client for keyspace notifications
        // Disable ready check since this client will be in subscriber mode
        const subConfig = { ...redisConfig, enableReadyCheck: false };
        this.subClient = new Redis(subConfig);

        this.client.on('error', (err) => {
            console.error('Redis Client Error:', err);
            logError('Redis Client Error', err);
        });

        this.client.on('connect', () => {
            console.log('Redis Client Connected');
            // Configure Redis to enable keyspace events for expired keys
            this.client.config('SET', 'notify-keyspace-events', 'Ex');
        });
        
        this.subClient.on('error', (err) => {
            console.error('Redis Subscription Client Error:', err);
            logError('Redis Subscription Client Error', err);
        });

        this.subClient.on('connect', () => {
            console.log('Redis Subscription Client Connected');
            // Subscribe to expiration events
            this.subClient.subscribe('__keyevent@0__:expired');
        });
        
        // Handle expiration events
        this.subClient.on('message', (channel, message) => {
            console.log(`Received message from channel ${channel}: ${message}`);
            
            // Handle challenge expirations
            if (channel === '__keyevent@0__:expired') {
                if (message.startsWith(CHALLENGE_KEY_PREFIX)) {
                    console.log(`Challenge key expired: ${message}`);
                    this.emit('challengeExpired', message);
                    // Add small delay to ensure the key has fully expired
                    setTimeout(async () => {
                        await this.handleChallengeExpiry(message);
                    }, 100);
                } else if (message.startsWith(WARNING_KEY_PREFIX)) {
                    console.log(`Challenge warning key expired: ${message}`);
                    this.emit('challengeWarning', message.replace(WARNING_KEY_PREFIX, CHALLENGE_KEY_PREFIX));
                    // Add small delay to ensure the key has fully expired
                    setTimeout(async () => {
                        await this.handleWarningExpiry(message);
                    }, 100);
                }
            }
        });
    }
    
    // Key format: `nvd:challenge:${discordId1}-${discordId2}` (sorted order by Discord ID)
    generateChallengeKey(player1DiscordId, player2DiscordId) {
        const pair = [String(player1DiscordId), String(player2DiscordId)].sort();
        const key = `${CHALLENGE_KEY_PREFIX}${pair[0]}-${pair[1]}`;
        console.log(`Generated challenge key: ${key} (Discord IDs: ${player1DiscordId} vs ${player2DiscordId})`);
        return key;
    }

    // Calculate TTL based on challenge date from Google Sheets
    // Format: "6/25, 12:42 AM EDT" -> TTL in seconds until 3 days from that date
    calculateTTLFromChallengeDate(challengeDateStr) {
        try {
            // Parse the challenge date string
            // Format examples: "6/25, 12:42 AM EDT", "12/1, 3:15 PM EST"
            const currentYear = new Date().getFullYear();
            
            // Remove timezone and parse
            const dateStr = challengeDateStr.replace(/ (EDT|EST|PST|PDT|CST|CDT|MST|MDT)$/, '');
            const challengeDate = new Date(`${dateStr}, ${currentYear}`);
            
            // If the parsed date is invalid, fall back to current time
            if (isNaN(challengeDate.getTime())) {
                console.log(`Warning: Could not parse challenge date "${challengeDateStr}", using current time`);
                return 3 * 24 * 60 * 60; // 3 days from now
            }
            
            // Calculate expiration: challenge date + 3 days
            const expirationDate = new Date(challengeDate.getTime() + (3 * 24 * 60 * 60 * 1000));
            
            // Calculate TTL: seconds from now until expiration
            const ttlMs = expirationDate.getTime() - Date.now();
            const ttlSeconds = Math.max(300, Math.floor(ttlMs / 1000)); // Minimum 5 minutes
            
            console.log(`Challenge date: ${challengeDate.toISOString()}, expires: ${expirationDate.toISOString()}, TTL: ${ttlSeconds}s`);
            return ttlSeconds;
            
        } catch (error) {
            console.error(`Error parsing challenge date "${challengeDateStr}":`, error);
            return 3 * 24 * 60 * 60; // Fallback to 3 days
        }
    }

    // Store challenge in Redis - uses Discord IDs for stable keys
    async setChallenge(player1, player2, challengeDate, customTTL = null) {
        const key = this.generateChallengeKey(player1.discordId, player2.discordId);
        
        let expiryTime;
        if (customTTL) {
            expiryTime = customTTL;
        } else if (challengeDate) {
            // Parse challenge date and calculate TTL based on 3-day expiration from that date
            expiryTime = this.calculateTTLFromChallengeDate(challengeDate);
        } else {
            // Fallback to default 3 days
            expiryTime = 3 * 24 * 60 * 60;
        }
        // Warning time: 24 hours before expiration, but minimum 300 seconds (5 minutes)
        const warningTime = Math.max(300, expiryTime - (24 * 60 * 60));
        
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
            console.error('Error setting challenge');
            logError('Error setting challenge', error);
            return false;
        }
    }
    
    // Update existing challenge with new date and reset TTL (used for extending challenges)
    async updateChallenge(player1DiscordId, player2DiscordId, newChallengeDate) {
        const key = this.generateChallengeKey(player1DiscordId, player2DiscordId);
        // Reset to 3 days from now
        const expiryTime = 3 * 24 * 60 * 60;
        // Warning time: 24 hours before expiration, but minimum 300 seconds (5 minutes)
        const warningTime = Math.max(300, expiryTime - (24 * 60 * 60));
        
        try {
            const challengeDataStr = await this.client.get(key);
            
            if (!challengeDataStr) {
                console.error(`Challenge not found for ${key}`);
                return false;
            }
            
            const challengeData = JSON.parse(challengeDataStr);
            
            // Update challenge date and reset expiration
            challengeData.challengeDate = newChallengeDate;
            challengeData.startTime = Date.now();
            challengeData.expiryTime = Date.now() + (expiryTime * 1000);
            
            // Remove old warning key if it exists
            const oldWarningKey = `${WARNING_KEY_PREFIX}${key.substring(13)}`;
            await this.client.del(oldWarningKey);
            
            // Set main challenge with updated data
            await this.client.setex(key, expiryTime, JSON.stringify(challengeData));
            console.log(`Updated challenge for ${key} with new expiry ${expiryTime}s`);
            
            // Set a new warning key
            const warningKey = `${WARNING_KEY_PREFIX}${key.substring(13)}`;
            await this.client.setex(warningKey, warningTime, key);
            console.log(`Reset warning for ${warningKey} with expiry ${warningTime}s`);
            
            return true;
        } catch (error) {
            console.error('Error updating challenge');
            logError('Error updating challenge', error);
            return false;
        }
    }
    
    // Remove challenge from Redis (used when a challenge is completed or manually cancelled)
    async removeChallenge(player1DiscordId, player2DiscordId) {
        const key = this.generateChallengeKey(player1DiscordId, player2DiscordId);
        const warningKey = `${WARNING_KEY_PREFIX}${key.substring(13)}`; // Remove 'nvd:challenge:' prefix

        try {
            console.log(`Attempting to remove challenge keys for Discord IDs ${player1DiscordId} vs ${player2DiscordId}`);
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
            console.error('❌ Error removing challenge');
            logError('Error removing challenge', error);
            return false;
        }
    }
    
    // Handle warning expiry (send notification message)
    async handleWarningExpiry(key) {
        try {
            console.log(`Processing warning expiry for key: ${key}`);

            // Extract Discord IDs from the key (format: nvd:challenge-warning:discordId1-discordId2)
            const keyParts = key.replace(WARNING_KEY_PREFIX, '').split('-');
            if (keyParts.length !== 2) {
                console.log(`Skipping malformed warning key: ${key}`);
                return;
            }

            const discordId1 = keyParts[0];
            const discordId2 = keyParts[1];

            // Log the warning expiry
            console.log(`Challenge warning triggered for Discord IDs ${discordId1} vs ${discordId2}`);

            // Get discord client (needs to be passed in from index.js)
            const discordClient = global.discordClient;
            if (!discordClient) {
                console.error('Discord client not available for sending warning');
                return;
            }

            // Get the challenge data from the main challenge key
            const challengeKey = this.generateChallengeKey(discordId1, discordId2);
            const challengeData = await this.client.get(challengeKey);

            if (!challengeData) {
                console.log(`Challenge no longer exists for Discord IDs ${discordId1} vs ${discordId2}, skipping warning`);
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

            console.log(`Sending warning for active challenge: ${challenge.player1.name} vs ${challenge.player2.name} (TTL: ${challengeTTL}s)`);

            // Check if warning already sent using lock mechanism
            const canSendWarning = await this.markChallengeWarningAsSent(discordId1, discordId2);
            if (!canSendWarning) {
                console.log('Skipping warning - already sent recently');
                return;
            }
            
            // Send warning message (direct mention, not embed)
            await channel.send(
                `⚠️ **Challenge Expiry Warning** ⚠️\n` +
                `<@${challenge.player1.discordId}> and <@${challenge.player2.discordId}>, your challenge will automatically expire in 24 hours! ` +
                `Please complete your match or use \`/nvd-extendchallenge\` if you need more time.`
            );
            
            console.log('Challenge expiry warning sent successfully');
            
        } catch (error) {
            console.error('Error handling warning expiry');
            logError('Error handling warning expiry', error);
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
            
            // Extract Discord IDs from the key (format: nvd:challenge:discordId1-discordId2)
            const keyParts = key.replace(CHALLENGE_KEY_PREFIX, '').split('-');
            if (keyParts.length !== 2) {
                console.log(`Skipping malformed challenge key: ${key}`);
                return;
            }

            const discordId1 = keyParts[0];
            const discordId2 = keyParts[1];

            try {
                console.log(`🔒 Auto-nulling expired challenge for Discord IDs: ${discordId1} vs ${discordId2}`);
                
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
                
                // Find the rows with matching Discord IDs (column F, index 5)
                challengerRowIndex = rows.findIndex(row => row[5] === discordId1);
                targetRowIndex = rows.findIndex(row => row[5] === discordId2);
                
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

                // Simple cleanup - use Discord IDs from challenge data
                await this.removeChallenge(challenge.player1.discordId, challenge.player2.discordId);
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
            } catch (error) {
                console.error('Error during challenge auto-null process');
                logError('Error during challenge auto-null process', error);
            }
            
        } catch (error) {
            console.error('Error handling challenge expiry');
            logError('Error handling challenge expiry', error);
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
            console.error('Error setting cooldown');
            logError('Error setting cooldown', error);
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
            console.error(`Error checking cooldown`);
            logError('Error checking cooldown', error);
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
            console.error('Error removing cooldown');
            logError('Error removing cooldown', error);
            return false;
        }
    }

    // Check if a challenge exists between two players - uses Discord IDs
    async checkChallenge(player1DiscordId, player2DiscordId) {
        const key = this.generateChallengeKey(player1DiscordId, player2DiscordId);
        
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
            console.error('Error checking challenge');
            logError('Error checking challenge', error);
            return {
                active: false,
                remainingTime: 0,
                details: null,
                error: true
            };
        }
    }

    // Create or check a warning lock to prevent duplicate notifications
    async markChallengeWarningAsSent(player1DiscordId, player2DiscordId) {
        const key = this.generateChallengeKey(player1DiscordId, player2DiscordId);
        const warningLockKey = `nvd:warning-lock:${key.substring(13)}`;
        
        try {
            // Try to set the lock with NX option (only set if it doesn't exist)
            // This lock will expire after 60 seconds to prevent any potential deadlock
            const result = await this.client.set(warningLockKey, '1', 'EX', 60, 'NX');
            
            // If result is null, the key already exists (warning already sent)
            if (result === null) {
                console.log(`Warning already sent for challenge ${key} (lock exists)`);
                return false;
            }
            
            console.log(`Set warning lock for ${key}`);
            return true;
        } catch (error) {
            console.error('Error setting warning lock:', error);
            logError('Error setting warning lock', error);
            // If there's an error, allow the warning to be sent (fail open)
            return true;
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
            console.error('Error listing cooldowns');
            logError('Error listing cooldowns', error);
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
            console.error('Error listing challenges');
            logError('Error listing challenges', error);
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
            console.error('Error getting player cooldowns');
            logError('Error getting player cooldowns', error);
            return [];
        }
    }

    // Clean up Redis challenges involving a removed player (Discord ID-based)
    async updateChallengeKeysForRankShift(removedRank, removedDiscordId) {
        try {
            console.log(`├─ Cleaning up Redis challenges for removed player (rank: ${removedRank}, Discord ID: ${removedDiscordId})`);
            
            // Since keys use Discord IDs (not ranks), we only need to remove challenges involving the removed player
            // No rank shifting needed - Discord IDs are stable

            if (!removedDiscordId) {
                console.log(`├─ No Discord ID provided for removed player, skipping Redis cleanup`);
                return true;
            }

            // Get all current challenge keys
            const challengeKeys = await this.client.keys(`${CHALLENGE_KEY_PREFIX}*`);
            const warningKeys = await this.client.keys(`${WARNING_KEY_PREFIX}*`);

            const keysToDelete = [];
            let deletedCount = 0;

            // Find challenges involving the removed player
            for (const key of challengeKeys) {
                try {
                    const keyParts = key.replace(CHALLENGE_KEY_PREFIX, '').split('-');
                    if (keyParts.length !== 2) continue;

                    const discordId1 = keyParts[0];
                    const discordId2 = keyParts[1];

                    // Delete if challenge involves removed player
                    if (discordId1 === removedDiscordId || discordId2 === removedDiscordId) {
                        keysToDelete.push(key);
                        deletedCount++;
                        console.log(`├─ Marking challenge for deletion: ${key}`);
                    }
                } catch (error) {
                    console.error(`├─ Error processing challenge key ${key}:`, error);
                }
            }

            // Find warning keys involving the removed player
            for (const warningKey of warningKeys) {
                try {
                    const keyParts = warningKey.replace(WARNING_KEY_PREFIX, '').split('-');
                    if (keyParts.length !== 2) continue;

                    const discordId1 = keyParts[0];
                    const discordId2 = keyParts[1];

                    if (discordId1 === removedDiscordId || discordId2 === removedDiscordId) {
                        keysToDelete.push(warningKey);
                        console.log(`├─ Marking warning for deletion: ${warningKey}`);
                    }
                } catch (error) {
                    console.error(`├─ Error processing warning key ${warningKey}:`, error);
                }
            }

            // Delete all marked keys
            if (keysToDelete.length > 0) {
                for (const key of keysToDelete) {
                    await this.client.del(key);
                }
                console.log(`├─ Deleted ${keysToDelete.length} Redis keys (${deletedCount} challenges)`);
            } else {
                console.log(`├─ No challenges found for removed player`);
            }

            console.log(`├─ Redis cleanup completed for removed player`);
            return true;
            
        } catch (error) {
            console.error(`├─ Error updating Redis keys for rank shift:`, error);
            logError('Error updating Redis keys for rank shift', error);
            return false;
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