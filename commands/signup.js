const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-signup') // CHANGED: Added nvd- prefix
        .setDescription('Display information about how to register for the NvD ladder'), // CHANGED: Updated description

    async execute(interaction) {
        // CHANGED: Find the NvD Admin role in the guild
        const managerRole = interaction.guild.roles.cache.find(role => role.name === 'NvD Admin');
        const managerMention = managerRole ? `${managerRole}` : '@NvD Admin';

        const embed = new EmbedBuilder()
            .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
            .setTitle('📝 NvD Ladder Registration Guide') // CHANGED: Updated title
            .setDescription('Want to join the NvD ladder? Here\'s how!') // CHANGED: Updated description
            .addFields(
                {
                    name: '📋 How to Register:',
                    value: `In the **#nvd-signup** channel, simply post the following information:
- **Your Discord username**
- **Notes** (Optional)`
                },
                {
                    name: '📊 Character Limit',
                    value: 'You may have 1 character on the NvD ladder'
                },
                {
                    name: '❓ Questions?',
                    value: `Reach out to any one of our ${managerMention}`
                }
            )
            .setFooter({ 
                text: 'NvD Ladder Bot', // CHANGED: Updated footer
                iconURL: interaction.client.user.displayAvatarURL()
            })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    },
};