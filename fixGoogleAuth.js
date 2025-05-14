// This file adds handling for properly formatting the Google service account private key
// on Heroku, which stores environment variables differently than local development

if (process.env.GOOGLE_PRIVATE_KEY) {
  // If the key already contains actual newlines, don't modify it
  if (!process.env.GOOGLE_PRIVATE_KEY.includes('\n')) {
    console.log('Fixing Google Private Key format for Heroku...');
    // Replace the literal string "\n" with actual newlines
    process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
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
    return new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      null,
      process.env.GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
  }
};