# NvD Bot (Necromancer vs Druid) Architecture Overview

This document provides a comprehensive overview of the NvD Bot codebase structure, architecture, and key components to serve as a reference when working with Claude Code.

## Development Practices

### Git Commit Messages

When creating git commits for this project:
- Keep messages concise (under 72 characters preferred)
- Use present-tense imperative verbs (Add, Fix, Update, Remove, Implement, Refactor, etc.)
- **NEVER include author credits, attribution, or "Generated with Claude Code" notation**
- Focus on WHAT changed, not WHY
- No emojis unless explicitly requested
- No superlative or praise language ("awesome", "great", "amazing", etc.)
- Be direct and factual

**Good Examples:**
- "Update signup embed to direct users to register command"
- "Fix 400 error in form submission handler"
- "Remove emojis from match type buttons"
- "Add cooldown check before challenge creation"

**Bad Examples:**
- ❌ "Update signup embed with register command and ladder info 🤖 Generated with Claude Code" (has author notation)
- ❌ "Add awesome new feature" (superlative language)
- ❌ "Fixed the really annoying bug that was causing issues" (verbose, not concise)
- ❌ "Update: Made some changes to the code" (vague)

## Project Structure Overview

```
/NvD-Bot/
├── index.js                # Main entry point
├── deploy-commands.js      # Script to register slash commands with Discord
├── logger.js               # Logging utility 
├── redis-client.js         # Redis client for managing cooldowns
├── update-flags.js         # Script to update environment flags
├── clear-commands.js       # Script to clear registered commands
├── googleSheetTest.js      # Test script for Google Sheets API
├── commands/               # Slash command implementations
│   ├── cancelchallenge.js  # Cancel an active challenge
│   ├── challenge.js        # Issue a challenge to another player
│   ├── cooldowndebug.js    # Debug cooldown status
│   ├── currentchallenges.js # Show current active challenges
│   ├── currentvacations.js # Show players on vacation
│   ├── extendchallenge.js  # Extend duration of a challenge
│   ├── help.js             # Display help information
│   ├── leaderboard.js      # Show the ladder leaderboard
│   ├── nullchallenges.js   # Reset stale challenges
│   ├── register.js         # Register a new player to the ladder
│   ├── remove.js           # Remove a player from the ladder
│   ├── reportwin.js        # Report match results
│   ├── shuffle.js          # Randomize player order in ranks
│   ├── signup.js           # Alternative registration
│   └── titledefends.js     # Track and display title defenses
└── handlers/               # Event handlers
    └── commandHandler.js   # Command registration handler
```

## Core System Components

### 1. Discord Bot Framework

- **Entry Point (index.js)**
  - Initializes the Discord.js client
  - Sets up command collection
  - Registers event listeners for 'ready' and 'interactionCreate' events
  - Handles role-based access control
  - Dispatches commands to appropriate handlers

### 2. Command System

- **Command Registration (deploy-commands.js)**
  - Reads all command modules from /commands directory
  - Registers them with Discord API
  - Supports multiple guild deployments (test and live)

- **Command Handler (handlers/commandHandler.js)**
  - Alternative command loading system
  - Handles command execution and error handling
  - Provides command logging

- **Command Structure**
  - Each command is a separate module in /commands directory
  - Common structure:
    - `data`: SlashCommandBuilder configuration
    - `execute`: Main command logic
    - Optional: `autocomplete` handler for dynamic options

### 3. Data Storage

- **Google Sheets Integration**
  - Primary data storage using Google Sheets API
  - Sheet structure:
    - Main Tab: 'NvD Ladder' (index 0)
    - Metrics Tab: 'Metrics' (index 1)
    - Vacation Tab: 'Extended Vacation' (index 2)
  
- **Column Structure (NvD Ladder)**
  - A: Rank
  - B: Discord Username
  - C: Status
  - D: Challenge Date
  - E: Opponent Rank
  - F: Discord User ID
  - G: Notes
  - H: Cooldowns

