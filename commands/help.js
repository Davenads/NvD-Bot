const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
module.exports = {
    data: new SlashCommandBuilder()
        .setName('nvd-help') // CHANGED: Added nvd- prefix
        .setDescription('Shows available commands for NvD ladder players'), // CHANGED: Updated description
    
    async execute(interaction) {
        const isManager = interaction.member.roles.cache.some(role => role.name === 'NvD Admin'); // CHANGED: Updated role name
        
        const duelerEmbed = new EmbedBuilder()
            .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
            .setTitle('📖 NvD Ladder Commands') // CHANGED: Updated title
            .setDescription('Available commands for all NvD players') // CHANGED: Updated description
            .addFields(
                {
                    name: '/nvd-challenge [challenger_rank] [target_rank]', // CHANGED: Updated command name
                    value: 'Challenge another player on the ladder\n• Top 10 players: up to 2 ranks ahead\n• Other players: up to 3 ranks ahead'
                },
                {
                    name: '/nvd-reportwin [winner_rank] [loser_rank]', // CHANGED: Updated command name
                    value: 'Report the outcome of a challenge\n• Must be used by either participant'
                },
                {
                    name: '/nvd-currentchallenges', // CHANGED: Updated command name
                    value: 'View all active challenges\n• Shows challenger, opponent, and deadline'
                },
                {
                    name: '/nvd-currentvacations', // CHANGED: Updated command name
                    value: 'See which players are on vacation\n• Shows vacation start dates and info'
                },
                {
                    name: '/nvd-leaderboard', // CHANGED: Updated command name
                    value: 'View current NvD ladder rankings\n• Shows players and status'
                },
                {
                    name: '/nvd-titledefends', // CHANGED: Updated command name
                    value: 'View the title defense leaderboard\n• Shows who has successfully defended the #1 rank'
                }
            )
            .setFooter({ 
                text: 'Note: @NvD role required for most commands', // CHANGED: Updated role name
                iconURL: interaction.client.user.displayAvatarURL()
            })
            .setTimestamp();
        const managerEmbed = new EmbedBuilder()
            .setColor('#8A2BE2') // CHANGED: Updated color for NvD theme
            .setTitle('🛡️ NvD Admin Commands') // CHANGED: Updated title
            .setDescription('Additional commands available for NvD Admins') // CHANGED: Updated description
            .addFields(
                {
                    name: '/nvd-register [disc_user] [optional: notes]', // CHANGED: Updated command name and parameters
                    value: 'Register a new player to the ladder\n• Automatically assigns next available rank'
                },
                {
                    name: '/nvd-remove [rank]', // CHANGED: Updated command name
                    value: 'Remove a player from the ladder\n• Moves them to Extended Vacation tab\n• Updates all rankings automatically'
                },
                {
                    name: '/nvd-cancelchallenge [player]', // CHANGED: Updated command name
                    value: 'Cancel an active challenge\n• Resets both players to Available status'
                },
                {
                    name: '/nvd-extendchallenge [player]', // CHANGED: Updated command name
                    value: 'Extend a challenge deadline by 2 days\n• Updates both players\' challenge dates'
                },
                {
                    name: '/nvd-nullchallenges', // CHANGED: Updated command name
                    value: 'Automatically voids all challenges older than 3 days\n• Resets affected players to Available status'
                },
                {
                    name: '/nvd-cooldowndebug [action] [options]', // CHANGED: Updated command name
                    value: 'Debug cooldowns between players\n• List, check, or clear cooldowns'
                }
            )
            .setFooter({ 
                text: 'These commands require the @NvD Admin role', // CHANGED: Updated role name
                iconURL: interaction.client.user.displayAvatarURL()
            })
            .setTimestamp();
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('toggle_commands')
                    .setLabel('Toggle Admin Commands') // CHANGED: Updated button label
                    .setStyle(ButtonStyle.Primary)
            );
        let components = isManager ? [row] : [];
        const initialMessage = await interaction.reply({
            embeds: [duelerEmbed],
            components,
            flags: MessageFlags.Ephemeral
        });
        if (isManager) {
            const collector = initialMessage.createMessageComponentCollector({
                time: 60000 // Button will work for 1 minute
            });
            let showingManagerCommands = false;
            collector.on('collect', async i => {
                if (i.customId === 'toggle_commands') {
                    showingManagerCommands = !showingManagerCommands;
                    await i.update({
                        embeds: [showingManagerCommands ? managerEmbed : duelerEmbed],
                        components: [row]
                    });
                }
            });
            collector.on('end', () => {
                // Remove the button after timeout
                initialMessage.edit({
                    embeds: [showingManagerCommands ? managerEmbed : duelerEmbed],
                    components: []
                }).catch(console.error);
            });
        }
    },
};