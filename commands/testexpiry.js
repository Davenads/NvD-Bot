const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const redisClient = require('../redis-client');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-testexpiry')
    .setDescription('Admin command to test Redis challenge expiry functionality')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of expiry to test')
        .setRequired(true)
        .addChoices(
          { name: 'Warning (24-hour notice)', value: 'warning' },
          { name: 'Auto-Null (challenge expired)', value: 'expiry' }
        ))
    .addIntegerOption(option =>
      option.setName('challenge_rank')
        .setDescription('Rank of the challenger')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('target_rank')
        .setDescription('Rank of the target player')
        .setRequired(true)),
  
  async execute(interaction) {
    // Check if the user has the '@NvD Admin' role
    const adminRole = interaction.guild.roles.cache.find(role => role.name === 'NvD Admin');
    if (!adminRole || !interaction.member.roles.cache.has(adminRole.id)) {
      return await interaction.reply({
        content: 'You do not have the required @NvD Admin role to use this command.',
        flags: MessageFlags.Ephemeral
      });
    }
    
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    try {
      const type = interaction.options.getString('type');
      const challengerRank = interaction.options.getInteger('challenge_rank');
      const targetRank = interaction.options.getInteger('target_rank');
      
      if (type === 'warning') {
        // Create a warning key with 1-second expiry for testing
        const warningKey = `nvd:challenge:warning:${challengerRank}:${targetRank}`;
        
        // Create challenge data
        const challengeData = JSON.stringify({
          challenger: {
            discordId: interaction.user.id,
            name: interaction.user.username,
            rank: challengerRank
          },
          target: {
            discordId: interaction.user.id, // Using same ID for test
            name: 'Test Player',
            rank: targetRank
          },
          startTime: Date.now(),
          expiryTime: Date.now() + 86400000 // 24 hours in ms
        });
        
        // Set with 1-second expiry
        await redisClient.client.setex(warningKey, 1, challengeData);
        
        await interaction.editReply({
          content: `Warning expiry test triggered for ranks ${challengerRank} vs ${targetRank}. The warning should appear in the channel within a few seconds.`
        });
      } else if (type === 'expiry') {
        // Create a challenge key with 1-second expiry for testing
        const challengeKey = `nvd:challenge:${challengerRank}:${targetRank}`;
        
        // Create challenge data
        const challengeData = JSON.stringify({
          challenger: {
            discordId: interaction.user.id,
            name: interaction.user.username,
            rank: challengerRank
          },
          target: {
            discordId: interaction.user.id, // Using same ID for test
            name: 'Test Player', 
            rank: targetRank
          },
          startTime: Date.now() - 259200000, // 3 days ago in ms
          expiryTime: Date.now()
        });
        
        // Set with 1-second expiry
        await redisClient.client.setex(challengeKey, 1, challengeData);
        
        await interaction.editReply({
          content: `Challenge expiry test triggered for ranks ${challengerRank} vs ${targetRank}. The auto-null notification should appear in the channel within a few seconds.`
        });
      }
      
    } catch (error) {
      console.error('Error executing testexpiry command:', error);
      await interaction.editReply({
        content: 'An error occurred while testing expiry functionality. Check logs for details.'
      });
    }
  }
};