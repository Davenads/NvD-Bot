# Heroku Configuration Guide for NvD Bot

## Environment Variables Setup

When deploying the NvD Bot to Heroku, you must correctly set the following environment variables:

### Required Environment Variables

1. **BOT_TOKEN** - Your Discord bot token
2. **CLIENT_ID** - Your Discord application client ID
3. **SPREADSHEET_ID** - Your Google Spreadsheet ID
4. **GOOGLE_CLIENT_EMAIL** - Service account email from Google Cloud
5. **GOOGLE_PRIVATE_KEY** - Service account private key from Google Cloud

### Setting Up Google Authentication (CRITICAL)

⚠️ **The GOOGLE_PRIVATE_KEY requires special handling on Heroku!**

When setting GOOGLE_PRIVATE_KEY:

1. **DO NOT INCLUDE QUOTES** around the value in Heroku's config vars UI
2. **PASTE THE ENTIRE KEY** including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`
3. **KEEP THE NEWLINES** - Don't replace them with `\n` or any other character

## Step-by-Step Heroku Setup

1. **Login to Heroku Dashboard**: https://dashboard.heroku.com/

2. **Select your app** and go to the **Settings** tab

3. **Click "Reveal Config Vars"**

4. **Add the following config vars**:

   - `BOT_TOKEN` = your Discord bot token
   - `CLIENT_ID` = your Discord app client ID
   - `SPREADSHEET_ID` = your Google Sheet ID
   - `GOOGLE_CLIENT_EMAIL` = service account email from Google Cloud
   
5. **For GOOGLE_PRIVATE_KEY**:
   
   - Open your service account JSON file locally
   - Copy the entire `private_key` value (including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`)
   - In Heroku, set `GOOGLE_PRIVATE_KEY` to this value WITHOUT quotes
   - Heroku will automatically handle newlines

## Troubleshooting

If you see this error: `error:1E08010C:DECODER routines::unsupported`, it means the private key is not formatted correctly.

Try these fixes:

1. Make sure you're setting the variable without surrounding quotes in Heroku
2. Set the private key directly from your Google service account JSON without any modifications
3. Check Heroku logs for specific error messages about the key format

## Testing the Connection

After deployment, use the `/nvd-leaderboard` command to verify that the bot can successfully authenticate with Google Sheets.