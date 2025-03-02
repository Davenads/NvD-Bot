- [x] Title Defends Log structure updated to start at row 1 in the Metrics tab### 11. Embed Customization
- Update embed colors, titles, and theme to match NVD ladder identity
- Remove element/spec emojis and references from all embeds
- Sample embed update:
  ```javascript
  // OLD
  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('✨ New Character Registered! ✨')
    .addFields(
      { name: '📝 **Character Name**', value: `**${characterName}**`, inline: false },
      { name: '👤 **Discord User**', value: `**${discUser}**`, inline: false },
      { name: '⚔️ **Spec & Element**', value: `${specEmojis[spec]} **${spec}** / ${elementEmojis[element]} **${element}**`, inline: false },
      { name: '📜 **Notes**', value: notes ? `**${notes}**` : 'None', inline: false }
    );
  
  // NEW
  const embed = new EmbedBuilder()
    .setColor('#8A2BE2') // Different color for NVD theme
    .setTitle('✨ New Player Registered to NVD Ladder! ✨')
    .addFields(
      { name: '👤 **Discord User**', value: `**${discUser}**`, inline: false },
      { name: '📜 **Notes**', value: notes ? `**${notes}**` : 'None', inline: false }
    );
  ```# NVD Bot Conversion Guide

This guide outlines the process for converting the SvS bot codebase to create a new NVD (Necromancer vs Druid) ladder bot.

## High Priority Changes

### 1. Environment Variables
- Create a new `.env` file with different values:
  ```
  BOT_TOKEN=your_nvd_bot_token
  CLIENT_ID=your_nvd_bot_client_id
  SPREADSHEET_ID=your_new_nvd_spreadsheet_id
  TEST_GUILD_ID=your_test_server_id
  LIVE_GUILD_ID=your_live_server_id
  REDIS_HOST=localhost
  REDIS_PORT=6379
  REDIS_PASSWORD=your_redis_password
  ```

### 2. Service Account Credentials
- Create a new service account in Google Cloud Platform
- Download and replace `config/credentials.json` with your new service account credentials
- Share the spreadsheet with your new service account email (Editor access)

### 3. Sheet References
- Create a new Google Sheet with dedicated NvD tabs:
  ```javascript
  const MAIN_SHEET = 'NvD Ladder';  // First tab (index 0)
  const METRICS_TAB = 'Metrics'; // Second tab (index 1)
  const VACATION_SHEET = 'Extended Vacation'; // Third tab (index 2)
  ```
- Update sheet IDs (numeric references):
  ```javascript
  const sheetId = 0; // NvD Ladder is now the 1st tab (0-indexed)
  const metricsSheetId = 1; // Metrics is the 2nd tab
  const vacationSheetId = 2; // Extended Vacation is the 3rd tab
  ```

### 4. Column Structure Changes
The NVD ladder has a simplified structure without spec/element columns and uses Discord username directly in column B:

| Original SvS       | New NVD           | Description                    |
|--------------------|-------------------|--------------------------------|
| A: Rank            | A: Rank           | Player rank                    |
| B: Name            | B: discUser       | Discord username (NOT char name) |
| C: Spec            | *REMOVED*         | Not applicable                 |
| D: Element         | *REMOVED*         | Not applicable                 |
| E: DiscUser        | *MOVED TO COL B*  | Now in column B                |
| F: Status          | C: Status         | Player status                  |
| G: cDate           | D: cDate          | Challenge date                 |
| H: Opp#            | E: Opp#           | Opponent rank                  |
| I: DiscordID       | F: discord userid | Discord user ID                |
| J: Notes           | G: Notes          | Player notes                   |
| K: Cooldown        | H: Cooldowns      | Cooldown info                  |

Update all column references in the code:
```javascript
// Example: update column indices
// OLD (SvS)
const name = row[1];        // Column B: Name
const discUser = row[4];    // Column E: DiscUser
const status = row[5];      // Column F: Status
const challengeDate = row[6]; // Column G: cDate
const opponent = row[7];    // Column H: Opp#
const discordId = row[8];   // Column I: DiscordID
const notes = row[9];       // Column J: Notes
const cooldown = row[10];   // Column K: Cooldown

// NEW (NVD)
const discUser = row[1];    // Column B: discUser (replaces Name & old DiscUser)
const status = row[2];      // Column C: Status
const challengeDate = row[3]; // Column D: cDate
const opponent = row[4];    // Column E: Opp#
const discordId = row[5];   // Column F: discord userid
const notes = row[6];       // Column G: Notes
const cooldown = row[7];    // Column H: Cooldowns
```

### 5. Command Names
- Add the "nvd-" prefix to all command names:
  ```javascript
  .setName('nvd-challenge')
  .setDescription('Challenge a player on the NVD leaderboard')
  ```

### 6. Redis Prefixes
- Update Redis key prefixes for isolation:
  ```javascript
  // OLD
  return `cooldown:${pair[0]}:${pair[1]}`;
  
  // NEW
  return `nvd:cooldown:${pair[0]}:${pair[1]}`;
  ```

### 7. Role Names
- Update role checks to use NVD-specific roles:
  ```javascript
  // OLD
  const managerRole = interaction.guild.roles.cache.find(
    role => role.name === 'SvS Manager'
  );
  
  // NEW
  const managerRole = interaction.guild.roles.cache.find(
    role => role.name === 'NvD Admin'
  );
  ```