- **Redis Database**
  - Used for managing player cooldowns
  - Key format: `nvd:cooldown:${discordId1}:${discordId2}`
  - TTL-based expiry for automatic cooldown management

### 4. External Integrations

- **Google API**
  - Authentication via JWT with service account
  - Uses environment variables for credentials:
    - GOOGLE_CLIENT_EMAIL
    - GOOGLE_PRIVATE_KEY

- **Redis**
  - Connection details from environment:
    - REDIS_HOST
    - REDIS_PORT
    - REDIS_PASSWORD

## Key Concepts

### 1. Ladder System

- Players are ranked in order
- Challenge system allows upward challenges with restrictions:
  - Top 10 players: max jump of 2 ranks
  - Regular players: max jump of 3 ranks
  - Cannot challenge downward

### 2. Challenge Workflow

1. Player issues challenge using `/nvd-challenge`
2. Both players' statuses update to "Challenge"
3. Match is played off-platform
4. Winner reports using `/nvd-reportwin`
5. Ladder positions update accordingly
6. Cooldown applied between players

### 3. Role-Based Access

- **NvD Admin**: Full admin privileges
- **NvD**: Regular player role, required for most commands
- Public registration available to anyone via `/nvd-register`

## Environment Configuration

```
BOT_TOKEN=your_discord_bot_token
CLIENT_ID=your_bot_client_id
SPREADSHEET_ID=your_google_spreadsheet_id
TEST_GUILD_ID=your_test_server_id
LIVE_GUILD_ID=your_live_server_id
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
GOOGLE_CLIENT_EMAIL=your_service_account_email
GOOGLE_PRIVATE_KEY=your_service_account_private_key
```

## File Dependencies

### Core Dependencies

