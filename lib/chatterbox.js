"use strict";

const { get }       = require('lodash');
const Slack         = require('slacksimple').Slack;
const Raven         = require('raven');
const Log           = require('./log');
const SlashListener = require('./slash_listener');
const SlackListener = require('./slack_listener');

class Chatterbox {
	/**
	 * Initialize bot.
	 *
	 * @param {string} mqUrl - The URL for connecting to the MQ.
	 * @param {Amqplib} amqp - Injected amqp library.
	 */
	constructor(mqUrl, amqp)
	{
		this.slackClients = {};
		this.mqUrl = mqUrl;
		this.amqp = amqp;

		this.slashListener = new SlashListener(this, process.env.QUEUE_SUFFIX);
		this.slackListener = new SlackListener(this, process.env.QUEUE_SUFFIX);

		// Share listeners
		this.slashListener.slackListener = this.slackListener;
		this.slackListener.slashListener = this.slashListener;
	}

	/**
	 * Report an error to Sentry, but not in development mode.
	 *
	 * @param {Error} error - The error to report.
	 * @param {object} info - Command parameters.
	 */
	reportError(error, info)
	{
		const error_data = get(error, 'data', {});
		if ('dev' === process.env.MODE) {
			Log.info('Reporting error...');
			Log.info(info, 'Command information');
			Log.info(error_data, 'Error data');
		}
		else {
			Raven.captureException(error, {
				extra: {
					info,
					error_data,
				}
			});
		}
	}

	/**
	 * Connect to Slack and get things started.
	 */
	async connect()
	{
		try {
			Log.info('Connecting to MQ...');
			this.mqConnection = await this.amqp.connect(this.mqUrl);
			Log.info('Connected to MQ!');

			await this.slashListener.connect();
			await this.slackListener.connect();
		}
		catch (error) {
			Log.error(error);
			this.reportError(error);
		}
	}

	/**
	 * Get the slack connection to the requested team.
	 *
	 * @param {string} teamId - The ID of the team to connect to.
	 *
	 * @return {Slack}
	 */
	async getSlack(teamId)
	{
		if (_.isUndefined(this.slackClients[teamId])) {
			const [botToken, appToken, botId, autoStart] = await this.getTeamInfo(teamId);

			this.slackClients[teamId] = new Slack(botToken, appToken, botId, 'chatterbox');
			await this.slackClients[teamId].connect();

			this.slackClients[teamId].autoStart = autoStart;
		}

		return this.slackClients[teamId];
	}

	/**
	 * Get the bot & app tokens for the requested team.
	 *
	 * @param {string} teamId - The ID of the team to get tokens for.
	 *
	 * @return {array} [botToken, appToken]
	 */
	async getTeamInfo(teamId)
	{
		const query = 'SELECT * FROM teams WHERE teamid = ?';
		const params = [teamId];

		Log.info(`Loading team '${teamId}'.`);

		const connection = await DB_POOL.getConnection();
		const [rows, ] = await connection.query(query, params);
		connection.release();

		return [rows[0].bot_token, rows[0].app_token, rows[0].bot_id, rows[0].autostart];
	}
}

module.exports = Chatterbox;