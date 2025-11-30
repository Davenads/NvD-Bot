const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-signup') // CHANGED: Added nvd- prefix
        .setDescription('Display information about how to register for the NvD ladder'), // CHANGED: Updated description

    async execute(interaction) {
        // Channel restriction: only allow in the signup channel
        if (interaction.channelId !== '1345976869211865110') {
            return await interaction.reply({
                content: 'This command can only be used in the designated signup channel.',
                ephemeral: true
            });
        }

        // Find the NvD Admin role in the guild
        const managerRole = interaction.guild.roles.cache.find(role => role.name === 'NvD Admin');
        const managerMention = managerRole ? `${managerRole}` : '@NvD Admin';

        const embed = new EmbedBuilder()
            .setColor('#8A2BE2')
            .setTitle('📝 NvD Ladder Registration Guide')
            .setDescription('Want to join the NvD ladder? Here\'s how!')
            .addFields(
                {
                    name: '📋 How to Register:',
                    value: 'Click the **Register** button below to instantly join the ladder, or use the `/nvd-register` command if you want to add optional notes.'
                },
                {
                    name: '📊 View the Ladder:',
                    value: '[View the NvD Ladder on Google Sheets](https://docs.google.com/spreadsheets/d/12Wz6kq8Im4lMm8VzgTOTgy1V4ELJfTLX-Nqyh1qxYbY/edit?usp=sharing)\n\nOr use the `/nvd-leaderboard` command to view rankings in Discord.'
                },
                {
                    name: '⚔️ Climbing the Ladder:',
                    value: 'Use `/nvd-challenge` to challenge players ranked above you (within 2-3 ranks).\n\nAfter your match, use `/nvd-reportwin` to report your victory and update the ladder!'
                },
                {
                    name: '📜 Character Limit:',
                    value: 'You may have 1 character on the NvD ladder'
                },
                {
                    name: '❓ Questions?',
                    value: `Reach out to any one of our ${managerMention}`
                }
            )
            .setFooter({
                text: 'NvD Ladder Bot',
                iconURL: interaction.client.user.displayAvatarURL()
            })
            .setTimestamp();

        // Create the register button
        const registerButton = new ButtonBuilder()
            .setCustomId('nvd-register-button')
            .setLabel('Register')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📝');

        const row = new ActionRowBuilder()
            .addComponents(registerButton);

        await interaction.reply({ embeds: [embed], components: [row] });
    },
};