- **index.js**
  - Imports: dotenv, discord.js, fs, path
  - Loads: commands/*.js

- **redis-client.js**
  - Imports: ioredis, ./logger.js
  - Exports: RedisClient singleton

- **logger.js**
  - Imports: fs, path
  - Exports: logError function

### Command Dependencies

Most command files follow this pattern:
- Imports: dotenv, discord.js, googleapis, ../logger.js
- May import: ../redis-client.js
- Exports: command module with data and execute properties

## Common Code Patterns

### 1. Sheet Operations

```javascript
// Fetching data
const result = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: `NvD Ladder!A2:H`,
});

// Updating data
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `NvD Ladder!C${rowIndex}:E${rowIndex}`,
  valueInputOption: 'USER_ENTERED',
  resource: { values: [['Challenge', challengeDate, targetRank]] }
});

// Batch operations
await sheets.spreadsheets.batchUpdate({
  spreadsheetId: SPREADSHEET_ID,
  resource: { requests: [...] }
});
```

### 2. Discord Response Patterns

```javascript
// Deferred replies for longer operations
await interaction.deferReply({ ephemeral: true });
// ...processing...
await interaction.editReply({ content: 'Operation completed!' });

// Embeds for rich formatting
const embed = new EmbedBuilder()
  .setColor('#8A2BE2')
  .setTitle('Title')
  .addFields(...)
  .setFooter(...);
await interaction.reply({ embeds: [embed] });

// Public announcements
await interaction.channel.send({ embeds: [embed] });
```

### 3. Role Checking Pattern

```javascript
const adminRole = interaction.guild.roles.cache.find(role => role.name === 'NvD Admin');
const isAdmin = interaction.member.roles.cache.has(adminRole.id);

// Or with some()
const isAdmin = interaction.member.roles.cache.some(role => role.name === 'NvD Admin');
```

### 4. Redis Patterns

```javascript
// Setting cooldown
const key = `nvd:cooldown:${player1.discordId}:${player2.discordId}`;
await redisClient.setex(key, expiryTime, cooldownData);

// Checking cooldown
const cooldownCheck = await redisClient.checkCooldown(player1, player2);
if (cooldownCheck.onCooldown) {
  // Handle cooldown
}
```

## Command Quick Reference

| Command | File | Purpose | Main Functionality |
|---------|------|---------|-------------------|
| /nvd-register | register.js | Add player to ladder | Creates new row in spreadsheet |
| /nvd-challenge | challenge.js | Issue challenge | Updates status of both players |
| /nvd-reportwin | reportwin.js | Report match result | Updates ladder positions |
| /nvd-leaderboard | leaderboard.js | View rankings | Displays paginated leaderboard |
| /nvd-currentchallenges | currentchallenges.js | List active challenges | Filters sheet for "Challenge" status |
| /nvd-currentvacations | currentvacations.js | List vacation players | Filters sheet for "Vacation" status |
| /nvd-cancelchallenge | cancelchallenge.js | Cancel challenge | Resets player statuses |
| /nvd-extendchallenge | extendchallenge.js | Extend challenge | Updates challenge deadline |
| /nvd-titledefends | titledefends.js | Track title defenses | Updates metrics spreadsheet |
| /nvd-nullchallenges | nullchallenges.js | Reset stale challenges | Clears challenges older than 3 days |
| /nvd-remove | remove.js | Remove player | Admin command to remove player |
| /nvd-shuffle | shuffle.js | Randomize ranks | Admin command to reorder ladder |
| /nvd-cooldowndebug | cooldowndebug.js | Debug cooldowns | Admin tool for Redis inspection |

## Flow Diagrams

### Registration Process
```
User initiates /nvd-register
↓
Bot checks if user already exists
↓
If new user, bot adds entry to sheet
↓
Bot updates sheet formatting
↓
Bot confirms registration to user
```

### Challenge Process
```
Player 1 initiates /nvd-challenge
↓
Bot validates rank jump rules
↓
Bot checks player availability
↓
Bot updates both players' status to "Challenge"
↓
Match is played off-platform
↓
Winner reports with /nvd-reportwin
↓
Bot updates ladder positions
↓
Bot applies cooldown between players
```

## Key Business Rules

### Challenge Rules
1. Players can only challenge upward (challenge someone ranked higher)
2. Regular players can only challenge up to 3 ranks ahead (excluding vacation players)
3. Top 10 players can only challenge up to 2 ranks ahead
4. Players outside top 10 challenging into top 10 are limited to 2 rank jumps

### Cooldown System
1. After a match, players enter a 24-hour cooldown period with each other
2. Cooldowns are tracked in Redis with TTL-based expiry
3. Cooldowns are specific to player pairs, not individual players

### Vacation Status
1. Players can be placed on vacation status by admins
2. Vacation players are skipped when calculating valid challenge targets
3. Players return from vacation with status set to "Available"

## Common Data Structures

### Player Object
```javascript
{
  rank: Number,        // Position in ladder
  discordName: String, // Discord username
  status: String,      // "Available", "Challenge", "Vacation"
  discordId: String,   // Discord user ID
  challengeDate: String, // Date of active challenge
  opponent: Number     // Opponent's rank if in challenge
}
```

### Redis Cooldown Object
```javascript
{
  player1: {
    discordId: String,
    name: String
  },
  player2: {
    discordId: String,
    name: String
  },
  startTime: Number,   // Challenge start timestamp
  expiryTime: Number   // When cooldown expires
}
```

## Effective Prompt Templates

When working on this codebase, these prompt templates can help focus Claude on specific tasks:

### Feature Implementation
```
Implement a new feature for the NvD Bot that [description of feature].

Considerations:
1. How it integrates with the existing command structure
2. What Google Sheet operations are needed
3. Appropriate error handling and user feedback
4. Required permission checks
```

### Bug Investigation
```
Help me debug an issue with the [command name] command in the NvD Bot. 

The problem is: [description of issue].

Please analyze:
1. The command's flow and data handling
2. Potential edge cases
3. Sheet operation errors
4. Discord API interactions
```

### Code Refactoring
```
Refactor the [specific component] in the NvD Bot codebase to improve [goal].

Focus on:
1. Maintaining compatibility with existing commands
2. Preserving the data structure in Google Sheets
3. Simplifying the code while preserving functionality
4. Adding appropriate error handling and logging
```

# NVD Bot Conversion Guide

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

### 11. Embed Customization
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