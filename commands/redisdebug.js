const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const redisClient = require('../redis-client');
const moment = require('moment-timezone');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-redisdebug')
    .setDescription('Debug command to check stored Redis challenges and warnings'),
  
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
      // Get all challenges
      const challenges = await redisClient.listAllChallenges();
      
      const embed = new EmbedBuilder()
        .setTitle('Redis Challenge Status Debug')
        .setColor('#8A2BE2')
        .setDescription(`**${challenges.length}** active challenges tracked in Redis`)
        .setTimestamp();
      
      if (challenges.length > 0) {
        let challengesList = '';
        
        challenges.forEach(challenge => {
          const expiresIn = moment.duration(challenge.remainingTime, 'seconds').humanize();
          
          challengesList += `Rank #${challenge.challenger.rank} **${challenge.challenger.name}** vs ` +
                           `Rank #${challenge.target.rank} **${challenge.target.name}**\n` +
                           `Expires in: ${expiresIn}\n\n`;
        });
        
        if (challengesList.length <= 1024) {
          embed.addFields({ name: 'Active Challenges', value: challengesList });
        } else {
          // Split into multiple fields if too long
          const chunks = challengesList.match(/.{1,1024}/g) || [];
          chunks.forEach((chunk, index) => {
            embed.addFields({
              name: index === 0 ? 'Active Challenges' : '⠀', // Empty character for subsequent fields
              value: chunk
            });
          });
        }
      } else {
        embed.addFields({ name: 'Active Challenges', value: 'No active challenges found in Redis' });
      }
      
      // Add footer with info about expiry times
      embed.setFooter({
        text: 'Challenges expire after 3 days, warnings sent at 24 hours remaining',
        iconURL: interaction.client.user.displayAvatarURL()
      });
      
      await interaction.editReply({ embeds: [embed] });
      
    } catch (error) {
      console.error('Error executing redisdebug command:', error);
      await interaction.editReply({
        content: 'An error occurred while fetching Redis challenge data. Check logs for details.'
      });
    }
  }
};