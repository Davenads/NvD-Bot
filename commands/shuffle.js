const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis')
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
const SHEET_NAME = 'NvD Ladder';
const sheetId = 0; // Numeric sheetId for 'NvD Ladder' tab

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-shuffle')
        .setDescription('Randomly shuffle player positions on the NvD ladder (Admin only)'),

    async execute(interaction) {
        const timestamp = new Date().toISOString();
        console.log(`\n[${timestamp}] Shuffle Ladder Command`);
        console.log(`├─ Invoked by: ${interaction.user.tag} (${interaction.user.id})`);

        await interaction.deferReply({ ephemeral: true });

        // Check if the user has the '@NvD Admin' role
        if (!interaction.member.roles.cache.some(role => role.name === 'NvD Admin')) {
            console.log('└─ Error: User lacks permission');
            return interaction.editReply({
                content: 'You do not have permission to use this command. Only users with the @NvD Admin role can use it.',
                ephemeral: true
            });
        }

        try {
            // Fetch data from the Google Sheet (excluding header row)
            console.log('├─ Fetching ladder data...');
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A2:H` // Get all relevant columns from row 2 onwards
            });

            let rows = result.data.values;
            if (!rows || rows.length === 0) {
                console.log('└─ Error: No data found in ladder');
                return interaction.editReply({
                    content: 'No data available on the leaderboard.',
                    ephemeral: true
                });
            }

            // Filter out empty rows
            rows = rows.filter(row => row[0] && row[1]);
            console.log(`├─ Found ${rows.length} active players on the ladder`);

            // Shuffle the rows (Fisher-Yates algorithm)
            console.log('├─ Shuffling ladder positions...');
            for (let i = rows.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [rows[i], rows[j]] = [rows[j], rows[i]];
            }

            // Update rank numbers in each row
            rows.forEach((row, index) => {
                row[0] = (index + 1).toString(); // Update the rank (column A)
            });

            // Prepare updates for any active challenges
            console.log('├─ Adjusting active challenges...');
            let challengeUpdates = [];
            
            rows.forEach((row, index) => {
                if (row[2] === 'Challenge' && row[4]) { // If Status is "Challenge" and Opp# exists
                    const oldOpponentRank = row[4];
                    
                    // Find the new rank of the opponent
                    const opponent = rows.find(r => {
                        // Check if this was the opponent's original rank
                        const originalRank = r[0]; // Current rank after shuffle
                        const originalRowIndex = result.data.values.findIndex(
                            origRow => origRow[1] === r[1] // Match by Discord username
                        );
                        
                        // Return true if this player's original rank matches the Opp# reference
                        return originalRowIndex !== -1 && 
                               result.data.values[originalRowIndex][0] === oldOpponentRank;
                    });
                    
                    if (opponent) {
                        // Update the Opp# reference to the new rank
                        row[4] = opponent[0];
                        
                        // Add to challenge updates for response
                        challengeUpdates.push({
                            player: row[1], // Discord username
                            oldRank: (index + 2 - 1).toString(), // Row index to rank (1-based) - 2 for header row, -1 to convert to 0-based
                            newRank: (index + 1).toString(), // New rank
                            opponent: opponent[1], // Opponent Discord username
                            oldOppRank: oldOpponentRank,
                            newOppRank: opponent[0]
                        });
                    }
                }
            });

            // Update the Google Sheet with the shuffled data
            console.log('├─ Updating sheet with shuffled data...');
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A2:H${rows.length + 1}`,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: rows
                }
            });

            // Create embed response
            const embed = new EmbedBuilder()
                .setColor('#8A2BE2') // NvD theme color
                .setTitle('🎲 Ladder Shuffle Completed! 🎲')
                .setDescription(`The NvD ladder has been randomly shuffled! All player positions have been reorganized.`)
                .setFooter({ 
                    text: `Shuffle requested by ${interaction.user.username}`,
                    iconURL: interaction.client.user.displayAvatarURL()
                })
                .setTimestamp();

            // Add information about active challenges if any were affected
            if (challengeUpdates.length > 0) {
                embed.addFields({
                    name: '⚠️ Active Challenges Updated',
                    value: challengeUpdates.map(update => 
                        `**${update.player}** (Rank ${update.oldRank} → ${update.newRank}) vs ` +
                        `**${update.opponent}** (Rank ${update.oldOppRank} → ${update.newOppRank})`
                    ).join('\n')
                });
            }

            // Send embed response to the channel
            await interaction.channel.send({ embeds: [embed] });

            // Confirm to command invoker
            console.log('└─ Shuffle completed successfully');
            return interaction.editReply({
                content: `Successfully shuffled the ladder! ${rows.length} player positions have been randomized.`,
                ephemeral: true
            });

        } catch (error) {
            console.error(`└─ Error shuffling ladder:`, error);
            logError(`Shuffle command error: ${error.message}\nStack: ${error.stack}`);
            return interaction.editReply({
                content: 'An error occurred while shuffling the ladder. Please try again later.',
                ephemeral: true
            });
        }
    }
};