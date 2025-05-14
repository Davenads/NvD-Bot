// This file adds handling for properly formatting the Google service account private key
// on Heroku, which stores environment variables differently than local development

// Manually set up a private key for testing
const FALLBACK_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
FAKE_KEY_FOR_DEVELOPMENT_ONLY_DO_NOT_USE_IN_PRODUCTION
-----END PRIVATE KEY-----`;

try {
  console.log('Environment variable inspection...');
  
  if (!process.env.GOOGLE_PRIVATE_KEY) {
    console.error('GOOGLE_PRIVATE_KEY is not set!');
    process.env.GOOGLE_PRIVATE_KEY = FALLBACK_PRIVATE_KEY;
  } else {
    // CRITICAL FIX: Handle the quotation marks that Heroku might add
    // This removes any surrounding quotes that might be causing issues
    if (process.env.GOOGLE_PRIVATE_KEY.startsWith('"') && process.env.GOOGLE_PRIVATE_KEY.endsWith('"')) {
      console.log('Removing surrounding quotes from GOOGLE_PRIVATE_KEY');
      process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.slice(1, -1);
    }
    
    // If the key doesn't contain actual newlines, replace the literal string "\n" with newlines
    if (!process.env.GOOGLE_PRIVATE_KEY.includes('\n')) {
      console.log('Replacing \\n with actual newlines in GOOGLE_PRIVATE_KEY');
      process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    }
    
    // Log the first and last few characters for debugging (without revealing the full key)
    const keyStart = process.env.GOOGLE_PRIVATE_KEY.substring(0, 30);
    const keyEnd = process.env.GOOGLE_PRIVATE_KEY.substring(process.env.GOOGLE_PRIVATE_KEY.length - 30);
    console.log(`Key begins with: ${keyStart}...`);
    console.log(`Key ends with: ...${keyEnd}`);
    
    // Check if the key is in the right format
    if (!process.env.GOOGLE_PRIVATE_KEY.includes('-----BEGIN PRIVATE KEY-----')) {
      console.error('WARNING: GOOGLE_PRIVATE_KEY does not start with -----BEGIN PRIVATE KEY-----');
    }
    
    if (!process.env.GOOGLE_PRIVATE_KEY.includes('-----END PRIVATE KEY-----')) {
      console.error('WARNING: GOOGLE_PRIVATE_KEY does not end with -----END PRIVATE KEY-----');
    }
  }
} catch (error) {
  console.error('Error processing GOOGLE_PRIVATE_KEY:', error);
}

// Log authentication components (without showing the actual key for security)
console.log('Google Auth Components:');
console.log(`- GOOGLE_CLIENT_EMAIL: ${process.env.GOOGLE_CLIENT_EMAIL ? 'Set' : 'NOT SET'}`);
console.log(`- GOOGLE_PRIVATE_KEY: ${process.env.GOOGLE_PRIVATE_KEY ? 'Set (hidden for security)' : 'NOT SET'}`);
console.log(`- SPREADSHEET_ID: ${process.env.SPREADSHEET_ID ? 'Set' : 'NOT SET'}`);

// Export key components for use in other modules
module.exports = {
  getGoogleAuth: () => {
    const { google } = require('googleapis');
    
    try {
      if (!process.env.GOOGLE_CLIENT_EMAIL) {
        throw new Error('GOOGLE_CLIENT_EMAIL environment variable is missing');
      }
      
      if (!process.env.GOOGLE_PRIVATE_KEY) {
        throw new Error('GOOGLE_PRIVATE_KEY environment variable is missing');
      }
      
      console.log('Creating Google JWT client...');
      const auth = new google.auth.JWT(
        process.env.GOOGLE_CLIENT_EMAIL,
        null,
        process.env.GOOGLE_PRIVATE_KEY,
        ['https://www.googleapis.com/auth/spreadsheets']
      );
      
      return auth;
    } catch (error) {
      console.error('Error creating Google authentication client:', error);
      throw error;
    }
  }
};