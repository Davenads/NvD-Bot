#!/usr/bin/env node
// Migration script specifically for Heroku Redis environment
require('dotenv').config();

// Override local Redis config with Heroku values
// Replace these with your actual Heroku Redis credentials
process.env.REDISCLOUD_URL = 'redis://rediscloud:YOUR_HEROKU_PASSWORD@YOUR_HEROKU_HOST:YOUR_HEROKU_PORT';

// Now run the migration with Heroku's Redis
require('./migrate-existing-challenges.js');