### 8. Channel IDs
- Update channel ID references:
  ```javascript
  // OLD
  if (interaction.channelId !== '1330563945341390959') {
    return await interaction.reply({
      content: 'This command can only be used in the #challenges channel.',
      ephemeral: true
    });
  }
  
  // NEW
  if (interaction.channelId !== '1144011555378298910') {
    return await interaction.reply({
      content: 'This command can only be used in the #nvd-challenges channel.',
      ephemeral: true
    });
  }
  ```

### 9. Remove Spec/Element References
- Remove all spec/element references from player cards and embeds
- Update functions that handle player details:
  ```javascript
  // OLD (with spec/element)
  const playerDetails = {
    name: row[1],
    discordName: row[4],
    element: row[3],
    spec: row[2]
  };
  
  // NEW (with discord username directly)
  const playerDetails = {
    discordName: row[1] // Discord username is now in column B
  };
  ```

### 12. Title Defends Log Structure
The Metrics tab will start with the Title Defends Log at row 1 (no offset needed):

| Column A      | Column B         | Column C         |
|---------------|------------------|------------------|
| Title Defends Log | | |
| Discord User  | Discord UUID     | Title Defends    |
| tehpunch      | 265184007367...  | 16               |
| root3d2       | ...              | 7                |
| ...           | ...              | ...              |

When updating the Title Defends logic:
```javascript
// OLD (SvS)
const metricsResult = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: 'Metrics!A11:C' // Offset to row 11
});

// NEW (NvD)
const metricsResult = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: 'Metrics!A1:C' // Start from row 1
});

// Update row references accordingly
// OLD: `Metrics!A${11 + playerRowIndex}:C${11 + playerRowIndex}`
// NEW: `Metrics!A${1 + playerRowIndex}:C${1 + playerRowIndex}`
```

### 10. Add Unique Discord Username Validation
- Add validation to prevent multiple entries with the same Discord username or Discord ID:
  ```javascript
  // Example check before adding a new player
  const existingPlayer = rows.find(row => 
    row[1] === discUser || row[5] === discordId
  );
  
  if (existingPlayer) {
    return interaction.editReply({
      content: 'This Discord user already has a character on the NVD ladder.',
      ephemeral: true
    });
  }
  ```

## Command Modifications

Here's how specific commands should be modified:

### /register (-> /nvd-register)
- Remove spec and element option fields
- Update Google Sheets range reference
- Adjust row creation logic to account for simplified columns
- Add validation to ensure Discord users can only have one character on the ladder

### /challenge and /reportwin
- Remove element-specific logic and cooldowns
- Update Redis key generation to not depend on element
- Simplify embed displays to remove element indicators
- Update references to player names to use Discord username directly

### /leaderboard and similar display commands
- Redesign embeds to focus on rank, Discord username, and status without element/spec info
- Update pagination logic if needed

## Deployment Steps

1. **Copy the entire SvS bot codebase** to a new directory
2. **Implement the changes** outlined in this guide
3. **Register the new bot application** in the Discord Developer Portal
4. **Create a new Google Sheet** with the following tabs:
   - 'NvD Ladder' (1st tab, index 0) with the simplified column structure
   - 'Metrics' (2nd tab, index 1) with Title Defends Log starting at row 1
   - 'Extended Vacation' (3rd tab, index 2) with the same structure as 'NvD Ladder'
5. **Configure environment variables** with the new bot token and IDs
6. **Run the deployment script** to register the new slash commands:
   ```bash
   node deploy-commands.js
   ```
7. **Test the bot thoroughly** in a development environment
8. **Deploy to production** when ready

## Claude Code CLI Instructions

When using Claude Code CLI to convert the bot, use these instructions:

```
Convert this SvS bot codebase to an NVD (Necromancer vs Druid) bot by:

1. Renaming all slash commands to use the 'nvd-' prefix
2. Changing sheet name references to use the new spreadsheet tabs:
   - Main tab: 'NvD Ladder' (index 0)
   - Metrics tab: 'Metrics' (index 1)
   - Vacation tab: 'Extended Vacation' (index 2)
3. Updating the sheetId values:
   - Main sheetId = 0 (for 'NvD Ladder')
   - metricsSheetId = 1 (for 'Metrics')
   - vacationSheetId = 2 (for 'Extended Vacation')
4. Updating Redis key prefixes to use 'nvd:' instead of any existing prefix
5. Updating all role name checks to look for '@NvD Admin' and '@NvD' 
6. Replacing channel ID references with placeholder values
7. Removing all spec and element related code and UI elements
8. Restructuring column references to match the new scheme:
   - Column B now contains Discord username (previously in column E)
   - Character name, spec, and element columns are removed
   - Status: from F (index 5) → C (index 2)
   - cDate: from G (index 6) → D (index 3)
   - Opp#: from H (index 7) → E (index 4)
   - Discord ID: from I (index 8) → F (index 5)
   - Notes: from J (index 9) → G (index 6)
   - Cooldown: from K (index 10) → H (index 7)
9. Adding validation to prevent multiple entries with the same Discord username or ID
10. Adding comments with "CHANGED:" to highlight modified sections
```

## Final Checklist

- [ ] All commands have the "nvd-" prefix
- [x] New Google Sheet created with 'NvD Ladder', 'Metrics', and 'Extended Vacation' tabs
- [ ] Column references updated throughout code
- [ ] Spec/Element references and logic removed
- [ ] Character name field removed (Discord username now in column B)
- [ ] Redis keys properly namespaced
- [ ] Role checks updated for NVD-specific roles
- [ ] Embed styles customized for NVD ladder
- [x] Channel ID references updated (NvD challenges channel: 1144011555378298910)
- [ ] New Discord bot application registered and configured
- [ ] New Google service account created and authorized
- [ ] Commands deployed to Discord server
- [ ] Unique Discord user validation implemented