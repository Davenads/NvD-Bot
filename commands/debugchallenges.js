require('dotenv').config();
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { google } = require('googleapis');

const sheets = google.sheets({
    version: 'v4',
    auth: new google.auth.JWT(
        process.env.GOOGLE_CLIENT_EMAIL,
        null,
        process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        ['https://www.googleapis.com/auth/spreadsheets']
    )
});

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-debugchallenges')
        .setDescription('Debug challenge data inconsistencies (Admin only)'),

    async execute(interaction) {
        // Admin check
        const isAdmin = interaction.member.roles.cache.some(role => role.name === 'NvD Admin');
        if (!isAdmin) {
            return await interaction.reply({
                content: 'You do not have the required @NvD Admin role to use this command.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            // Fetch ladder data
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: 'NvD Ladder!A2:H'
            });

            const rows = result.data.values || [];
            
            // Find all challenge players
            const challengePlayers = rows.filter(row => 
                row[0] && row[2] === 'Challenge' && row[4]
            );

            const issues = [];
            const validPairs = [];
            const dateIssues = [];

            // Check for mismatches and date issues
            challengePlayers.forEach(player => {
                const rank = player[0];
                const name = player[1];
                const challengeDate = player[3]; // Column D (index 3)
                const opponentRank = player[4];
                
                // Check challenge date
                if (!challengeDate || challengeDate.trim() === '') {
                    dateIssues.push({
                        type: 'missing_date',
                        rank: rank,
                        name: name,
                        issue: 'No challenge date'
                    });
                } else {
                    // Try to parse the date to check if it's valid
                    const moment = require('moment-timezone');
                    const dateFormat = 'M/D, h:mm A';
                    const cleanDateStr = challengeDate.replace(/\s+(EST|EDT)$/i, '').trim();
                    const parsed = moment.tz(cleanDateStr, dateFormat, 'America/New_York');
                    
                    if (!parsed.isValid()) {
                        dateIssues.push({
                            type: 'invalid_date',
                            rank: rank,
                            name: name,
                            challengeDate: challengeDate,
                            issue: `Invalid date format: "${challengeDate}"`
                        });
                    } else {
                        // Check if challenge is old (>3 days)
                        const now = moment().tz('America/New_York');
                        const currentYear = now.year();
                        
                        // Handle year assignment
                        if (parsed.month() > now.month() || 
                            (parsed.month() === now.month() && parsed.date() > now.date())) {
                            parsed.year(currentYear - 1);
                        } else {
                            parsed.year(currentYear);
                        }
                        
                        const daysDiff = now.diff(parsed, 'days', true);
                        
                        if (daysDiff > 3) {
                            dateIssues.push({
                                type: 'expired',
                                rank: rank,
                                name: name,
                                challengeDate: challengeDate,
                                daysDiff: daysDiff.toFixed(1),
                                issue: `Challenge is ${daysDiff.toFixed(1)} days old (should auto-null after 3 days)`
                            });
                        }
                    }
                }
                
                // Find the opponent
                const opponent = challengePlayers.find(p => p[0] === opponentRank);
                
                if (!opponent) {
                    issues.push({
                        type: 'missing_opponent',
                        rank: rank,
                        name: name,
                        opponentRank: opponentRank,
                        issue: `Opponent Rank ${opponentRank} not found or not in challenge`
                    });
                } else if (opponent[4] !== rank) {
                    issues.push({
                        type: 'mismatch',
                        rank: rank,
                        name: name,
                        opponentRank: opponentRank,
                        opponentName: opponent[1],
                        opponentOpponent: opponent[4],
                        issue: `${name} says opponent is ${opponentRank}, but ${opponent[1]} says opponent is ${opponent[4]}`
                    });
                } else {
                    // Valid pair - include date info
                    const pairKey = [rank, opponentRank].sort().join('-');
                    if (!validPairs.some(p => p.key === pairKey)) {
                        validPairs.push({
                            key: pairKey,
                            player1: { rank: rank, name: name, date: challengeDate },
                            player2: { rank: opponentRank, name: opponent[1], date: opponent[3] }
                        });
                    }
                }
            });

            // Create embed
            const embed = new EmbedBuilder()
                .setColor(issues.length > 0 ? '#FF6600' : '#00FF00')
                .setTitle('🔍 Challenge Data Debug Report')
                .setDescription(`Found ${challengePlayers.length} players in challenge status`)
                .addFields(
                    {
                        name: '✅ Valid Challenge Pairs',
                        value: validPairs.length > 0 
                            ? validPairs.map(p => {
                                const dateMatch = p.player1.date === p.player2.date ? '✅' : '⚠️';
                                return `${dateMatch} Rank ${p.player1.rank} (${p.player1.name}) ↔ Rank ${p.player2.rank} (${p.player2.name}) • ${p.player1.date}`;
                            }).join('\n')
                            : 'None',
                        inline: false
                    }
                )
                .setTimestamp();

            if (issues.length > 0) {
                embed.addFields({
                    name: '❌ Issues Found',
                    value: issues.map(issue => {
                        if (issue.type === 'missing_opponent') {
                            return `• **Rank ${issue.rank} (${issue.name})**: ${issue.issue}`;
                        } else {
                            return `• **Rank ${issue.rank} (${issue.name})** vs **Rank ${issue.opponentRank} (${issue.opponentName})**: Bidirectional mismatch (${issue.opponentName} points to Rank ${issue.opponentOpponent})`;
                        }
                    }).join('\n'),
                    inline: false
                });

                embed.addFields({
                    name: '🛠️ How to Fix',
                    value: '1. Check the Google Sheet opponent columns\n2. Use `/nvd-cancelchallenge` to clear broken challenges\n3. Have players re-issue challenges correctly',
                    inline: false
                });
            }

            if (dateIssues.length > 0) {
                embed.addFields({
                    name: '📅 Date Issues',
                    value: dateIssues.map(issue => {
                        if (issue.type === 'missing_date') {
                            return `• **Rank ${issue.rank} (${issue.name})**: ${issue.issue}`;
                        } else if (issue.type === 'invalid_date') {
                            return `• **Rank ${issue.rank} (${issue.name})**: ${issue.issue}`;
                        } else if (issue.type === 'expired') {
                            return `• **Rank ${issue.rank} (${issue.name})**: ${issue.issue}`;
                        }
                        return `• **Rank ${issue.rank} (${issue.name})**: ${issue.issue}`;
                    }).join('\n'),
                    inline: false
                });

                if (dateIssues.some(d => d.type === 'expired')) {
                    embed.addFields({
                        name: '⚠️ Auto-Null Check',
                        value: 'Expired challenges should be auto-nullified by Redis. Check if auto-null system is working properly.',
                        inline: false
                    });
                }
            }

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('Debug challenges error:', error);
            await interaction.editReply({
                content: `Error debugging challenges: ${error.message}`
            });
        }
    }
};