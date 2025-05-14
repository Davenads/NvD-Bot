// This file adds handling for properly formatting the Google service account private key
// on Heroku, which stores environment variables differently than local development

if (process.env.GOOGLE_PRIVATE_KEY) {
  console.log('Fixing Google Private Key format for Heroku...');
  
  // Check if the key is base64 encoded (Heroku sometimes does this)
  if (process.env.GOOGLE_PRIVATE_KEY.match(/^[A-Za-z0-9+/=]+$/)) {
    try {
      const decoded = Buffer.from(process.env.GOOGLE_PRIVATE_KEY, 'base64').toString('utf8');
      process.env.GOOGLE_PRIVATE_KEY = decoded;
      console.log('Successfully decoded base64 private key');
    } catch (e) {
      console.error('Failed to decode base64 private key:', e);
    }
  }
  
  // If the key doesn't contain actual newlines, replace the literal string "\n" with newlines
  if (!process.env.GOOGLE_PRIVATE_KEY.includes('\n')) {
    process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  
  // Verify the key format (should start with -----BEGIN PRIVATE KEY-----)
  if (!process.env.GOOGLE_PRIVATE_KEY.includes('-----BEGIN PRIVATE KEY-----')) {
    console.error('WARNING: GOOGLE_PRIVATE_KEY does not appear to be in the correct format');
  }
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