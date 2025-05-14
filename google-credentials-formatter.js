/**
 * Google Credentials Formatter
 * 
 * This script helps format a Google service account key file for use with Heroku.
 * Run this locally to convert your JSON key file to the format needed for Heroku.
 * 
 * Usage:
 * 1. node google-credentials-formatter.js path/to/your-credentials.json
 * 2. Copy the output and set it in Heroku
 */

const fs = require('fs');

if (process.argv.length < 3) {
  console.log('Usage: node google-credentials-formatter.js path/to/credentials.json');
  process.exit(1);
}

const credentialsPath = process.argv[2];

try {
  // Read and parse the credentials file
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  
  // Extract the values needed for environment variables
  const clientEmail = credentials.client_email;
  const privateKey = credentials.private_key;
  
  // Format for Heroku
  console.log('\n=== COPY THESE VALUES TO HEROKU CONFIG VARS ===\n');
  console.log('GOOGLE_CLIENT_EMAIL:');
  console.log(clientEmail);
  console.log('\nGOOGLE_PRIVATE_KEY:');
  console.log(privateKey);
  
  console.log('\n=== INSTRUCTIONS ===');
  console.log('1. Go to your Heroku dashboard');
  console.log('2. Navigate to your app -> Settings -> Config Vars');
  console.log('3. Add these environment variables with the values above');
  console.log('4. You don\'t need to escape special characters - paste the values exactly as shown');
  
} catch (error) {
  console.error('Error processing credentials file:', error);
  process.exit(1);
}