"use strict";

// Load correct environment file
require('dotenv').config({ path: 'test' === process.env.NODE_ENV ? '.env-test' : '.env' });

// Lodash
global._ = require('lodash');

// MySQL pooled connections
(async () => {
	global.DB_POOL = await require('mysql2/promise').createPool({
		host     : process.env.DB_HOST,
		user     : process.env.DB_USER,
		password : process.env.DB_PASS,
		database : process.env.DB_DB,
		multipleStatements: true,
		charset: 'utf8mb4',
	});
})();