const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const redisClient = require('../redis-client');
const moment = require('moment-timezone');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nvd-redisdebug')
    .setDescription('Display all NvD Redis data (challenges, cooldowns, locks)'),
  
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
      // Get all NvD Redis data
      const challenges = await redisClient.getAllChallenges();
      const cooldowns = await redisClient.listAllCooldowns();
      
      // Also get all NvD keys directly to catch any other data
      const allNvdKeys = await redisClient.client.keys('nvd:*');
      
      // Filter keys by type
      const challengeKeys = allNvdKeys.filter(key => key.startsWith('nvd:challenge:') && !key.includes('warning'));
      const warningKeys = allNvdKeys.filter(key => key.startsWith('nvd:challenge:warning:'));
      const cooldownKeys = allNvdKeys.filter(key => key.startsWith('nvd:cooldown:'));
      const lockKeys = allNvdKeys.filter(key => key.startsWith('nvd:player:lock:'));
      const processingKeys = allNvdKeys.filter(key => key.startsWith('nvd:processing:lock:'));
      
      const embeds = [];
      
      // Main summary embed
      const summaryEmbed = new EmbedBuilder()
        .setTitle('🔍 NvD Redis Data Overview')
        .setColor('#8A2BE2')
        .setDescription('Complete overview of all NvD-related Redis data')
        .addFields(
          { name: '⚔️ **Active Challenges**', value: `${challenges.length}`, inline: true },
          { name: '⚠️ **Challenge Warnings**', value: `${warningKeys.length}`, inline: true },
          { name: '❄️ **Player Cooldowns**', value: `${cooldowns.length}`, inline: true },
          { name: '📊 **Total NvD Keys**', value: `${allNvdKeys.length}`, inline: true }
        )
        .setTimestamp()
        .setFooter({
          text: 'All times in UTC',
          iconURL: interaction.client.user.displayAvatarURL()
        });
      
      embeds.push(summaryEmbed);
      
      // Challenges embed
      if (challenges.length > 0) {
        let challengeText = '';
        for (const challenge of challenges) {
          const expiresIn = challenge.remainingTime > 0 
            ? moment.duration(challenge.remainingTime, 'seconds').humanize()
            : 'EXPIRED';
          
          const challengeInfo = `**${challenge.challenger.name}** (#${challenge.challenger.rank}) vs **${challenge.target.name}** (#${challenge.target.rank})\n` +
                               `⏱️ Expires: ${expiresIn}\n` +
                               `🔑 Key: \`${challenge.key}\`\n\n`;
          
          // Check if adding this challenge would exceed Discord's 4096 character limit
          if (challengeText.length + challengeInfo.length > 4000) {
            // Create embed with current text and start a new one
            const challengeEmbed = new EmbedBuilder()
              .setTitle('⚔️ Active Challenges')
              .setColor('#FF6B6B')
              .setDescription(challengeText.trim());
            embeds.push(challengeEmbed);
            challengeText = challengeInfo;
          } else {
            challengeText += challengeInfo;
          }
        }
        
        // Add remaining challenge text
        if (challengeText.trim()) {
          const challengeEmbed = new EmbedBuilder()
            .setTitle(embeds.length === 1 ? '⚔️ Active Challenges' : '⚔️ Active Challenges (cont.)')
            .setColor('#FF6B6B')
            .setDescription(challengeText.trim());
          embeds.push(challengeEmbed);
        }
      }
      
      // Cooldowns embed
      if (cooldowns.length > 0) {
        let cooldownText = '';
        for (const cooldown of cooldowns) {
          const expiresIn = cooldown.remainingTime > 0
            ? moment.duration(cooldown.remainingTime, 'seconds').humanize()
            : 'EXPIRED';
          
          const cooldownInfo = `**${cooldown.player1.name}** ↔️ **${cooldown.player2.name}**\n` +
                              `⏱️ Expires: ${expiresIn}\n\n`;
          
          // Check character limit
          if (cooldownText.length + cooldownInfo.length > 4000) {
            const cooldownEmbed = new EmbedBuilder()
              .setTitle('❄️ Player Cooldowns')
              .setColor('#4ECDC4')
              .setDescription(cooldownText.trim());
            embeds.push(cooldownEmbed);
            cooldownText = cooldownInfo;
          } else {
            cooldownText += cooldownInfo;
          }
        }
        
        if (cooldownText.trim()) {
          const cooldownEmbed = new EmbedBuilder()
            .setTitle(cooldowns.length > 10 ? '❄️ Player Cooldowns (cont.)' : '❄️ Player Cooldowns')
            .setColor('#4ECDC4')
            .setDescription(cooldownText.trim());
          embeds.push(cooldownEmbed);
        }
      }
      
      // Player locks embed
      if (playerLocks.length > 0) {
        let locksText = '';
        for (const lock of playerLocks) {
          const expiresIn = lock.remainingTime > 0
            ? moment.duration(lock.remainingTime, 'seconds').humanize()
            : 'EXPIRED';
          
          const lockInfo = `**Player:** <@${lock.discordId}>\n` +
                          `🔑 Challenge: \`${lock.challengeKey}\`\n` +
                          `⏱️ Expires: ${expiresIn}\n\n`;
          
          // Check character limit
          if (locksText.length + lockInfo.length > 4000) {
            const locksEmbed = new EmbedBuilder()
              .setTitle('🔒 Player Locks')
              .setColor('#FFB74D')
              .setDescription(locksText.trim());
            embeds.push(locksEmbed);
            locksText = lockInfo;
          } else {
            locksText += lockInfo;
          }
        }
        
        if (locksText.trim()) {
          const locksEmbed = new EmbedBuilder()
            .setTitle(playerLocks.length > 10 ? '🔒 Player Locks (cont.)' : '🔒 Player Locks')
            .setColor('#FFB74D')
            .setDescription(locksText.trim());
          embeds.push(locksEmbed);
        }
      }
      
      // Warning keys embed (if any exist)
      if (warningKeys.length > 0) {
        let warningText = '';
        for (const warningKey of warningKeys) {
          const ttl = await redisClient.client.ttl(warningKey);
          const expiresIn = ttl > 0 
            ? moment.duration(ttl, 'seconds').humanize()
            : 'EXPIRED';
          
          const warningInfo = `🔑 \`${warningKey}\`\n⏱️ Triggers in: ${expiresIn}\n\n`;
          
          if (warningText.length + warningInfo.length > 4000) {
            const warningEmbed = new EmbedBuilder()
              .setTitle('⚠️ Challenge Warnings')
              .setColor('#F39C12')
              .setDescription(warningText.trim());
            embeds.push(warningEmbed);
            warningText = warningInfo;
          } else {
            warningText += warningInfo;
          }
        }
        
        if (warningText.trim()) {
          const warningEmbed = new EmbedBuilder()
            .setTitle('⚠️ Challenge Warnings')
            .setColor('#F39C12')
            .setDescription(warningText.trim());
          embeds.push(warningEmbed);
        }
      }
      
      // Processing locks embed (if any exist)
      if (processingKeys.length > 0) {
        let processingText = '';
        for (const processingKey of processingKeys) {
          const ttl = await redisClient.client.ttl(processingKey);
          const expiresIn = ttl > 0 
            ? moment.duration(ttl, 'seconds').humanize()
            : 'EXPIRED';
          
          const processingInfo = `🔑 \`${processingKey}\`\n⏱️ Expires: ${expiresIn}\n\n`;
          
          if (processingText.length + processingInfo.length > 4000) {
            const processingEmbed = new EmbedBuilder()
              .setTitle('⚙️ Processing Locks')
              .setColor('#9B59B6')
              .setDescription(processingText.trim());
            embeds.push(processingEmbed);
            processingText = processingInfo;
          } else {
            processingText += processingInfo;
          }
        }
        
        if (processingText.trim()) {
          const processingEmbed = new EmbedBuilder()
            .setTitle('⚙️ Processing Locks')
            .setColor('#9B59B6')
            .setDescription(processingText.trim());
          embeds.push(processingEmbed);
        }
      }
      
      // If no data found
      if (embeds.length === 1) {
        embeds[0].addFields({
          name: '📭 No Data Found',
          value: 'No challenges, cooldowns, or locks currently stored in Redis.',
          inline: false
        });
      }
      
      // Send embeds (Discord allows up to 10 embeds per message)
      if (embeds.length <= 10) {
        await interaction.editReply({ embeds: embeds });
      } else {
        // Send in chunks of 10
        for (let i = 0; i < embeds.length; i += 10) {
          const embedChunk = embeds.slice(i, i + 10);
          if (i === 0) {
            await interaction.editReply({ embeds: embedChunk });
          } else {
            await interaction.followUp({ embeds: embedChunk, flags: MessageFlags.Ephemeral });
          }
        }
      }
      
    } catch (error) {
      console.error('Error executing redisdebug command:', error);
      await interaction.editReply({
        content: 'An error occurred while fetching Redis data. Check logs for details.',
      });
    }
  }
};