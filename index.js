"use strict";

require('./globals');

if ( ! ['dev', 'test'].includes(process.env.MODE)) {
	const Raven = require('raven');
	Raven.config(process.env.SENTRY_URL).install();
}

const Log     = require('./lib/log');
const Chatterbox = require('./lib/chatterbox');
const chatterbox = new Chatterbox(
	process.env.MQ_URL,
	require('amqplib')
);

if ('dev' === process.env.MODE) {
	process.on('unhandledRejection', (reason, p) => {
		Log.error('* * * * * UNHANDLED REJECTION!!! * * * * *');
		Log.error(reason);
	});

	chatterbox.connect();
}
// On testing or production server, delay 10s so we don't flood Sentry with reconnect errors
else {
	Log.info('10s delay starting now.');
	setTimeout(chatterbox.connect.bind(chatterbox), 10000);
}
