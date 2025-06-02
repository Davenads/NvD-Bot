#!/usr/bin/env node
// Migration script to sync existing Google Sheets challenges to Redis
require('dotenv').config();
const { google } = require('googleapis');
const redisClient = require('./redis-client');

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

async function migrateExistingChallenges() {
    try {
        console.log('🔄 Starting migration of existing challenges...');
        
        // Fetch current ladder data
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:H`
        });
        
        const rows = result.data.values || [];
        console.log(`📊 Found ${rows.length} total rows in spreadsheet`);
        
        // Find all active challenges
        const activePartners = new Map(); // rank -> opponent rank
        const challengePlayers = [];
        
        rows.forEach(row => {
            const rank = row[0];
            const discordName = row[1];
            const status = row[2];
            const challengeDate = row[3];
            const opponentRank = row[4];
            const discordId = row[5];
            
            if (status === 'Challenge' && opponentRank && discordId) {
                activePartners.set(rank, opponentRank);
                challengePlayers.push({
                    rank,
                    discordName,
                    discordId,
                    opponentRank,
                    challengeDate
                });
            }
        });
        
        console.log(`⚔️ Found ${challengePlayers.length} players in active challenges`);
        
        // Group into challenge pairs and create Redis entries
        const processedPairs = new Set();
        let migratedCount = 0;
        
        for (const player of challengePlayers) {
            const pairKey = [player.rank, player.opponentRank].sort().join('-');
            
            if (processedPairs.has(pairKey)) {
                continue; // Skip if we already processed this pair
            }
            
            // Find the opponent
            const opponent = challengePlayers.find(p => p.rank === player.opponentRank);
            
            if (!opponent) {
                console.log(`⚠️ WARNING: Could not find opponent for rank ${player.rank} vs ${player.opponentRank}`);
                continue;
            }
            
            // Verify bidirectional challenge
            if (opponent.opponentRank !== player.rank) {
                console.log(`⚠️ WARNING: Challenge mismatch for ranks ${player.rank} and ${opponent.rank}`);
                continue;
            }
            
            processedPairs.add(pairKey);
            
            // Create challenge in Redis
            const challenger = {
                discordId: player.discordId,
                discordName: player.discordName,
                rank: player.rank
            };
            
            const target = {
                discordId: opponent.discordId,
                discordName: opponent.discordName,
                rank: opponent.rank
            };
            
            console.log(`🔗 Migrating challenge: Rank ${player.rank} (${player.discordName}) vs Rank ${opponent.rank} (${opponent.discordName})`);
            
            // Set challenge in Redis
            await redisClient.setChallenge(challenger, target, null);
            
            // Set player locks
            const challengeKey = `nvd:challenge:${player.rank}:${opponent.rank}`;
            await redisClient.setPlayerLock(player.discordId, challengeKey);
            await redisClient.setPlayerLock(opponent.discordId, challengeKey);
            
            migratedCount++;
        }
        
        console.log(`✅ Migration completed successfully!`);
        console.log(`📈 Statistics:`);
        console.log(`   - Total active challenge pairs: ${migratedCount}`);
        console.log(`   - Player locks created: ${migratedCount * 2}`);
        console.log(`   - Redis challenge entries: ${migratedCount}`);
        
        // Verify migration
        const allLocks = await redisClient.listAllPlayerLocks();
        const allChallenges = await redisClient.listAllChallenges();
        
        console.log(`🔍 Verification:`);
        console.log(`   - Active player locks in Redis: ${allLocks.length}`);
        console.log(`   - Active challenges in Redis: ${allChallenges.length}`);
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

// Run migration
migrateExistingChallenges();