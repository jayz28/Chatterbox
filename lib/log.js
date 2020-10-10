"use strict";

// If we're testing, don't send out any logging
if ('test' === process.env.NODE_ENV) {
	module.exports = require('bunyan-blackhole')();

// If running, send out default logs
} else {
	module.exports = require('bunyan').createLogger({ name: 'chatterbox', level: process.env.LOG_LEVEL });
}